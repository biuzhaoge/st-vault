import type { UnitSeenEvidence } from '@st-vault/api-schema';
import type {
  MediaSelection,
  MediaSelectionMode,
  MediaSelectionOptions,
  MediaSelectionPatch,
  MediaSelectionResult,
  FavoriteChange,
} from '@st-vault/api-schema';
import type { FavoriteSelectionChange } from './favorite-commands.js';
import type {
  BackgroundTask,
  MediaDeletionJob,
  MediaDeletionQueue,
  MediaDeletionTarget,
} from '@st-vault/api-schema';
import type { PendingDeletion } from './deletion-store.js';
import { randomUUID } from 'node:crypto';
import { RecordingUnitIndex } from './unit-index.js';
import { lstat, mkdir, realpath, rename } from 'node:fs/promises';
import path from 'node:path';
import { Metadata } from './metadata.js';
import { orphanCandidates } from './orphan-candidates.js';
import { TaskPool, TaskWakeup } from './task-pool.js';
import type {
  CoverageResponse,
  EventMeta,
  EventsResponse,
  GapPolicy,
  PublicStatus,
  RunHistoryResponse,
  Segment,
  SourceCheckpoint,
  StatusHistoryResponse,
  Subject,
  TimelineResponse,
} from '@st-vault/api-schema';
import type {
  FavoriteRemovalResult,
  MediaDeletePlan,
  MediaTimeRange,
  PersonalTimeline,
  SnapshotPagesResponse,
  SnapshotItem,
} from '@st-vault/api-schema';
import type { ArchivePort, CommitInput, MediaChange, MediaObject, SubjectInput } from '../ports.js';
import { ARCHIVE_MEDIA_BATCH_LIMIT } from '../ports.js';
import { MAX_SNAPSHOT_SELECTION, MAX_SNAPSHOT_PAGE_SIZE } from '@st-vault/api-schema';
import {
  archiveWindows,
  EMPTY_DAY_SETTLE_MS,
  MEDIA_WINDOW_MS,
  WORKBENCH_WINDOW_MS,
} from './calendar-window.js';

import { MediaObjectStore, fileErrorCode, syncDirectory } from './object-store.js';
import {
  UUID,
  MAX_BYTES,
  subjectId,
  type ArchiveFaultPoint,
  type JournalRecord,
  type ObjectRecord,
} from './records.js';

export type { ArchiveFaultPoint, JournalRecord, ObjectRecord } from './records.js';
export interface ArchiveOptions {
  root: string;
  mediaRoot?: string;
  backgroundConcurrency?: number;
  gcConcurrency?: number;
  hashConcurrency?: number;
  /** Deterministic failure injection, for isolated test archives only. */
  fault?: (point: ArchiveFaultPoint) => void | Promise<void>;
}
export interface ArchiveHandle extends ArchivePort {
  /** Bounded integrity maintenance. Pass nextCursor to continue a later batch. */
  scrub(options?: {
    limit?: number;
    delayMs?: number;
    cursor?: string;
  }): Promise<{ checked: number; nextCursor: string | null }>;
  recoveryStats(): {
    cleanStartup: boolean;
    journalRecordsRead: number;
    journalRecordsApplied: number;
    journalBytesRead: number;
    objectsVerified: number;
  };
}
function failure(code: string): never {
  throw new Error(code);
}
function inputSubject(s: SubjectInput): void {
  if (
    subjectId(s.id) !== s.providerId ||
    typeof s.handle !== 'string' ||
    !s.handle.trim() ||
    s.handle.length > 200
  )
    failure('INVALID_SUBJECT');
  if (
    [s.previewSourceUrl, s.avatarSourceUrl].some(
      (value) => value !== undefined && (typeof value !== 'string' || value.length > 2048),
    )
  )
    failure('INVALID_SUBJECT');
}
function windowRange(from: number, to: number, bounded = true): void {
  if (
    !Number.isSafeInteger(from) ||
    from < 0 ||
    !Number.isSafeInteger(to) ||
    to <= from ||
    (bounded && to - from > MEDIA_WINDOW_MS)
  )
    failure('INVALID_TIME_WINDOW');
}
/** Files, journals and the database belong exclusively to this independent data root. */
export async function openArchive(options: ArchiveOptions): Promise<ArchiveHandle> {
  if (!options.root.trim()) failure('INVALID_ARCHIVE_ROOT');
  await mkdir(path.resolve(options.root), { recursive: true });
  const root = await realpath(path.resolve(options.root));
  // An upgrade must never silently create an empty library beside legacy data.
  try {
    await lstat(path.join(root, 'metadata.sqlite'));
    failure('LIBRARY_MIGRATION_REQUIRED');
  } catch (error) {
    if (fileErrorCode(error) !== 'ENOENT') throw error;
  }
  const configuredMedia = path.resolve(options.mediaRoot ?? path.join(root, 'media'));
  await mkdir(configuredMedia, { recursive: true });
  if ((await lstat(configuredMedia)).isSymbolicLink()) failure('UNSAFE_ARCHIVE_PATH');
  const mediaRoot = await realpath(configuredMedia);
  if (mediaRoot === root) failure('INVALID_MEDIA_ROOT');
  const metadata = new Metadata(root, undefined, mediaRoot);
  const archive = new Archive(mediaRoot, metadata, options);
  try {
    await archive.recover();
    return archive;
  } catch (error) {
    await metadata.call('close', { clean: false }).catch(() => undefined);
    await metadata.terminate();
    throw error;
  }
}

interface DeleteFilter {
  from?: number;
  to?: number;
  unlocated?: boolean;
  cutoff?: number;
  retentionDays?: number;
  segmentIds?: string[];
  personalRevision?: number;
}

interface RemovalResult {
  deletedSegments: number;
  reclaimedBytes: number;
  retentionChanged?: true;
}

interface DeferredRemovalResult extends RemovalResult {
  gcObjectIds: string[];
  tombstoneMs: number;
  reclaimMs: number;
  unlinkMs: number;
  directorySyncMs: number;
}

class Archive implements ArchiveHandle {
  withBackgroundReads<T>(action: () => Promise<T>): Promise<T> {
    return this.db.withBackgroundReads(action);
  }
  private favoriteWork: Promise<void> | undefined;
  private directoryRead: Promise<Subject[]> | undefined;
  private deletionRead: Promise<MediaDeletionQueue> | undefined;
  private favoriteError: Error | undefined;
  private deletionWork: Promise<void> | undefined;
  private readonly deletionCompleteListeners = new Set<() => void>();
  private readonly deletionWakeup = new TaskWakeup();
  private orphanWork: Promise<void> | undefined;
  private readonly unitIndex: RecordingUnitIndex;
  private orphanTotal = 0;
  private orphanDone = 0;
  private orphanStartedAt: number | null = null;
  private orphanFinishedAt: number | null = null;
  backgroundTasks(): Promise<BackgroundTask[]> {
    return this.run(async () => {
      const index = await this.unitIndex.status();
      const library = await this.db.read<{
        checkpointing: boolean;
        checkpointFailed: boolean;
        requiresRecovery: boolean;
      }>('storageStatus');
      const favorites = await this.db.read<{ pending: number; processed: number; total: number }>(
        'favoriteMaterializationStatus',
      );
      return [
        {
          id: 'favorite-materialization',
          group: 'processing',
          state: this.favoriteError
            ? 'retrying'
            : this.favoriteWork
              ? 'running'
              : favorites.pending
                ? 'waiting'
                : 'idle',
          pending: favorites.pending,
          processed: favorites.processed,
          total: favorites.total,
          error: this.favoriteError ? 'favorite_materialization_failed' : null,
        },
        {
          id: 'library-checkpoint',
          group: 'protection',
          state: library.requiresRecovery
            ? 'error'
            : library.checkpointing
              ? 'running'
              : library.checkpointFailed
                ? 'retrying'
                : 'idle',
          error: library.requiresRecovery
            ? 'library_write_recovery_required'
            : library.checkpointFailed
              ? 'library_checkpoint_failed'
              : null,
        },
        index,
        {
          id: 'orphan-sweep',
          group: 'processing',
          state: this.orphanError
            ? 'retrying'
            : this.orphanWork
              ? 'running'
              : this.orphanSubjects.length
                ? 'waiting'
                : 'idle',
          processed: this.orphanDone,
          total: this.orphanTotal,
          detail: 'subject-scan',
          lastRunAtMs: this.orphanStartedAt,
          lastSuccessAtMs: this.orphanFinishedAt,
          error: this.orphanError ? 'orphan_cleanup_failed' : null,
        },
      ];
    });
  }
  private orphanSubjects: string[] = [];
  private orphanError: Error | undefined;
  private closing = false;
  private poisoned = false;
  private closed: Promise<void> | null = null;
  private readonly operations = new Set<Promise<unknown>>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly gcWork = new Map<string, Promise<number>>();
  private readonly gcRetries = new Map<string, { at: number; attempt: number }>();
  private gcRetryTimer: NodeJS.Timeout | undefined;
  private gcRetryRunning = false;
  private readonly gcIo: TaskPool;
  private readonly backgroundPool: TaskPool;
  private readonly files: MediaObjectStore;
  private readonly backgroundConcurrency: number;
  private readonly mediaListeners = new Set<(change: MediaChange) => void>();
  subscribeMedia(listener: (change: MediaChange) => void): () => void {
    this.mediaListeners.add(listener);
    return () => this.mediaListeners.delete(listener);
  }
  private notifyMedia(change: MediaChange): void {
    for (const listener of this.mediaListeners) {
      try {
        listener(change);
      } catch (error) {
        // Derivative failures must be observable without changing commit success.
        console.warn(
          JSON.stringify({
            event: 'archive_media_listener_failed',
            subjectId: change.kind === 'commit' ? change.segment.subjectId : change.subjectId,
            kind: change.kind,
            error: error instanceof Error ? error.name : 'unknown',
          }),
        );
      }
    }
  }
  private readonly recovery = {
    cleanStartup: false,
    journalRecordsRead: 0,
    journalRecordsApplied: 0,
    journalBytesRead: 0,
    objectsVerified: 0,
  };
  constructor(
    root: string,
    private readonly db: Metadata,
    private readonly options: ArchiveOptions,
  ) {
    this.unitIndex = new RecordingUnitIndex(db);
    this.backgroundConcurrency = options.backgroundConcurrency ?? 1;
    if (
      !Number.isSafeInteger(this.backgroundConcurrency) ||
      this.backgroundConcurrency < 1 ||
      this.backgroundConcurrency > 32
    )
      failure('INVALID_ARCHIVE_CONCURRENCY');
    this.gcIo = new TaskPool(options.gcConcurrency ?? 1);
    this.backgroundPool = new TaskPool(this.backgroundConcurrency);
    this.files = new MediaObjectStore(root, options.hashConcurrency ?? 1, (point) =>
      this.fault?.(point),
    );
  }
  private get fault(): ArchiveOptions['fault'] {
    return this.options.fault;
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('ARCHIVE_CLOSED'));
    if (this.poisoned) return Promise.reject(new Error('ARCHIVE_REQUIRES_RECOVERY'));
    const operation = Promise.resolve().then(action);
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation),
    );
    return operation;
  }
  private serial<T>(id: string, action: () => Promise<T>, accepted = false): Promise<T> {
    const schedule = async (): Promise<T> => {
      const previous = this.queues.get(id) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          if (this.poisoned) failure('ARCHIVE_REQUIRES_RECOVERY');
          return await action();
        });
      this.queues.set(id, next);
      try {
        return await next;
      } finally {
        if (this.queues.get(id) === next) this.queues.delete(id);
      }
    };
    return accepted ? schedule() : this.run(schedule);
  }
  async recover(): Promise<void> {
    const started = performance.now();
    const stage = (name: string): void =>
      console.info(
        JSON.stringify({
          event: 'archive_startup_stage',
          stage: name,
          elapsedMs: Math.round(performance.now() - started),
          ...this.recovery,
        }),
      );
    // Wait for the cross-process instance lock before touching archive files.
    const clean = await this.db.call<boolean>('beginSession');
    this.recovery.cleanStartup = clean;
    stage('metadata');
    const subjects = await this.files.discoverSubjects();
    const storage = await this.db.read<{
      replayed: number;
      recordsRead: number;
      bytesRead: number;
    }>('storageStatus');
    this.recovery.journalRecordsApplied = storage.replayed;
    this.recovery.journalRecordsRead = storage.recordsRead;
    this.recovery.journalBytesRead = storage.bytesRead;
    stage('journals');
    // Only newly recovered objects require startup verification. Previously
    // committed objects are hash-checked on first read and by bounded scrub.
    for (;;) {
      const objects = await this.db.call<ObjectRecord[]>('unverifiedObjects');
      if (!objects.length) break;
      for (const object of objects) {
        await this.files.verify(object);
        this.recovery.objectsVerified++;
        await this.db.call('verified', { id: object.id });
      }
    }
    for (const id of subjects) {
      await this.collect(id);
    }
    stage('recovered_objects');
    this.unitIndex.start();
    if (
      !clean ||
      (await this.db.call('settingGet', { key: 'archive.orphan-scan-pending' })) === '1'
    ) {
      await this.db.call('settingSet', { key: 'archive.orphan-scan-pending', value: '1' });
      this.orphanSubjects = [...subjects];
      this.orphanTotal = this.orphanSubjects.length;
      this.startOrphanSweep();
    }
  }
  private startOrphanSweep(): void {
    if (this.orphanWork || this.closing || this.poisoned) return;
    this.orphanError = undefined;
    this.orphanStartedAt = Date.now();
    this.orphanWork = (async () => {
      while (this.orphanSubjects.length && !this.closing && !this.poisoned) {
        const id = this.orphanSubjects[0];
        if (!(await this.isolateOrphans(id))) return;
        this.orphanSubjects.shift();
        this.orphanDone++;
      }
      if (!this.closing && !this.poisoned) {
        await this.db.call('settingSet', { key: 'archive.orphan-scan-pending', value: '0' });
        console.info(JSON.stringify({ event: 'archive_orphan_sweep_complete' }));
        this.orphanFinishedAt = Date.now();
      }
    })()
      .catch((error) => {
        this.orphanError =
          error instanceof Error ? error : new Error('ORPHAN_SWEEP_FAILED', { cause: error });
        console.warn('archive_orphan_sweep_failed', error);
      })
      .finally(() => {
        this.orphanWork = undefined;
      });
  }
  private async isolateOrphans(id: string): Promise<boolean> {
    const dir = await this.files.directory(id);
    const orphaned = path.join(dir, '.orphaned');
    const isolate = async (source: string, name: string): Promise<void> => {
      await mkdir(orphaned, { recursive: true });
      if ((await lstat(orphaned)).isSymbolicLink()) failure('UNSAFE_ARCHIVE_PATH');
      await rename(source, path.join(orphaned, `${randomUUID()}-${name}`));
      await syncDirectory(orphaned);
    };
    for await (const batch of orphanCandidates(dir)) {
      if (this.closing || this.poisoned) return false;
      await this.fault?.('before-orphan-batch');
      if (this.closing || this.poisoned) return false;
      // Commits rename before journal/index commit. Hold their subject queue
      // while deciding whether a candidate is unowned, including staging files.
      await this.serial(
        id,
        async () => {
          const known = new Set(
            await this.db.call<string[]>('knownObjects', {
              subjectId: id,
              ids: batch.flatMap((item) => (item.objectId ? [item.objectId] : [])),
            }),
          );
          for (const item of batch) {
            if (item.objectId && known.has(item.objectId)) continue;
            try {
              const info = await lstat(item.filename);
              if (!info.isFile() || info.isSymbolicLink()) failure('UNSAFE_ARCHIVE_PATH');
              await isolate(item.filename, item.name);
            } catch (error) {
              // A completed commit or GC may have consumed a candidate while it
              // waited for the subject queue. Absence is already reconciled.
              if (fileErrorCode(error) !== 'ENOENT') throw error;
            }
          }
        },
        true,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    return true;
  }
  private collect(id: string): Promise<number> {
    const existing = this.gcWork.get(id);
    // The first collector accounts for bytes; joiners must not count them twice.
    if (existing) return existing.then(() => 0);
    const work = this.collectFiles(id)
      .then((reclaimed) => {
        this.gcRetries.delete(id);
        return reclaimed;
      })
      .catch((error: unknown) => {
        const attempt = Math.min(4, (this.gcRetries.get(id)?.attempt ?? -1) + 1);
        const delay = Math.min(300_000, 30_000 * 2 ** attempt);
        this.gcRetries.set(id, { at: Date.now() + delay, attempt });
        throw error;
      })
      .finally(() => {
        this.gcWork.delete(id);
        this.scheduleGcRetry();
      });
    this.gcWork.set(id, work);
    return work;
  }

  private scheduleGcRetry(): void {
    clearTimeout(this.gcRetryTimer);
    this.gcRetryTimer = undefined;
    if (this.closing || this.poisoned || this.gcRetryRunning) return;
    let subject: string | undefined;
    let at = Infinity;
    for (const [id, retry] of this.gcRetries) {
      if (retry.at >= at || this.gcWork.has(id)) continue;
      subject = id;
      at = retry.at;
    }
    if (!subject) return;
    const id = subject;
    this.gcRetryTimer = setTimeout(
      () => {
        this.gcRetryTimer = undefined;
        if (this.closing || this.poisoned) return;
        this.gcRetryRunning = true;
        // The normal collector owns both the durable checkpoint and close wait.
        void this.withBackgroundReads(() => this.collect(id))
          .catch((error: unknown) => console.warn('archive_gc_retry_failed', id, error))
          .finally(() => {
            this.gcRetryRunning = false;
            this.scheduleGcRetry();
          });
      },
      Math.max(0, at - Date.now()),
    ).unref();
  }

  private async collectFiles(id: string): Promise<number> {
    let reclaimed = 0;
    for (;;) {
      const objects = await this.db.call<ObjectRecord[]>('pendingGc', { id });
      if (!objects.length) return reclaimed;
      const { reclaimedBytes } = await this.files.reclaimBatch(objects, this.gcIo);
      reclaimed += reclaimedBytes;
      await this.db.call('gcDone', { segmentIds: objects.map((object) => object.id) });
      if (this.closing) return reclaimed;
      // Release CPU/I/O scheduling between bounded batches, never a subject commit lock.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  upsertSubjects(subjects: SubjectInput[], options?: { syncAccount?: boolean }): Promise<void> {
    return this.run(async () => {
      if (subjects.length > 10000) failure('SUBJECT_BATCH_TOO_LARGE');
      subjects.forEach(inputSubject);
      await this.db.call('upsert', { subjects, syncAccount: options?.syncAccount === true });
    });
  }
  prepareAccountSubjects(subjects: SubjectInput[], generation: string): Promise<void> {
    if (!UUID.test(generation)) failure('INVALID_ACCOUNT_ACTIVATION');
    if (subjects.length > 10000) failure('SUBJECT_BATCH_TOO_LARGE');
    subjects.forEach(inputSubject);
    return this.run(() => this.db.call('prepareAccountSubjects', { subjects, generation }));
  }
  activateAccountSubjects(generation: string): Promise<void> {
    if (!UUID.test(generation)) failure('INVALID_ACCOUNT_ACTIVATION');
    return this.run(() => this.db.call('activateAccountSubjects', { generation }));
  }
  accountActivation(): Promise<string | null> {
    return this.run(() => this.db.read('accountActivation'));
  }
  discardAccountPreparation(generation: string): Promise<void> {
    if (!UUID.test(generation)) failure('INVALID_ACCOUNT_ACTIVATION');
    return this.run(() => this.db.call('discardAccountPreparation', { generation }));
  }
  listSubjects(options?: { activity?: false }): Promise<Subject[]> {
    return this.run(async () => {
      if (options?.activity === false) return this.db.call<Subject[]>('list', options);
      this.directoryRead ??= this.db.call<Subject[]>('list').finally(() => {
        this.directoryRead = undefined;
      });
      return this.directoryRead;
    });
  }
  setGlobalRecording(enabled: boolean): Promise<string[]> {
    if (typeof enabled !== 'boolean') failure('INVALID_POLICY');
    return this.run(() => this.db.call('globalRecording', { enabled }));
  }
  getSubject(id: string, options?: { activity?: false }): Promise<Subject | null> {
    subjectId(id);
    return this.run(() => this.db.call('findSubject', { id, ...options }));
  }
  subjectPreview(id: string): Promise<string | null> {
    subjectId(id);
    return this.run(() => this.db.call('subjectPreview', { id }));
  }
  setPolicy(
    id: string,
    patch: { monitorEnabled?: boolean; autoRecord?: boolean },
  ): Promise<Subject> {
    return this.run(async () => {
      subjectId(id);
      if (
        (patch.monitorEnabled !== undefined && typeof patch.monitorEnabled !== 'boolean') ||
        (patch.autoRecord !== undefined && typeof patch.autoRecord !== 'boolean')
      )
        failure('INVALID_POLICY');
      return await this.db.call('policy', { id, patch });
    });
  }
  setPolicies(
    ids: string[],
    patch: { monitorEnabled?: boolean; autoRecord?: boolean },
  ): Promise<number> {
    return this.run(async () => {
      if (ids.length > 1000 || !ids.length) failure('INVALID_POLICY_BATCH');
      ids.forEach(subjectId);
      if (
        !Object.keys(patch).length ||
        (patch.monitorEnabled !== undefined && typeof patch.monitorEnabled !== 'boolean') ||
        (patch.autoRecord !== undefined && typeof patch.autoRecord !== 'boolean')
      )
        failure('INVALID_POLICY');
      return await this.db.call('policies', { ids: [...new Set(ids)], patch });
    });
  }
  setObservation(
    id: string,
    status: PublicStatus,
    observedAtMs: number,
    leaseMs = 15000,
    transitionAtMs = observedAtMs,
  ): Promise<void> {
    return this.run(async () => {
      subjectId(id);
      if (
        !['PUBLIC', 'PRIVATE', 'OFFLINE', 'UNKNOWN'].includes(status) ||
        !Number.isSafeInteger(observedAtMs) ||
        observedAtMs < 0 ||
        !Number.isSafeInteger(transitionAtMs) ||
        transitionAtMs < 0 ||
        transitionAtMs > observedAtMs
      )
        failure('INVALID_OBSERVATION');
      if (
        !Number.isSafeInteger(leaseMs) ||
        leaseMs < 1000 ||
        leaseMs > 600000 ||
        !Number.isSafeInteger(observedAtMs + leaseMs)
      )
        failure('INVALID_OBSERVATION');
      await this.db.call('observation', {
        id,
        status,
        at: observedAtMs,
        leaseMs,
        transitionAt: transitionAtMs,
      });
    });
  }
  statusHistory(
    id: string,
    from: number,
    to: number,
    buckets = 240,
    signal?: AbortSignal,
  ): Promise<StatusHistoryResponse> {
    return this.run(async () => {
      subjectId(id);
      windowRange(from, to);
      if (!Number.isSafeInteger(buckets) || buckets < 1 || buckets > 720)
        failure('INVALID_STATUS_HISTORY_BUCKETS');
      return await this.db.read(
        'statusHistory',
        { id, from, to, buckets: Math.min(buckets, to - from) },
        signal,
      );
    });
  }
  events(
    options: { after?: number; before?: number; limit?: number } = {},
  ): Promise<EventsResponse> {
    return this.run(async () => {
      const { after = 0, before, limit = 100 } = options;
      if (
        !Number.isSafeInteger(after) ||
        after < 0 ||
        (before !== undefined &&
          (!Number.isSafeInteger(before) || before < 0 || options.after !== undefined)) ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 200
      )
        failure('INVALID_EVENT_QUERY');
      return await this.db.read('events', { eventAfter: after, eventBefore: before, limit });
    });
  }
  eventMeta(): Promise<EventMeta> {
    return this.run(() => this.db.read('eventMeta'));
  }
  emptyRecordingDays(at = Date.now()): Promise<MediaTimeRange[]> {
    return this.run(() => this.db.read('emptyRecordingDays', { at, from: 0 }));
  }
  syncRevisions(): Promise<{ media: number; events: number; personal: number }> {
    return this.run(() => this.db.read('syncRevisions'));
  }
  ackEvents(cursor: number): Promise<EventMeta> {
    return this.run(async () => {
      if (!Number.isSafeInteger(cursor) || cursor < 0) failure('INVALID_EVENT_CURSOR');
      return await this.db.call('ackEvents', { readCursor: cursor });
    });
  }
  startRun(atMs = Date.now()): Promise<string> {
    return this.run(async () => {
      if (!Number.isSafeInteger(atMs) || atMs < 0) failure('INVALID_RUN_TIME');
      return await this.db.call('startRun', { at: atMs });
    });
  }
  heartbeatRun(runId: string, atMs = Date.now()): Promise<void> {
    return this.run(async () => {
      if (!UUID.test(runId) || !Number.isSafeInteger(atMs) || atMs < 0) failure('INVALID_RUN_TIME');
      await this.db.call('heartbeatRun', { id: runId, at: atMs });
    });
  }
  stopRun(runId: string, outcome: 'normal' | 'abnormal', atMs = Date.now()): Promise<void> {
    return this.run(async () => {
      if (
        !UUID.test(runId) ||
        !['normal', 'abnormal'].includes(outcome) ||
        !Number.isSafeInteger(atMs) ||
        atMs < 0
      )
        failure('INVALID_RUN_TIME');
      await this.db.call('stopRun', { id: runId, outcome, at: atMs });
    });
  }
  runHistory(from: number, to: number): Promise<RunHistoryResponse> {
    return this.run(async () => {
      await archiveWindows(this, from, to, WORKBENCH_WINDOW_MS);
      return await this.db.read('runHistory', { from, to });
    });
  }
  commit(input: CommitInput): Promise<Segment> {
    return this.serial(input.subjectId, async () => {
      subjectId(input.subjectId);
      if (
        !input.sourceEpoch ||
        input.sourceEpoch.length > 200 ||
        !/^(0|[1-9]\d{0,19})$/.test(input.sourceSequence) ||
        BigInt(input.sourceSequence) > 0xffffffffffffffffn ||
        !Number.isFinite(input.durationSeconds) ||
        input.durationSeconds < 0.001 ||
        input.durationSeconds > 86400 ||
        !(input.bytes instanceof Uint8Array) ||
        input.bytes.byteLength === 0 ||
        input.bytes.byteLength > MAX_BYTES ||
        (input.init !== null &&
          (!(input.init instanceof Uint8Array) ||
            input.init.byteLength === 0 ||
            input.init.byteLength > MAX_BYTES)) ||
        !['source-pdt', 'estimated', 'unknown'].includes(input.timeBasis) ||
        typeof input.discontinuity !== 'boolean' ||
        !(
          input.uncertaintyMs === null ||
          (Number.isFinite(input.uncertaintyMs) && input.uncertaintyMs >= 0)
        )
      )
        failure('INVALID_SEGMENT');
      const start = input.timeBasis === 'source-pdt' ? input.wallStartMs : null;
      if (
        input.timeBasis === 'source-pdt' &&
        (start === null ||
          !Number.isSafeInteger(start) ||
          start < 0 ||
          !Number.isSafeInteger(start + Math.round(input.durationSeconds * 1000)))
      )
        failure('INVALID_SOURCE_TIME');
      const subject = await this.db.call<Subject>('subject', { id: input.subjectId });
      const existing = await this.db.call<{ segment: Segment; deleted: boolean } | null>('source', {
        subjectId: input.subjectId,
        epoch: input.sourceEpoch,
        sequence: input.sourceSequence,
      });
      if (existing) {
        if (existing.deleted) failure('SOURCE_SEGMENT_DELETED');
        return existing.segment;
      }
      if (start !== null && start > 253402300799999) failure('INVALID_SOURCE_TIME');
      const staged: ObjectRecord[] = [];
      try {
        let init: ObjectRecord | null = null;
        const stamp = start === null ? null : new Date(start).toISOString();
        const bucket = stamp ? `${stamp.slice(0, 10)}/${stamp.slice(11, 13)}` : 'unlocated';
        if (input.init) {
          init = await this.db.call<ObjectRecord | null>('init', {
            id: input.subjectId,
            hash: await this.files.hash(input.init),
          });
          if (!init) {
            init = await this.files.write(input.subjectId, input.init, 'init', bucket);
            staged.push(init);
          }
        }
        const media = await this.files.write(input.subjectId, input.bytes, 'fragment', bucket);
        staged.push(media);
        const segment: Segment = {
          id: media.id,
          subjectId: input.subjectId,
          sourceEpoch: input.sourceEpoch,
          sourceSequence: input.sourceSequence,
          mediaObjectId: media.id,
          initObjectId: init?.id ?? null,
          durationSeconds: input.durationSeconds,
          wallStartMs: start,
          wallEndMs: start === null ? null : start + Math.round(input.durationSeconds * 1000),
          timeBasis: input.timeBasis,
          uncertaintyMs: input.uncertaintyMs,
          discontinuity: input.discontinuity,
        };
        const revision = (await this.db.call<number>('head', { id: input.subjectId })) + 1;
        const record: JournalRecord = {
          version: 1,
          revision,
          subject: { id: subject.id, providerId: subject.providerId, handle: subject.handle },
          kind: 'commit',
          segment,
          objects: init ? [init, media] : [media],
        };
        await this.fault?.('before-journal-write');
        await this.db.call('apply', { record });
        await this.fault?.('after-journal-sync');
        await this.fault?.('after-index-commit');
        this.notifyMedia({ kind: 'commit', segment });
        return segment;
      } catch (error) {
        // The worker reports busy only after a DB rollback and before journal
        // publication. An uncertain durable write still requires recovery.
        if (error instanceof Error && error.message === 'METADATA_STORAGE_BUSY') {
          const results = await Promise.allSettled(
            staged.map((object) => this.files.discard(object)),
          );
          if (results.some((result) => result.status === 'rejected'))
            console.warn(JSON.stringify({ event: 'unpublished_media_cleanup_failed' }));
        } else this.poisoned = true;
        throw error;
      }
    });
  }
  timeline(
    id: string,
    from: number,
    to: number,
    limit = 1000,
    cursor?: string,
  ): Promise<TimelineResponse> {
    return this.run(async () => {
      subjectId(id);
      windowRange(from, to);
      if (!Number.isInteger(limit) || limit < 1 || limit > 2000) failure('INVALID_TIMELINE_LIMIT');
      return await this.db.read('timeline', { id, from, to, limit, cursor });
    });
  }
  sourceCheckpoint(id: string): Promise<SourceCheckpoint | null> {
    return this.run(async () => {
      subjectId(id);
      return await this.db.call('sourceCheckpoint', { id });
    });
  }
  snapshotPages(
    id: string,
    at: number,
    page = 1,
    limit = 30,
    window: MediaTimeRange,
    followLive = false,
    signal?: AbortSignal,
    unitId?: string,
  ): Promise<SnapshotPagesResponse> {
    return this.run(async () => {
      subjectId(id);
      if (!Number.isSafeInteger(at) || at < 0 || at >= Number.MAX_SAFE_INTEGER)
        failure('INVALID_TIME_WINDOW');
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > MAX_SNAPSHOT_PAGE_SIZE
      )
        failure('INVALID_SNAPSHOT_LIMIT');
      await archiveWindows(this, window.fromMs, window.toMs);
      const deadline = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
        : AbortSignal.timeout(12000);
      await this.unitIndex.wait(deadline);
      const layout = { id, window };
      for (;;) {
        deadline.throwIfAborted();
        try {
          if (!followLive) {
            while (!(await this.db.read<boolean>('prepareSnapshotLayout', layout, deadline))) {
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          }
          return await this.db.read(
            'snapshotPages',
            { ...layout, at, page, limit, followLive, unitId },
            deadline,
          );
        } catch (error) {
          // A committed deletion can retire the layout while it is being
          // prepared as well as while paging it. Restart the whole read.
          if (!(error instanceof Error) || error.message !== 'SNAPSHOT_LAYOUT_STALE') throw error;
        }
      }
    });
  }
  snapshotUnit(id: string, at: number, unitId?: string): Promise<SnapshotItem | null> {
    return this.run(async () => {
      await this.unitIndex.wait();
      subjectId(id);
      if (!Number.isSafeInteger(at) || at < 0 || at >= Number.MAX_SAFE_INTEGER)
        failure('INVALID_TIME_WINDOW');
      if (unitId && !UUID.test(unitId)) failure('INVALID_MEDIA_SELECTION');
      return await this.db.read('snapshotUnit', { id, at, unitId });
    });
  }
  markUnitsSeen(id: string, evidence: UnitSeenEvidence[]): Promise<{ changed: number }> {
    subjectId(id);
    if (
      !evidence.length ||
      evidence.length > 100 ||
      evidence.some(
        (value) => !UUID.test(value.unitId) || !Number.isSafeInteger(value.toMs) || value.toMs < 0,
      )
    )
      failure('INVALID_MEDIA_SELECTION');
    return this.serial(id, async () => {
      await this.unitIndex.wait();
      const newest = new Map<string, UnitSeenEvidence>();
      for (const item of evidence)
        if (item.toMs > (newest.get(item.unitId)?.toMs ?? -1)) newest.set(item.unitId, item);
      return this.db.call('markUnitsSeen', { id, seenEvidence: [...newest.values()] });
    });
  }
  unitFavorites(
    id: string,
    ids: string[],
    liked: FavoriteChange,
    revision: number,
  ): Promise<PersonalTimeline & FavoriteRemovalResult> {
    subjectId(id);
    if (
      !ids.length ||
      ids.length > MAX_SNAPSHOT_SELECTION ||
      ids.some((value) => !UUID.test(value))
    )
      failure('INVALID_MEDIA_SELECTION');
    return this.serial(id, () => this.favoriteUnits(id, ids, liked, revision));
  }
  private async favoriteUnits(
    id: string,
    ids: string[],
    liked: FavoriteChange,
    revision: number,
  ): Promise<PersonalTimeline & FavoriteRemovalResult> {
    const selection = await this.prepareSelection(
      id,
      { fromMs: 0, toMs: 1 },
      'explicit',
      undefined,
      { includeUnitIds: ids },
    );
    await this.acceptFavoriteSelection(id, selection.id, liked, revision);
    return {
      ...(await this.db.read<PersonalTimeline>('unitFavoriteQuery', { id, ids })),
      removed: ids.length,
    };
  }
  unitFavoriteQuery(id: string, ids: string[]): Promise<PersonalTimeline> {
    subjectId(id);
    if (ids.length > MAX_SNAPSHOT_SELECTION || ids.some((key) => !UUID.test(key)))
      failure('INVALID_MEDIA_SELECTION');
    return this.run(async () => {
      await this.unitIndex.wait();
      return this.db.read('unitFavoriteQuery', { id, ids });
    });
  }
  unitBounds(
    id: string,
    from: number,
    to: number,
  ): Promise<(MediaTimeRange & { openUnitId?: string }) | null> {
    subjectId(id);
    return this.run(async () => {
      await archiveWindows(this, from, to);
      await this.unitIndex.wait();
      return this.db.read('unitBounds', { id, from, to });
    });
  }
  unitRange(id: string, unitId: string): Promise<(MediaTimeRange & { open: boolean }) | null> {
    subjectId(id);
    if (!UUID.test(unitId)) failure('INVALID_MEDIA_SELECTION');
    return this.run(async () => {
      await this.unitIndex.wait();
      return this.db.read('unitRange', { id, unitId });
    });
  }
  unitSource(id: string, unitId: string, at: number): Promise<Segment | null> {
    subjectId(id);
    if (!UUID.test(unitId) || !Number.isSafeInteger(at) || at < 0)
      failure('INVALID_MEDIA_SELECTION');
    return this.run(async () => {
      await this.unitIndex.wait();
      return this.db.read('unitSource', { id, unitId, at });
    });
  }
  snapshotForSegment(id: string, segmentId: string): Promise<SnapshotItem | null> {
    subjectId(id);
    if (!UUID.test(segmentId)) failure('INVALID_MEDIA_SELECTION');
    return this.run(async () => {
      await this.unitIndex.wait();
      return this.db.read('snapshotForSegment', { id, segmentId });
    });
  }
  snapshotUnits(
    id: string,
    cursor?: string,
    limit = 8,
  ): Promise<{ items: SnapshotItem[]; cursor: string | null }> {
    subjectId(id);
    if ((cursor?.length ?? 0) > 256 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128)
      failure('INVALID_MEDIA_SELECTION');
    return this.run(async () => {
      await this.unitIndex.wait();
      return this.db.read('snapshotUnits', { id, cursor, limit });
    });
  }
  coverage(
    id: string,
    from: number,
    to: number,
    buckets = 240,
    includeProtection = false,
    signal?: AbortSignal,
  ): Promise<CoverageResponse> {
    return this.readCoverage<CoverageResponse>(
      'coverage',
      id,
      from,
      to,
      buckets,
      includeProtection,
      signal,
    );
  }
  workbenchRow(
    id: string,
    from: number,
    to: number,
    buckets: number,
    includeProtection: boolean,
    signal?: AbortSignal,
  ): Promise<{ coverage: CoverageResponse; status: StatusHistoryResponse }> {
    return this.readCoverage<{ coverage: CoverageResponse; status: StatusHistoryResponse }>(
      'workbenchRow',
      id,
      from,
      to,
      buckets,
      includeProtection,
      signal,
    );
  }
  private readCoverage<T>(
    method: 'coverage' | 'workbenchRow',
    id: string,
    from: number,
    to: number,
    buckets: number,
    includeProtection: boolean,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.run(async () => {
      subjectId(id);
      windowRange(from, to, false);
      if (
        (method === 'coverage' && to - from > 31 * 86400000) ||
        !Number.isSafeInteger(buckets) ||
        buckets < 1 ||
        buckets > 720
      )
        failure('INVALID_COVERAGE_WINDOW');
      const ranges =
        method === 'workbenchRow' && to - from > WORKBENCH_WINDOW_MS
          ? await archiveWindows(this, from, to, WORKBENCH_WINDOW_MS)
          : undefined;
      await this.unitIndex.wait(signal);
      return await this.db.read<T>(
        method,
        { id, from, to, buckets: Math.min(buckets, to - from), includeProtection, ranges },
        signal,
      );
    });
  }
  hasMedia(ids: string[]): Promise<boolean> {
    return this.run(async () => {
      if (ids.length > ARCHIVE_MEDIA_BATCH_LIMIT || ids.some((id) => !UUID.test(id)))
        failure('INVALID_MEDIA_BATCH');
      return await this.db.call('hasMedia', { ids: [...new Set(ids)] });
    });
  }
  locate(id: string, target: number, policy: GapPolicy): Promise<Segment | null> {
    return this.run(async () => {
      subjectId(id);
      if (
        !Number.isSafeInteger(target) ||
        target < 0 ||
        !['report', 'next', 'previous'].includes(policy)
      )
        failure('INVALID_LOCATE');
      return await this.db.call('locate', { id, target, policy });
    });
  }
  media(id: string): Promise<MediaObject | null> {
    return this.run(async () => {
      if (!UUID.test(id)) return null;
      const object = await this.db.call<ObjectRecord | null>('media', { id });
      if (!object) return null;
      return this.files.media(object);
    });
  }
  deleteRange(
    id: string,
    from: number,
    to: number,
  ): Promise<{ deletedSegments: number; reclaimedBytes: number }> {
    return this.removeAll(id, { from, to });
  }
  prepareMediaSelection(
    id: string,
    window: MediaTimeRange,
    mode: MediaSelectionMode,
    signal?: AbortSignal,
    options: MediaSelectionOptions = {},
  ): Promise<MediaSelection> {
    subjectId(id);
    return this.run(async () => {
      await archiveWindows(this, window.fromMs, window.toMs);
      return this.prepareSelection(id, window, mode, signal, options);
    });
  }
  /** Admitted operations use this owner directly and survive graceful close. */
  private async prepareSelection(
    id: string,
    window: MediaTimeRange,
    mode: MediaSelectionMode,
    signal?: AbortSignal,
    options: MediaSelectionOptions & { favoriteFilter?: boolean } = {},
  ): Promise<MediaSelection> {
    await this.unitIndex.wait();
    signal?.throwIfAborted();
    const selectionId = await this.db.call<string>('beginMediaSelection', {
      id,
      window,
      selectionMode: mode,
      selectionOptions: { baseSelectionId: options.baseSelectionId },
    });
    for (const [field, values] of [
      ['includeUnitIds', options.includeUnitIds ?? []],
      ['excludeUnitIds', options.excludeUnitIds ?? []],
    ] as const) {
      for (let offset = 0; offset < values.length; offset += 256) {
        signal?.throwIfAborted();
        await this.db.call('stageSelectionPatch', {
          id,
          selectionId,
          selectionPatch: { [field]: values.slice(offset, offset + 256) },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    while (
      await this.db.call<boolean>('buildMediaSelection', {
        id,
        selectionId,
        favoriteFilter: options.favoriteFilter,
      })
    ) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    signal?.throwIfAborted();
    return this.db.read('mediaSelection', { id, selectionId });
  }
  favoriteMediaSelection(
    id: string,
    selectionId: string,
    liked: FavoriteChange,
    revision: number,
    patch: MediaSelectionPatch,
    signal?: AbortSignal,
  ): Promise<MediaSelectionResult> {
    subjectId(id);
    if (!UUID.test(selectionId)) failure('INVALID_MEDIA_SELECTION');
    return this.serial(id, async () => {
      const target = await this.forkMediaSelection(id, selectionId, patch, signal);
      signal?.throwIfAborted();
      return this.acceptFavoriteSelection(id, target, liked, revision, signal);
    });
  }
  planMediaSelectionDeletion(
    id: string,
    selectionId: string,
    patch: MediaSelectionPatch,
    signal?: AbortSignal,
  ): Promise<MediaDeletePlan> {
    subjectId(id);
    if (!UUID.test(selectionId)) failure('INVALID_MEDIA_SELECTION');
    return this.run(() => this.prepareDeletion(id, selectionId, patch, signal));
  }
  private async prepareDeletion(
    id: string,
    selectionId: string,
    patch: MediaSelectionPatch,
    signal?: AbortSignal,
  ): Promise<MediaDeletePlan> {
    const target = await this.forkMediaSelection(id, selectionId, patch, signal);
    const planId = await this.db.call<string>('beginSelectedDeletionPlan', {
      id,
      selectionId: target,
    });
    while (await this.db.call<boolean>('buildDeletionPlan', { id: planId })) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    signal?.throwIfAborted();
    return this.db.read('deletionPlan', { id: planId });
  }
  planDeletion(id: string, ranges: MediaTimeRange[]): Promise<MediaDeletePlan> {
    subjectId(id);
    this.validateSelection(ranges);
    return this.run(async () => {
      await this.unitIndex.wait();
      const planId = await this.db.call<string>('beginDeletionPlan', { id, ranges });
      while (await this.db.call<boolean>('buildDeletionPlan', { id: planId }))
        await new Promise<void>((resolve) => setImmediate(resolve));
      return this.db.call('deletionPlan', { id: planId });
    });
  }
  planUnitDeletion(id: string, ids: string[], signal?: AbortSignal): Promise<MediaDeletePlan> {
    subjectId(id);
    if (!ids.length || ids.length > MAX_SNAPSHOT_SELECTION || ids.some((key) => !UUID.test(key)))
      failure('INVALID_MEDIA_SELECTION');
    return this.run(async () => {
      const selection = await this.prepareSelection(
        id,
        { fromMs: 0, toMs: 1 },
        'explicit',
        signal,
        { includeUnitIds: ids },
      );
      return this.prepareDeletion(id, selection.id, {}, signal);
    });
  }
  private async forkMediaSelection(
    id: string,
    selectionId: string,
    patch: MediaSelectionPatch,
    signal?: AbortSignal,
  ): Promise<string> {
    signal?.throwIfAborted();
    if (!patch.includeUnitIds?.length && !patch.excludeUnitIds?.length) return selectionId;
    const original = await this.db.read<MediaSelection>('mediaSelection', { id, selectionId });
    const selection = await this.prepareSelection(id, original, 'explicit', signal, {
      baseSelectionId: selectionId,
      ...patch,
    });
    return selection.id;
  }
  private async acceptFavoriteSelection(
    id: string,
    selectionId: string,
    liked: FavoriteChange,
    revision: number,
    signal?: AbortSignal,
  ): Promise<MediaSelectionResult> {
    const favoriteChanges =
      liked === 'toggle'
        ? await this.prepareFavoriteInversion(id, selectionId, revision, signal)
        : [{ selectionId, liked }];
    // The same subject queue covers retention's read-and-tombstone interval.
    signal?.throwIfAborted();
    const result = await this.db.call<MediaSelectionResult>('favoriteMediaSelection', {
      id,
      favoriteChanges,
      personalRevision: revision,
    });
    void this.resumeFavorites().catch((error) =>
      console.warn('favorite_materialization_failed', error),
    );
    return result;
  }
  private async prepareFavoriteInversion(
    id: string,
    selectionId: string,
    revision: number,
    signal?: AbortSignal,
  ): Promise<FavoriteSelectionChange[]> {
    const source = await this.db.read<MediaSelection>('mediaSelection', { id, selectionId });
    if (source.personalRevision !== revision) failure('PERSONAL_REVISION_STALE');
    const changes: FavoriteSelectionChange[] = [];
    let count = 0;
    for (const liked of [false, true]) {
      const group = await this.prepareSelection(id, source, 'explicit', signal, {
        baseSelectionId: selectionId,
        favoriteFilter: !liked,
      });
      count += group.count;
      changes.push({ selectionId: group.id, liked });
    }
    if (count !== source.count) failure('MEDIA_SELECTION_STALE');
    return changes;
  }
  resumeFavorites(): Promise<void> {
    if (this.favoriteWork) return this.favoriteWork;
    if (this.closing || this.poisoned) return Promise.resolve();
    this.favoriteError = undefined;
    this.favoriteWork = this.withBackgroundReads(async () => {
      let previous: string[] = [];
      while (!this.closing && !this.poisoned) {
        let subjects = await this.db.read<string[]>('favoriteSubjects', {
          limit: this.backgroundConcurrency,
          excludedSubjects: previous,
        });
        if (!subjects.length && previous.length)
          subjects = await this.db.read<string[]>('favoriteSubjects', {
            limit: this.backgroundConcurrency,
          });
        previous = subjects;
        await Promise.all(
          subjects.map((id) =>
            this.backgroundPool.run(async () => {
              if (!this.closing && !this.poisoned)
                await this.db.call<boolean>('materializeFavorites', { id });
            }),
          ),
        );
        const maintenance = await this.db.call<boolean>('selectionMaintenance');
        if (!subjects.length && !maintenance) break;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    })
      .catch((error) => {
        this.favoriteError =
          error instanceof Error
            ? error
            : new Error('FAVORITE_MATERIALIZATION_FAILED', { cause: error });
        throw error;
      })
      .finally(() => {
        this.favoriteWork = undefined;
      });
    return this.favoriteWork;
  }
  async deleteSelection(
    id: string,
    planId: string,
    personalRevision: number,
  ): Promise<MediaDeletionJob> {
    subjectId(id);
    if (!UUID.test(planId) || !Number.isSafeInteger(personalRevision) || personalRevision < 0)
      failure('INVALID_MEDIA_SELECTION');
    return this.run(async () => {
      const published = await this.db.read<MediaDeletionJob | null>('acceptedMediaDeletion', {
        id,
        planId,
      });
      const job =
        published ??
        (await this.serial(
          id,
          async () => {
            for (;;) {
              const result = await this.db.call<MediaDeletionJob | null>('enqueueMediaDeletion', {
                id,
                planId,
                personalRevision,
              });
              if (result) return result;
              await new Promise<void>((resolve) => setImmediate(resolve));
            }
          },
          true,
        ));
      this.notifyMedia({
        kind: 'delete',
        subjectId: id,
        fromMs: job.fromMs ?? 0,
        toMs: job.toMs ?? 0,
      });
      void this.resumeDeletions().catch((error) =>
        console.warn('Deletion queue unavailable', error),
      );
      return job;
    });
  }
  admitDeletion(
    id: string,
    commandId: string,
    deletionTarget: MediaDeletionTarget,
  ): Promise<MediaDeletionJob> {
    subjectId(id);
    if (!UUID.test(commandId)) failure('INVALID_MEDIA_SELECTION');
    return this.run(async () => {
      const started = performance.now();
      const { job, published } = await this.db.call<{ job: MediaDeletionJob; published: boolean }>(
        'admitDeletionIntent',
        {
          id,
          commandId,
          deletionTarget,
        },
      );
      if (published) {
        console.info(
          JSON.stringify({
            event: 'media_deletion_admitted',
            commandId,
            subjectId: id,
            state: job.state,
            phase: job.phase,
            elapsedMs: Math.round(performance.now() - started),
          }),
        );
        this.notifyMedia({
          kind: 'delete',
          subjectId: id,
          fromMs: job.fromMs ?? deletionTarget.fromMs,
          toMs: job.toMs ?? deletionTarget.toMs,
        });
      }
      if (job.state !== 'completed' && job.state !== 'failed')
        setImmediate(() => {
          void this.resumeDeletions().catch((error) =>
            console.warn('Deletion queue unavailable', error),
          );
        });
      return job;
    });
  }
  async deletionJobs(): Promise<MediaDeletionJob[]> {
    return (await this.deletionInventory()).jobs;
  }
  deletionInventory(): Promise<MediaDeletionQueue> {
    return this.run(async () => {
      this.deletionRead ??= this.db
        .call<MediaDeletionQueue>('mediaDeletionInventory')
        .finally(() => {
          this.deletionRead = undefined;
        });
      return this.deletionRead;
    });
  }
  deletionJob(commandId: string): Promise<MediaDeletionJob | null> {
    if (!UUID.test(commandId)) failure('INVALID_MEDIA_SELECTION');
    return this.run(() => this.db.read('mediaDeletionJob', { commandId }));
  }
  subscribeDeletionComplete(listener: () => void): () => void {
    this.deletionCompleteListeners.add(listener);
    return () => this.deletionCompleteListeners.delete(listener);
  }
  async retryDeletions(): Promise<void> {
    await this.run(() =>
      this.db.call('expediteMediaDeletions', { limit: this.backgroundConcurrency }),
    );
    await this.resumeDeletions();
  }
  resumeDeletions(): Promise<void> {
    this.deletionWakeup.notify();
    if (this.deletionWork) return this.deletionWork;
    if (this.closing || this.poisoned) return Promise.resolve();
    const work = async (): Promise<void> => {
      const active = new Map<string, Promise<void>>(),
        failures: unknown[] = [];
      try {
        while (!this.closing && !this.poisoned) {
          const epoch = this.deletionWakeup.epoch;
          if (failures.length) throw failures[0];
          while (active.size < this.backgroundConcurrency && !this.closing && !this.poisoned) {
            const excludedSubjects = [...active.keys()];
            const job = await this.db.read<PendingDeletion | null>('nextMediaDeletion', {
              excludedSubjects,
            });
            if (!job) break;
            // The archive owner and active subject map reserve a step without a journal write.
            // Drain each committed plan page before producing the next one for this subject.
            const preparing = job.state === 'preparing' && job.segmentIds.length === 0;
            const task = this.backgroundPool
              .run(async () => {
                if (this.closing || this.poisoned) return;
                if (preparing) await this.prepareDeletionStep(job);
                else await this.executeDeletionBatch(job);
              })
              .catch((error: unknown) => {
                failures.push(error);
              })
              .finally(() => {
                active.delete(job.subjectId);
                // An in-flight lookup may have excluded this subject before the step finished.
                this.deletionWakeup.notify();
              });
            active.set(job.subjectId, task);
          }
          if (epoch !== this.deletionWakeup.epoch) continue;
          if (!active.size) break;
          const changed = this.deletionWakeup.next(epoch);
          try {
            await Promise.race([...active.values(), changed.promise]);
          } finally {
            changed.dispose();
          }
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } finally {
        await Promise.all(active.values());
      }
      if (failures.length) throw failures[0];
    };
    this.deletionWork = this.withBackgroundReads(work).finally(() => {
      this.deletionWork = undefined;
    });
    return this.deletionWork;
  }
  private async prepareDeletionStep(pending: MediaDeletionJob): Promise<void> {
    const started = performance.now();
    if (pending.phase === 'units' && !pending.scannedUnits && !pending.error)
      console.info(
        JSON.stringify({
          event: 'media_deletion_started',
          commandId: pending.id,
          queueMs: Math.max(0, Date.now() - pending.createdAtMs),
        }),
      );
    try {
      await this.fault?.('before-deletion-prepare');
      const result = await this.db.call<MediaDeletionJob | null>('prepareDeletionIntent', {
        commandId: pending.id,
      });
      const elapsedMs = Math.round(performance.now() - started);
      if (
        result &&
        (result.phase !== pending.phase || result.state === 'failed' || elapsedMs >= 500)
      )
        console.info(
          JSON.stringify({
            event: 'media_deletion_phase',
            commandId: result.id,
            phase: result.phase,
            state: result.state,
            scannedUnits: result.scannedUnits,
            selectedUnits: result.selectedUnits,
            fragments: result.total,
            elapsedMs,
          }),
        );
      if (result?.state === 'failed')
        this.notifyMedia({
          kind: 'delete',
          subjectId: result.subjectId,
          fromMs: result.fromMs ?? 0,
          toMs: result.toMs ?? 0,
        });
      if (result?.state === 'completed') this.emitDeletionComplete(result);
    } catch (error) {
      await this.db.call('retryDeletionIntent', { id: pending.id });
      console.warn('Deletion preparation paused for recovery', pending.id, error);
    }
  }
  private async executeDeletionBatch(job: PendingDeletion): Promise<void> {
    let advanced: MediaDeletionJob;
    try {
      const result = await this.remove(
        job.subjectId,
        { segmentIds: job.segmentIds },
        true,
        false,
        true,
      );
      const checkpointStarted = performance.now();
      advanced = await this.db.call<MediaDeletionJob>('advanceMediaDeletion', {
        id: job.id,
        processed: job.processed + job.segmentIds.length,
        gcObjectIds: result.gcObjectIds,
      });
      const checkpointMs = Math.round(performance.now() - checkpointStarted);
      if (
        !job.processed ||
        advanced.state === 'completed' ||
        Math.floor(advanced.processed / 2048) > Math.floor(job.processed / 2048) ||
        result.tombstoneMs + result.reclaimMs + checkpointMs >= 1000
      )
        console.info(
          JSON.stringify({
            event: 'media_deletion_batch',
            commandId: job.id,
            processed: advanced.processed,
            reclaimedBytes: advanced.reclaimedBytes,
            tombstoneMs: result.tombstoneMs,
            reclaimMs: result.reclaimMs,
            unlinkMs: result.unlinkMs,
            directorySyncMs: result.directorySyncMs,
            checkpointMs,
          }),
        );
    } catch (error) {
      await this.db.call('retryMediaDeletion', { id: job.id });
      console.warn(
        this.poisoned ? 'Media deletion paused for archive recovery' : 'Media deletion will retry',
        job.id,
        error,
      );
      return;
    }
    if (advanced.state === 'completed') this.emitDeletionComplete(advanced);
  }
  private emitDeletionComplete(job: MediaDeletionJob): void {
    for (const listener of this.deletionCompleteListeners) {
      try {
        listener();
      } catch (error) {
        console.warn('archive_deletion_complete_listener_failed', job.id, error);
      }
    }
  }
  private validateSelection(ranges: MediaTimeRange[]): void {
    if (
      !ranges.length ||
      ranges.length > MAX_SNAPSHOT_SELECTION ||
      // A seven-day view may expand outwards across complete source fragments.
      Math.max(...ranges.map((r) => r.toMs)) - Math.min(...ranges.map((r) => r.fromMs)) >=
        9 * 86400000 ||
      ranges.some(
        (r) =>
          !Number.isSafeInteger(r.fromMs) ||
          r.fromMs < 0 ||
          !Number.isSafeInteger(r.toMs) ||
          r.toMs <= r.fromMs ||
          r.toMs - r.fromMs > 86460000,
      )
    )
      failure('INVALID_MEDIA_SELECTION');
  }
  deleteUnlocated(id: string): Promise<{ deletedSegments: number; reclaimedBytes: number }> {
    return this.removeAll(id, { unlocated: true });
  }
  pruneBefore(cutoffMs: number, retentionDays?: number): Promise<RemovalResult> {
    return this.run(async () => {
      await this.unitIndex.wait();
      if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 0) failure('INVALID_PRUNE_CUTOFF');
      if (
        retentionDays !== undefined &&
        (!Number.isSafeInteger(retentionDays) || retentionDays < 1)
      )
        failure('INVALID_RETENTION_DAYS');
      const subjects = await this.db.call<Subject[]>('list', { activity: false });
      let deletedSegments = 0,
        reclaimedBytes = 0;
      for (const subject of subjects) {
        const result = await this.removeAll(subject.id, { cutoff: cutoffMs, retentionDays }, true);
        deletedSegments += result.deletedSegments;
        reclaimedBytes += result.reclaimedBytes;
        if (result.retentionChanged) break;
      }
      return { deletedSegments, reclaimedBytes };
    });
  }
  pruneEmptyDays(at: number, from = 0): Promise<number | null> {
    return this.run(() =>
      this.withBackgroundReads(async () => {
        // Give fragments finishing around midnight a chance to reach the archive.
        const empty = await this.db.read<MediaTimeRange[]>('emptyRecordingDays', {
          at: at - EMPTY_DAY_SETTLE_MS,
          from,
          includePendingDeletion: true,
        });
        let remaining = 8;
        for (const range of empty) {
          if (!remaining) return range.fromMs;
          // Spend the same transaction budget on a single busy date as on several small ones.
          for (;;) {
            remaining--;
            const more = await this.db.call<boolean>('pruneEmptyHistory', {
              from: range.fromMs,
              to: range.toMs,
            });
            if (!more) break;
            if (!remaining) return range.fromMs;
          }
        }
        return null;
      }),
    );
  }
  private removeAll(id: string, filter: DeleteFilter, accepted = false): Promise<RemovalResult> {
    const drain = async () => {
      let deletedSegments = 0,
        reclaimedBytes = 0;
      for (;;) {
        const batch = await this.remove(id, filter, true);
        deletedSegments += batch.deletedSegments;
        reclaimedBytes += batch.reclaimedBytes;
        if (!batch.deletedSegments) return { ...batch, deletedSegments, reclaimedBytes };
      }
    };
    // The admitted sweep survives close, but each batch releases the subject lock
    // so new recording commits and favorite protection can take their turn.
    return accepted ? drain() : this.run(drain);
  }
  private remove(
    id: string,
    filter: DeleteFilter & { segmentIds: string[] },
    accepted: boolean,
    publishChange: boolean,
    deferGcCheckpoint: true,
  ): Promise<DeferredRemovalResult>;
  private remove(
    id: string,
    filter: DeleteFilter,
    accepted?: boolean,
    publishChange?: boolean,
  ): Promise<RemovalResult>;
  private remove(
    id: string,
    filter: DeleteFilter,
    accepted = false,
    publishChange = true,
    deferGcCheckpoint = false,
  ): Promise<RemovalResult | DeferredRemovalResult> {
    const started = performance.now();
    const publish = this.serial(
      id,
      async () => {
        subjectId(id);
        if (filter.from !== undefined && filter.to !== undefined)
          windowRange(filter.from, filter.to, false);
        const { subject, revision, candidates } = await this.db.read<{
          subject: Pick<Subject, 'id' | 'providerId' | 'handle'>;
          revision: number;
          candidates: { id: string; start: number | null; end: number | null }[];
        }>('deleteBatch', { id, ...filter });
        if (!candidates.length) return 0;
        const segmentIds = candidates.map((candidate) => candidate.id);
        const record: JournalRecord = {
          version: 1,
          revision,
          subject,
          kind: 'delete',
          segmentIds,
        };
        await this.fault?.('before-journal-write');
        try {
          const applied = await this.db.call<boolean>(
            deferGcCheckpoint ? 'applyQueuedDeletion' : 'apply',
            { record, retentionDays: filter.retentionDays },
          );
          if (!applied) return null;
          await this.fault?.('after-tombstone-sync');
          await this.fault?.('after-tombstone-commit');
        } catch (error) {
          // The recovery barrier starts at publication. Once the tombstone is
          // committed, physical GC can retry independently.
          if (!(error instanceof Error) || error.message !== 'METADATA_STORAGE_BUSY')
            this.poisoned = true;
          throw error;
        }
        if (publishChange) {
          let fromMs = Infinity,
            toMs = -Infinity;
          for (const { start, end } of candidates) {
            if (start === null || end === null) continue;
            fromMs = Math.min(fromMs, start);
            toMs = Math.max(toMs, end);
          }
          if (fromMs < toMs) this.notifyMedia({ kind: 'delete', subjectId: id, fromMs, toMs });
        }
        return segmentIds.length;
      },
      accepted,
    );
    // Tombstones are final before unlink. Future commits cannot reuse retired
    // UUID objects (including init objects); they publish a new object instead.
    return publish.then(async (deletedSegments) => {
      if (deletedSegments === null)
        return { deletedSegments: 0, reclaimedBytes: 0, retentionChanged: true };
      if (!deferGcCheckpoint) return { deletedSegments, reclaimedBytes: await this.collect(id) };

      const tombstoned = performance.now();
      const objects = await this.db.call<ObjectRecord[]>('pendingGc', {
        id,
        segmentIds: filter.segmentIds,
      });
      const reclaimed = await this.files.reclaimBatch(objects, this.gcIo);
      return {
        deletedSegments,
        ...reclaimed,
        gcObjectIds: objects.map((object) => object.id),
        tombstoneMs: tombstoned - started,
        reclaimMs: performance.now() - tombstoned,
      };
    });
  }
  recoveryStats(): {
    cleanStartup: boolean;
    journalRecordsRead: number;
    journalRecordsApplied: number;
    journalBytesRead: number;
    objectsVerified: number;
  } {
    return { ...this.recovery };
  }
  scrub(
    options: { limit?: number; delayMs?: number; cursor?: string } = {},
  ): Promise<{ checked: number; nextCursor: string | null }> {
    return this.run(async () => {
      const orphanError = this.orphanError;
      if (this.orphanSubjects.length) this.startOrphanSweep();
      if (orphanError) throw orphanError;
      const limit = options.limit ?? 128,
        delay = options.delayMs ?? 5;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1024 ||
        !Number.isFinite(delay) ||
        delay < 0 ||
        delay > 1000
      )
        failure('INVALID_SCRUB_OPTIONS');
      let after = options.cursor ?? '',
        checked = 0;
      while (checked < limit) {
        const objects = await this.db.call<ObjectRecord[]>('liveObjects', { after });
        if (!objects.length) return { checked, nextCursor: null };
        for (const object of objects.slice(0, limit - checked)) {
          // Tombstone may win while scrub is reading: never restore it.
          try {
            await this.files.verify(object);
          } catch (error) {
            if (await this.db.call('media', { id: object.id })) throw error;
          }
          checked++;
          after = object.id;
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
      return { checked, nextCursor: after };
    });
  }
  getSetting(key: string): Promise<string | null> {
    return this.run(() => this.db.call('settingGet', { key }));
  }
  identity(): Promise<{ instanceId: string; userId: string; timelineStartMs: number }> {
    return this.run(() => this.db.call('identity'));
  }
  personalRevision(): Promise<number> {
    return this.run(() => this.db.call('personalRevision'));
  }
  personal(id: string, from: number, to: number): Promise<PersonalTimeline> {
    subjectId(id);
    return this.run(async () => {
      await archiveWindows(this, from, to);
      await this.unitIndex.wait();
      return this.db.read('personal', { id, from, to });
    });
  }
  removeFavorite(id: string): Promise<void> {
    if (!UUID.test(id)) failure('INVALID_FAVORITE');
    return this.run(async () => {
      await this.unitIndex.wait();
      const subject = await this.db.read<string | null>('favoriteSubject', { id });
      if (!subject) return;
      const revision = await this.db.read<number>('personalRevision');
      await this.serial(subject, () => this.favoriteUnits(subject, [id], false, revision), true);
    });
  }
  setSetting(key: string, value: string): Promise<void> {
    return this.run(async () => {
      // Per-subject settings use canonical IDs such as stripchat:123. These
      // names are bound SQL keys, never paths; slashes remain forbidden.
      if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(key) || value.length > 1024 * 1024)
        failure('INVALID_SETTING');
      await this.db.call('settingSet', { key, value });
    });
  }
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.closing = true;
    clearTimeout(this.gcRetryTimer);
    this.gcRetryTimer = undefined;
    const indexStopped = this.unitIndex.stop();
    this.closed = (async () => {
      await Promise.allSettled([this.deletionWork, this.favoriteWork]);
      await this.orphanWork;
      await indexStopped;
      await Promise.allSettled([...this.operations]);
      await Promise.allSettled([...this.gcWork.values()]);
      try {
        await this.db.call('close', { clean: !this.poisoned });
      } finally {
        await this.db.terminate();
      }
    })();
    return this.closed;
  }
}
