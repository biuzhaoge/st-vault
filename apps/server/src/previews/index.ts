import type { BackgroundTask, Segment, SnapshotItem } from '@st-vault/api-schema';
import type { ArchivePort, PreviewsPort } from '../ports.js';
import { createHttp, waitFor } from '../provider/http.js';
import { MediaBudget } from '../provider/media-budget.js';
import { createFfmpegDecoder, jpeg, SnapshotDecodeError, verifyJpeg } from './ffmpeg.js';
import { ScreenshotJobs, SNAPSHOT_REQUEST_PRIORITY } from './jobs.js';
import type { SnapshotDecoder } from './ffmpeg.js';
import { createPreviewImageReader, missingImageResponse, previewImageType } from './image-type.js';
import { PreviewDiskCache } from './disk-cache.js';
import { LibraryImages } from '../library/images.js';
import { createSubjectAvatars } from './avatars.js';
import type { SyncClock } from '../runtime/sync-clock.js';
import path from 'node:path';
import { coverSource } from '../provider/cover-source.js';
import { DerivativeDiagnostics } from './derivative-diagnostics.js';

export class PreviewError extends Error {
  constructor(
    readonly code:
      | 'preview_not_found'
      | 'preview_busy'
      | 'preview_unavailable'
      | 'preview_timeout'
      | 'preview_failed'
      | 'preview_cancelled'
      | 'preview_pending',
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}
interface CacheEntry {
  bytes: Uint8Array;
  expires: number;
  mediaIds?: string[];
  throughMs?: number;
}
interface Task {
  controller: AbortController;
  done: Promise<unknown>;
}
interface PreviewLane {
  budget: MediaBudget | null;
  capacity: number;
  admitted: number;
}
export interface PreviewOptions {
  clock?: SyncClock;
  archive: Pick<
    ArchivePort,
    | 'listSubjects'
    | 'getSubject'
    | 'locate'
    | 'timeline'
    | 'media'
    | 'hasMedia'
    | 'subscribeMedia'
    | 'subjectPreview'
    | 'snapshotPages'
    | 'snapshotUnit'
    | 'unitSource'
  > &
    Partial<Pick<ArchivePort, 'getSetting' | 'setSetting' | 'withBackgroundReads'>>;
  fetch?: typeof globalThis.fetch;
  ffmpegPath?: string;
  decoder?: SnapshotDecoder;
  now?: () => number;
  timeoutMs?: number;
  cacheBytes?: number;
  cacheRoot?: string;
  mediaRoot?: string;
  canGenerate?: () => boolean;
  validateSnapshot?: (bytes: Uint8Array, signal: AbortSignal) => Promise<void>;
  decoderConcurrency?: number;
  networkConcurrency?: number;
  readConcurrency?: number;
  publishConcurrency?: number;
}
export function createPreviews(options: PreviewOptions): PreviewsPort {
  const avatars =
    options.cacheRoot && options.archive.getSetting && options.archive.setSetting
      ? createSubjectAvatars({
          root: options.cacheRoot,
          mediaRoot: options.mediaRoot,
          archive: {
            listSubjects: options.archive.listSubjects.bind(options.archive),
            getSubject: options.archive.getSubject.bind(options.archive),
            getSetting: options.archive.getSetting.bind(options.archive),
            setSetting: options.archive.setSetting.bind(options.archive),
            withBackgroundReads: options.archive.withBackgroundReads?.bind(options.archive),
          },
          clock: options.clock,
          fetch: options.fetch,
          concurrency: options.networkConcurrency,
          publishConcurrency: options.publishConcurrency,
        })
      : null;
  const now = options.now ?? Date.now,
    timeoutMs = options.timeoutMs ?? 15000,
    cacheBytes = options.cacheBytes ?? 8 * 1024 * 1024;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(cacheBytes) ||
    cacheBytes < 0 ||
    cacheBytes > 32 * 1024 * 1024
  )
    throw new Error('INVALID_PREVIEW_OPTIONS');
  const readCoverImage = createPreviewImageReader(
    createHttp({
      fetch: options.fetch,
      timeoutMs: 5000,
      allow: (url) => coverSource(url.href) !== null,
    }),
  );
  const decode = options.decoder ?? createFfmpegDecoder({ ffmpegPath: options.ffmpegPath });
  const screenshotDiagnostics = new DerivativeDiagnostics(now);
  const cache = new Map<string, CacheEntry>(),
    tasks = new Set<Task>();
  let used = 0,
    closed = false,
    closing: Promise<void> | undefined;
  const emptyWindows = new Map<string, number>();
  const decoderBudget = new MediaBudget(options.decoderConcurrency ?? 1),
    networkBudget = new MediaBudget(options.networkConcurrency ?? 2),
    queryBudget = new MediaBudget(options.readConcurrency ?? 4),
    coverReadBudget = new MediaBudget(options.readConcurrency ?? 4);
  // Bound waiters by their resource class rather than competing for a global
  // request count. Waiting requests retain metadata, not decoded image buffers.
  const lane = (
    budget: MediaBudget | null,
    concurrency = budget?.stats().limit ?? 1,
  ): PreviewLane => ({
    budget,
    capacity: Math.max(24, concurrency * 4),
    admitted: 0,
  });
  const decoderLane = lane(decoderBudget),
    networkLane = lane(networkBudget),
    queryLane = lane(queryBudget),
    imageReadLane = lane(coverReadBudget),
    coverLane = lane(null, networkBudget.stats().limit + coverReadBudget.stats().limit);
  const coverDisk = options.mediaRoot
    ? new LibraryImages(options.mediaRoot, 'cover', options.publishConcurrency)
    : options.cacheRoot
      ? new PreviewDiskCache(path.join(options.cacheRoot, 'covers'), 128 * 1024 ** 2, 2048)
      : null;
  const defaultCoverDisk = options.mediaRoot
    ? new LibraryImages(options.mediaRoot, 'default-cover', options.publishConcurrency)
    : options.cacheRoot
      ? new PreviewDiskCache(path.join(options.cacheRoot, 'default-covers'), 128 * 1024 ** 2, 2048)
      : null;
  const cached = (key: string): Uint8Array | null => {
    const entry = cache.get(key);
    if (!entry) return null;
    cache.delete(key);
    if (entry.expires <= now()) {
      used -= entry.bytes.length;
      return null;
    }
    cache.set(key, entry);
    return entry.bytes;
  };
  const save = (
    key: string,
    bytes: Uint8Array,
    ttl: number,
    cover = false,
    mediaIds?: string[],
    throughMs?: number,
  ): void => {
    if (closed) throw new PreviewError('preview_cancelled');
    if (bytes.length > 512 * 1024 || !(cover ? previewImageType(bytes) : jpeg(bytes)))
      throw new PreviewError('preview_failed');
    const old = cache.get(key);
    if (old) {
      used -= old.bytes.length;
      cache.delete(key);
    }
    if (bytes.length > cacheBytes) return;
    while (cache.size >= 96 || used + bytes.length > cacheBytes) {
      const first = cache.keys().next().value;
      if (first === undefined) break;
      used -= cache.get(first)!.bytes.length;
      cache.delete(first);
    }
    cache.set(key, { bytes, expires: now() + ttl, mediaIds, throughMs });
    used += bytes.length;
  };
  const run = async <T>(
    lane: PreviewLane,
    signal: AbortSignal | undefined,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (closed) throw new PreviewError('preview_unavailable');
    if (signal?.aborted) throw new PreviewError('preview_cancelled');
    if (lane.admitted >= lane.capacity) throw new PreviewError('preview_busy');
    lane.admitted++;
    const controller = new AbortController(),
      cancel = (): void => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const work = (async () => {
      const release = lane.budget
        ? await lane.budget.acquire(controller.signal)
        : (): void => undefined;
      timer = setTimeout(cancel, timeoutMs);
      try {
        return await action(controller.signal);
      } finally {
        clearTimeout(timer);
        release();
      }
    })();
    const task: Task = { controller, done: work };
    tasks.add(task);
    void work
      .finally(() => {
        tasks.delete(task);
        lane.admitted--;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      })
      .catch(() => undefined);
    try {
      return await waitFor(work, controller.signal);
    } catch (error) {
      if (error instanceof PreviewError) throw error;
      if (controller.signal.aborted)
        throw new PreviewError(signal?.aborted ? 'preview_cancelled' : 'preview_unavailable');
      if (lane === queryLane && error instanceof Error) {
        if (error.name === 'TimeoutError')
          throw new PreviewError('preview_timeout', { cause: error });
        if (
          [
            'METADATA_READ_BUSY',
            'METADATA_STORAGE_BUSY',
            'METADATA_WORKER_UNAVAILABLE',
            'ARCHIVE_CLOSED',
            'ARCHIVE_REQUIRES_RECOVERY',
            'PORTABLE_LIBRARY_REQUIRES_RECOVERY',
            'SUBJECT_NOT_FOUND',
          ].includes(error.message)
        )
          throw error;
      }
      throw new PreviewError('preview_failed', { cause: error });
    }
  };
  const subject = async (id: string): Promise<number> => {
    const item = await options.archive.getSubject(id, { activity: false });
    if (!item) throw new PreviewError('preview_not_found');
    return item.providerId;
  };
  const covering = async (id: string, at: number, unitId?: string): Promise<Segment> => {
    const segment =
      unitId && options.archive.unitSource
        ? await options.archive.unitSource(id, unitId, at)
        : await options.archive.locate(id, at, 'report');
    if (
      segment?.wallStartMs == null ||
      segment.wallEndMs === null ||
      segment.wallStartMs > at ||
      segment.wallEndMs <= at
    )
      throw new PreviewError('preview_not_found');
    return segment;
  };
  const ids = (segments: readonly Segment[]): string[] => [
    ...new Set(
      segments.flatMap((segment) =>
        segment.initObjectId
          ? [segment.initObjectId, segment.mediaObjectId]
          : [segment.mediaObjectId],
      ),
    ),
  ];
  const observedSources = new Map<string, string | null>();
  const versions = new Map<string, string>();
  const coverDiagnostics = new DerivativeDiagnostics(now);
  const coverFailures = new Map<
    string,
    {
      source: string;
      attempts: number;
      consecutiveFailures: number;
      retryAt: number;
      missing: boolean;
    }
  >();
  const coverMissing = (error: unknown): boolean =>
    missingImageResponse(error) ||
    (error instanceof PreviewError && error.code === 'preview_not_found');
  const reportCoverFailure = (error: unknown, source: string | null): void => {
    if (coverMissing(error)) return;
    coverDiagnostics.record(
      'cover_refresh_failed',
      error,
      'warn',
      source ? new URL(source).hostname : undefined,
    );
  };
  const failCover = (id: string, qualification: string, error: unknown): void => {
    const previous = coverFailures.get(id);
    const attempts = previous?.source === qualification ? Math.min(previous.attempts + 1, 7) : 1;
    const missing = coverMissing(error);
    const previousFailures = previous?.source === qualification ? previous.consecutiveFailures : 0;
    coverFailures.delete(id);
    // These are short-lived retry qualifications, not a second image/version cache.
    if (coverFailures.size >= 2048) coverFailures.delete(coverFailures.keys().next().value!);
    coverFailures.set(id, {
      source: qualification,
      attempts,
      consecutiveFailures: missing ? 0 : Math.min(previousFailures + 1, 7),
      retryAt: now() + Math.min(300000, 5000 * 2 ** (attempts - 1)),
      missing,
    });
  };
  const defaultDownloads = new Map<string, Promise<Uint8Array>>();
  const publishCover = async (
    disk: PreviewDiskCache | LibraryImages,
    providerId: number,
    bytes: Uint8Array,
  ): Promise<void> => {
    const key = `cover:${providerId}`;
    const canPublish = async () =>
      Boolean(await options.archive.getSubject(`stripchat:${providerId}`, { activity: false }));
    if (disk instanceof LibraryImages) {
      if (await disk.put(key, bytes, canPublish)) return;
      if (!(await canPublish())) throw new PreviewError('preview_not_found');
    } else if (await disk.put(key, bytes)) return;
    throw Error('COVER_CACHE_WRITE_FAILED');
  };

  const loadDefaultCover = (
    providerId: number,
    source: string,
    abort: AbortSignal,
  ): Promise<Uint8Array> => {
    if (!defaultCoverDisk || !options.archive.getSetting || !options.archive.setSetting)
      return readCoverImage(source, abort);
    const disk = defaultCoverDisk,
      key = `cover:${providerId}`,
      setting = `preview.default-cover-source.${providerId}`;
    const pending = defaultDownloads.get(key);
    // Serialize versions of a default so the stored image and its source stay paired.
    const load = async (): Promise<Uint8Array> => {
      const stored = await disk.get(key);
      if (
        stored &&
        previewImageType(stored) &&
        (await options.archive.getSetting!(setting)) === source
      )
        return stored;
      const previous = await coverDisk?.get(key);
      const bytes =
        previous &&
        previewImageType(previous) &&
        (await options.archive.getSetting!(`preview.cover-source.${providerId}`)) === source
          ? previous
          : await readCoverImage(source, abort);
      if (abort.aborted) throw new PreviewError('preview_cancelled');
      await publishCover(disk, providerId, bytes);
      await options.archive.setSetting!(setting, source);
      return bytes;
    };
    const work = (pending ? pending.then(load, load) : load()).finally(() => {
      if (defaultDownloads.get(key) === work) defaultDownloads.delete(key);
    });
    defaultDownloads.set(key, work);
    return work;
  };
  const fetchCover = async (
    id: string,
    abort: AbortSignal,
    background = false,
  ): Promise<Uint8Array | null> => {
    const broadcaster = await options.archive.getSubject(id, { activity: false });
    if (!broadcaster) {
      coverFailures.delete(id);
      observedSources.delete(id);
      versions.delete(id);
      return null;
    }
    const providerId = broadcaster.providerId,
      key = 'cover:' + providerId;
    const hit = cached(key);
    if (hit && !background) return hit;
    const local = hit ?? (await coverDisk?.get(key));
    const previous = local && previewImageType(local) ? local : null;
    let source: string | null = null;
    let qualification = '';
    let primaryFailure: { error: unknown } | undefined;
    try {
      const storedSource = coverSource(await options.archive.subjectPreview?.(id));
      source = observedSources.get(id) ?? storedSource;
      if (!source) {
        coverFailures.delete(id);
        if (previous) save(key, previous, 15000, true);
        return previous;
      }
      qualification = JSON.stringify([source, storedSource]);
      const failure = coverFailures.get(id);
      if (failure?.source === qualification && now() < failure.retryAt) return previous;
      const setting = 'preview.cover-source.' + providerId;
      const version = versions.get(id) ?? (await options.archive.getSetting?.(setting));
      if (previous && previewImageType(previous) && version === source) {
        versions.set(id, source);
        save(key, previous, 15000, true);
        coverFailures.delete(id);
        return previous;
      }
      let bytes: Uint8Array;
      try {
        bytes =
          source === storedSource
            ? await loadDefaultCover(providerId, source, abort)
            : await readCoverImage(source, abort);
      } catch (error) {
        if (abort.aborted || previous || !storedSource || storedSource === source) throw error;
        // An observed cover can be unavailable before its CDN update reaches this site.
        // Keep the last persisted cover from the same source while the retry is pending.
        reportCoverFailure(error, source);
        primaryFailure = { error };
        source = storedSource;
        bytes = await loadDefaultCover(providerId, source, abort);
      }
      if (!previewImageType(bytes)) throw new PreviewError('preview_failed');
      if (coverDisk) {
        await publishCover(coverDisk, providerId, bytes);
        await options.archive.setSetting?.(setting, source);
      }
      versions.set(id, source);
      save(key, bytes, 15000, true);
      if (primaryFailure) failCover(id, qualification, primaryFailure.error);
      else coverFailures.delete(id);
      return bytes;
    } catch (error) {
      if (abort.aborted) throw new PreviewError('preview_cancelled');
      failCover(id, qualification, error);
      reportCoverFailure(error, source);
      return previous;
    }
  };
  const downloadCover = (job: string): Promise<void> =>
    run(networkLane, undefined, async (abort) => {
      if (!job.startsWith('default:')) {
        await fetchCover(job, abort, true);
        return;
      }
      const id = job.slice('default:'.length);
      const providerId = await subject(id);
      const source = coverSource(await options.archive.subjectPreview?.(id));
      if (source) {
        const failure = coverFailures.get(job);
        if (failure?.source === source && now() < failure.retryAt) return;
        try {
          await loadDefaultCover(providerId, source, abort);
        } catch (error) {
          if (abort.aborted) throw new PreviewError('preview_cancelled');
          failCover(job, source, error);
          reportCoverFailure(error, source);
          return;
        }
      }
      coverFailures.delete(job);
      if (source && !observedSources.get(id) && versions.get(id) !== source)
        await fetchCover(id, abort, true);
    });
  const renderSnapshot = (
    id: string,
    at: number,
    signal?: AbortSignal,
    toMs?: number,
    onFrame?: (end: number, mediaIds: string[]) => void,
    cacheResult = true,
    unitId?: string,
    canonical?: SnapshotItem | null,
  ): Promise<Uint8Array> =>
    run(decoderLane, signal, async (abort) => {
      await subject(id);
      if (!Number.isSafeInteger(at) || at < 0) throw new PreviewError('preview_not_found');
      if (toMs !== undefined && (!Number.isSafeInteger(toMs) || toMs <= at || toMs - at > 86460000))
        throw new PreviewError('preview_not_found');
      const unit =
        canonical === undefined ? await options.archive.snapshotUnit?.(id, at, unitId) : canonical;
      unitId ??= unit?.unitId;
      if (unit?.unitId) {
        if (at < unit.slotFromMs || at >= unit.slotToMs)
          throw new PreviewError('preview_not_found');
        toMs = Math.min(toMs ?? unit.slotToMs, unit.slotToMs);
      }
      const initial = await covering(id, at, unitId),
        key = `snapshot:${id}:${unitId ?? ''}:${at}:${toMs ?? ''}:${initial.id}`;
      if (!(await options.archive.hasMedia(ids([initial]))))
        throw new PreviewError('preview_not_found');
      const hit = cacheResult ? cached(key) : null;
      if (hit && (await options.archive.hasMedia(cache.get(key)?.mediaIds ?? []))) {
        onFrame?.(
          cache.get(key)?.throughMs ?? toMs ?? Math.min(at + 500, initial.wallEndMs!),
          cache.get(key)?.mediaIds ?? [],
        );
        return hit;
      }
      const limit = toMs ?? Math.min(at + 500, initial.wallEndMs!);
      let cursor = at,
        prerollFrom = 0,
        isolate = false,
        malformed: SnapshotDecodeError | undefined;
      while (cursor < limit) {
        const selected =
          unitId && options.archive.unitSource
            ? await options.archive.unitSource(id, unitId, cursor)
            : await options.archive.locate(id, cursor, 'next');
        if (
          selected?.wallStartMs == null ||
          selected.wallEndMs == null ||
          selected.wallStartMs >= limit
        )
          break;
        const target = Math.max(cursor, selected.wallStartMs);
        const segments = [selected];
        let first = selected,
          last = selected;
        // Keep preroll inside the same continuous epoch; bound it by time and actual bytes below.
        while (
          !isolate &&
          segments.length < 599 &&
          !first.discontinuity &&
          first.wallStartMs !== null &&
          first.wallStartMs > 0 &&
          target - first.wallStartMs < 15000
        ) {
          const previous = await options.archive.locate(id, first.wallStartMs - 1, 'report');
          if (
            !previous ||
            previous.id === first.id ||
            previous.sourceEpoch !== first.sourceEpoch ||
            previous.initObjectId !== first.initObjectId ||
            previous.wallStartMs === null ||
            previous.wallStartMs < prerollFrom ||
            previous.wallEndMs !== first.wallStartMs ||
            target - previous.wallStartMs > 15000
          )
            break;
          segments.unshift(previous);
          first = previous;
        }
        // One following fragment flushes delayed decoder frames. Do not verify
        // the entire minute before asking for its first image; an empty attempt
        // advances to the next island below, retaining complete minute coverage.
        while (
          !isolate &&
          last.id === selected.id &&
          segments.length < 599 &&
          last.wallEndMs !== null &&
          last.wallEndMs < limit
        ) {
          const next =
            unitId && options.archive.unitSource
              ? await options.archive.unitSource(id, unitId, last.wallEndMs)
              : await options.archive.locate(id, last.wallEndMs, 'report');
          if (
            !next ||
            next.id === last.id ||
            next.discontinuity ||
            next.sourceEpoch !== last.sourceEpoch ||
            next.initObjectId !== last.initObjectId ||
            next.wallStartMs !== last.wallEndMs
          )
            break;
          segments.push(next);
          last = next;
        }
        let paths: string[] = [],
          usable = false;
        while (segments.length) {
          paths = [];
          let total = 0;
          usable = true;
          for (const objectId of ids(segments)) {
            const object = await options.archive.media(objectId);
            if (
              !object ||
              object.bytes >
                (objectId === selected.initObjectId ? 2 * 1024 * 1024 : 16 * 1024 * 1024) ||
              total + object.bytes > 24 * 1024 * 1024
            ) {
              usable = false;
              break;
            }
            total += object.bytes;
            paths.push(object.path);
          }
          if (usable) break;
          if (segments[0].id !== selected.id) segments.shift();
          else if (segments.length > 1) segments.pop();
          else break;
        }
        first = segments[0]!;
        last = segments.at(-1)!;
        if (usable) {
          const start = first.wallStartMs!,
            end = Math.min(limit, last.wallEndMs!);
          const emptyKey = JSON.stringify([id, target, start, end, ids(segments)]),
            emptyUntil = emptyWindows.get(emptyKey);
          let bytes: Uint8Array | undefined;
          if (emptyUntil === undefined || emptyUntil <= now()) {
            emptyWindows.delete(emptyKey);
            try {
              bytes = await decode({
                paths,
                offsetSeconds: (target - start) / 1000,
                endSeconds: (end - start) / 1000,
                signal: abort,
              });
            } catch (error) {
              if (abort.aborted) throw error;
              if (error instanceof SnapshotDecodeError && error.code === 'invalid_media') {
                // Separate a malformed fragment from its neighbors before giving up its frame.
                if (segments.length > 1) {
                  isolate = true;
                  continue;
                }
                malformed = error;
                prerollFrom = selected.wallStartMs + 1;
              } else if (error instanceof SnapshotDecodeError && error.code === 'no_frame') {
                while (emptyWindows.size >= 96)
                  emptyWindows.delete(emptyWindows.keys().next().value!);
                emptyWindows.set(emptyKey, now() + 30000);
              } else {
                const failure =
                  error instanceof SnapshotDecodeError ? error : new SnapshotDecodeError('failed');
                screenshotDiagnostics.record('screenshot_decode_failed', failure);
                throw new PreviewError(
                  failure.code === 'unavailable' ? 'preview_unavailable' : 'preview_failed',
                  { cause: failure },
                );
              }
            }
          }
          if (bytes) {
            if (
              (await covering(id, at, unitId)).id !== initial.id ||
              !(await options.archive.hasMedia(ids(segments)))
            )
              throw new PreviewError('preview_not_found');
            if (cacheResult) save(key, bytes, 30 * 60000, false, ids(segments), end);
            onFrame?.(end, ids(segments));
            return bytes;
          }
        }
        cursor = Math.max(target + 1, last.wallEndMs!);
        isolate = false;
      }
      if (malformed) {
        screenshotDiagnostics.record('screenshot_decode_failed', malformed);
        throw new PreviewError('preview_failed', { cause: malformed });
      }
      throw new PreviewError('preview_not_found');
    });
  let screenshotJobs: Promise<ScreenshotJobs> | undefined;
  // Readers observe the published instance; opening/recovery remains heartbeat-owned.
  let readyScreenshotJobs: ScreenshotJobs | undefined;
  let screenshotOpening = false;
  let coverStartedAt: number | null = null,
    coverSucceededAt: number | null = null;
  let screenshotRetryAt = Infinity;
  let detachScreenshotRecovery: (() => void) | undefined;
  const coverIssues = () => [...coverFailures.values()].filter((failure) => !failure.missing);
  const preview: PreviewsPort = {
    backgroundTasks: () => {
      const issues = coverIssues();
      const failed = issues.length;
      const rows: BackgroundTask[] = [
        {
          id: 'cover-sync',
          group: 'sync',
          state: backgroundWork
            ? 'running'
            : failed
              ? 'retrying'
              : pendingCoverCount()
                ? 'waiting'
                : options.cacheRoot
                  ? 'idle'
                  : 'disabled',
          pending: pendingCoverCount(),
          failed,
          consecutiveFailures: Math.max(0, ...issues.map((issue) => issue.consecutiveFailures)),
          lastRunAtMs: coverStartedAt,
          lastSuccessAtMs: coverSucceededAt,
          error: failed ? 'cover_refresh_partial' : null,
          nextRunAtMs: issues.length ? Math.min(...issues.map((value) => value.retryAt)) : null,
        },
      ];
      if (avatars) rows.push(avatars.status());
      if (readyScreenshotJobs) rows.push(readyScreenshotJobs.maintenanceStatus());
      else if (screenshotJobs)
        rows.push({
          id: 'snapshot-maintenance',
          group: 'processing',
          state: screenshotOpening ? 'waiting' : 'retrying',
          error: screenshotOpening ? null : 'screenshot_storage_unavailable',
          detail: screenshotOpening ? 'screenshot-storage-opening' : undefined,
          nextRunAtMs: Number.isFinite(screenshotRetryAt) ? screenshotRetryAt : null,
        });
      return Promise.resolve(rows);
    },
    retryCovers: async () => {
      await queueCovers(queueCoverRetries(true));
    },
    ...(avatars ? { retryAvatars: () => avatars.refresh() } : {}),
    retryScreenshots: async () => {
      await readyScreenshotJobs?.retry();
    },
    retryScreenshotMaintenance: async () => {
      if (readyScreenshotJobs) return readyScreenshotJobs.retryMaintenance();
      if (Number.isFinite(screenshotRetryAt)) openScreenshotStorage();
      await screenshotJobs;
    },
    avatar: async (id) => {
      const bytes = await avatars?.read(id);
      if (!bytes) throw new PreviewError('preview_not_found');
      return bytes;
    },
    snapshotPages: (id, at, page = 1, limit = 30, signal, window, followLive, unitId) =>
      run(queryLane, signal, async (abort) => {
        if (!options.archive.snapshotPages) throw new PreviewError('preview_unavailable');
        return options.archive.snapshotPages(
          id,
          at,
          page,
          limit,
          window,
          followLive,
          abort,
          unitId,
        );
      }),
    cover: (id, signal, cachedOnly = false) =>
      run(coverLane, signal, async (abort) => {
        const releaseRead = await coverReadBudget.acquire(abort);
        let local: { bytes: Uint8Array; stale: boolean } | null;
        try {
          const providerId = await subject(id),
            key = `cover:${providerId}`,
            hit = cached(key);
          if (hit) local = { bytes: hit, stale: false };
          else {
            const fresh = await coverDisk?.get(key, 15000);
            if (fresh && previewImageType(fresh)) local = { bytes: fresh, stale: false };
            else {
              const current = await coverDisk?.get(key);
              const stale =
                current && previewImageType(current) ? current : await defaultCoverDisk?.get(key);
              local = stale && previewImageType(stale) ? { bytes: stale, stale: true } : null;
            }
          }
        } finally {
          releaseRead();
        }
        if (local) {
          if (local.stale && !cachedOnly && !observedSources.has(id)) {
            pendingCovers.add(id);
            schedule();
          }
          return local.bytes;
        }
        if (cachedOnly) throw new PreviewError('preview_not_found');
        const releaseNetwork = await networkBudget.acquire(abort);
        try {
          const bytes = await fetchCover(id, abort);
          if (!bytes) throw new PreviewError('preview_not_found');
          return bytes;
        } finally {
          releaseNetwork();
        }
      }),
    snapshotPoint: (id, atMs, signal) =>
      run(queryLane, signal, async () => {
        if (!options.archive.snapshotUnit) throw new PreviewError('preview_unavailable');
        return options.archive.snapshotUnit(id, atMs);
      }),
    snapshot: async (id, at, signal, toMs, unitId) => {
      let canonical: SnapshotItem | null | undefined;
      if (unitId) {
        canonical = await options.archive.snapshotUnit?.(id, at, unitId);
        if (canonical?.atMs !== at) throw new PreviewError('preview_not_found');
      }
      if (!screenshotJobs) {
        if (options.cacheRoot) throw new PreviewError('preview_unavailable');
        return renderSnapshot(id, at, signal, toMs, undefined, true, unitId, canonical);
      }
      return run(imageReadLane, signal, async (abort) => {
        if (
          !Number.isSafeInteger(at) ||
          at < 0 ||
          (toMs !== undefined &&
            (!Number.isSafeInteger(toMs) || toMs <= at || toMs - at > 86460000))
        )
          throw new PreviewError('preview_not_found');
        if (canonical === undefined)
          canonical = await options.archive.snapshotUnit?.(id, at, unitId);
        unitId ??= canonical?.unitId;
        const initial = await covering(id, at, unitId);
        if (!(await options.archive.hasMedia(ids([initial]))))
          throw new PreviewError('preview_not_found');
        const jobs = await screenshotJobs!;
        if (abort.aborted) throw new PreviewError('preview_cancelled');
        const end = toMs ?? Math.min(at + 500, initial.wallEndMs!),
          hit = await jobs.read(id, at, end, unitId);
        if (hit) return hit;
        if (canonical?.atMs !== at || (await jobs.hasCompleted(id, at, unitId)))
          return renderSnapshot(id, at, abort, toMs, undefined, true, unitId, canonical);
        await jobs.enqueue(id, canonical, SNAPSHOT_REQUEST_PRIORITY);
        throw new PreviewError('preview_pending');
      });
    },
    jobs: () => {
      if (readyScreenshotJobs) return Promise.resolve(readyScreenshotJobs.status());
      return Promise.resolve(
        screenshotJobs
          ? {
              mode: screenshotOpening ? 'initializing' : 'unavailable',
              pending: 0,
              failed: 0,
              completed: 0,
              averageMs: 0,
              error: screenshotOpening ? undefined : 'screenshot_storage_unavailable',
            }
          : null,
      );
    },
    observeCover: (id, source) => {
      if (closed || !coverDisk || !/^stripchat:[1-9]\d*$/.test(id)) return;
      const safe = coverSource(source);
      if (
        observedSources.has(id) &&
        observedSources.get(id) === safe &&
        (safe === null ||
          versions.get(id) === safe ||
          (coverFailures.get(id)?.retryAt ?? 0) > now())
      )
        return;
      observedSources.set(id, safe);
      pendingCovers.add(id);
      schedule();
    },
    warmSubjectImages: async (ids) => {
      if (closed || !coverDisk) return;
      await Promise.all([queueCovers(ids.map((id) => `default:${id}`)), avatars?.warm(ids)]);
    },
    warmCovers: async (subjects) => {
      if (closed || !coverDisk) return;
      let ids = subjects;
      if (!ids) {
        ids = [];
        // Startup only fills holes. Existing live images wait for a real status
        // observation instead of briefly reverting to an older list preview.
        for (const row of await options.archive.listSubjects({ activity: false })) {
          const bytes = await coverDisk.get(`cover:${row.providerId}`);
          if (!bytes || !previewImageType(bytes)) ids.push(row.id);
        }
      }
      return queueCovers(ids);
    },
    close: () => {
      if (closing) return closing;
      closed = true;
      detachScreenshotRecovery?.();
      detachCoverRetry?.();
      clearTimeout(backgroundTimer);
      pendingCovers.clear();
      pendingDefaults.clear();
      for (const waiters of warmWaiters.values()) for (const resolve of waiters) resolve();
      warmWaiters.clear();
      observedSources.clear();
      versions.clear();
      for (const task of tasks) task.controller.abort();
      cache.clear();
      emptyWindows.clear();
      used = 0;
      closing = Promise.allSettled(
        [...tasks]
          .map((task) => task.done)
          .concat(
            backgroundWork ?? [],
            screenshotJobs ? screenshotJobs.then((jobs) => jobs.close()) : [],
          ),
      ).then(async () => {
        try {
          await coverDisk?.close();
          await defaultCoverDisk?.close();
          await avatars?.close();
        } finally {
          coverFailures.clear();
          coverDiagnostics.close();
          screenshotDiagnostics.close();
        }
      });
      return closing;
    },
  };
  const pendingCovers = new Set<string>(),
    pendingDefaults = new Set<string>(),
    pendingCoverCount = () => pendingCovers.size + pendingDefaults.size;
  const coverQueue = (job: string): Set<string> =>
    job.startsWith('default:') ? pendingDefaults : pendingCovers;
  let preferDefaults = false;
  const warmWaiters = new Map<string, Set<() => void>>();
  let backgroundTimer: ReturnType<typeof setTimeout> | undefined,
    backgroundWork: Promise<void> | undefined;
  const queueCovers = (ids: readonly string[]): Promise<void> => {
    if (closed) return Promise.resolve();
    const done = Promise.all(
      [...new Set(ids)].map((id) => {
        coverQueue(id).add(id);
        return new Promise<void>((resolve) => {
          const waiters = warmWaiters.get(id) ?? new Set<() => void>();
          waiters.add(resolve);
          warmWaiters.set(id, waiters);
        });
      }),
    ).then(() => undefined);
    backgroundTimer?.ref();
    schedule();
    return done;
  };
  function queueCoverRetries(manual = false): string[] {
    const queued: string[] = [];
    if (closed) return queued;
    const time = now();
    for (const [id, failure] of coverFailures) {
      const queue = coverQueue(id);
      if (failure.missing || (!manual && (queue.has(id) || failure.retryAt > time))) continue;
      if (manual) failure.retryAt = time;
      queue.add(id);
      queued.push(id);
      // A heartbeat admits one batch. A manual request owns all of its queued
      // work, which still runs under the ordinary batch and network limits.
      if (!manual && queued.length === (options.networkConcurrency ?? 2)) break;
    }
    schedule();
    return queued;
  }
  const detachCoverRetry = options.clock?.subscribe('cover-retry', () => {
    queueCoverRetries();
  });
  const schedule = (): void => {
    if (closed || backgroundTimer || backgroundWork) return;
    if (!pendingCoverCount()) return;
    backgroundTimer = setTimeout(() => {
      backgroundTimer = undefined;
      const ids: string[] = [];
      // Roster batches can be large; interleave them with live cover observations.
      while (ids.length < (options.networkConcurrency ?? 2) && pendingCoverCount()) {
        const useDefaults = pendingDefaults.size > 0 && (preferDefaults || !pendingCovers.size);
        const queue = useDefaults ? pendingDefaults : pendingCovers;
        const id = queue.values().next().value!;
        queue.delete(id);
        ids.push(id);
        preferDefaults = !useDefaults;
      }
      coverStartedAt = now();
      const batchWaiters = ids.map((id) => {
        const waiters = warmWaiters.get(id);
        warmWaiters.delete(id);
        return waiters;
      });
      const download = () => Promise.allSettled(ids.map((id) => downloadCover(id)));
      backgroundWork = Promise.resolve()
        .then(() => options.archive.withBackgroundReads?.(download) ?? download())
        .then((results) => {
          for (const [index, result] of results.entries()) {
            if (result.status !== 'rejected' || closed) continue;
            // fetchCover owns source failures. Preserve diagnostics for admission,
            // subject/RPC failures before it enters that boundary; deleted subjects
            // and caller cancellation are normal, not background I/O failures.
            if (
              result.reason instanceof PreviewError &&
              ['preview_not_found', 'preview_cancelled'].includes(result.reason.code)
            )
              continue;
            coverDiagnostics.record(
              'cover_background_failed',
              result.reason instanceof Error
                ? (result.reason.cause ?? result.reason)
                : result.reason,
            );
            failCover(ids[index], '', result.reason);
          }
          if (!coverIssues().length && !closed) coverSucceededAt = now();
        })
        .catch((error: unknown) => {
          if (closed) return;
          for (const id of ids) failCover(id, '', error);
          coverDiagnostics.record('cover_background_failed', error);
        })
        .finally(() => {
          for (const waiters of batchWaiters) for (const resolve of waiters ?? []) resolve();
          backgroundWork = undefined;
          schedule();
        });
    }, 20);
    // Explicit synchronization callers own this work until their images settle.
    if (!warmWaiters.size) backgroundTimer.unref();
  };
  function openScreenshotStorage(): void {
    if (closed || !options.cacheRoot || !options.archive.snapshotUnit) return;
    screenshotRetryAt = Infinity;
    screenshotOpening = true;
    screenshotJobs = ScreenshotJobs.open({
      root: path.join(options.cacheRoot, 'screenshots'),
      mediaRoot: options.mediaRoot,
      archive: options.archive,
      canGenerate: options.canGenerate,
      concurrency: options.decoderConcurrency,
      render: async (job, signal) => {
        let throughMs = job.end,
          mediaIds: string[] = [];
        const bytes = await renderSnapshot(
          job.subject,
          job.at,
          signal,
          job.end,
          (end, dependencies) => {
            throughMs = end;
            mediaIds = dependencies;
          },
          false,
          job.unit,
        );
        return { bytes, throughMs, mediaIds };
      },
      validate:
        options.validateSnapshot ??
        ((bytes, signal) => verifyJpeg(bytes, signal, { ffmpegPath: options.ffmpegPath })),
    });
    void screenshotJobs.then(
      (jobs) => {
        readyScreenshotJobs = jobs;
        screenshotOpening = false;
      },
      (error: unknown) => {
        screenshotOpening = false;
        screenshotRetryAt = now() + 30000;
        console.error(
          'Screenshot jobs unavailable; retry in 30s',
          error instanceof Error ? error.name : 'unknown',
        );
      },
    );
  }
  function retryScreenshotStorage(): void {
    if (!closed && now() >= screenshotRetryAt) openScreenshotStorage();
  }
  if (options.cacheRoot && options.archive.snapshotUnit) {
    openScreenshotStorage();
    detachScreenshotRecovery = options.clock?.subscribe(
      'screenshot-storage-recovery',
      retryScreenshotStorage,
    );
  }
  if (options.cacheRoot)
    void preview
      .warmCovers?.()
      .catch((error) =>
        console.warn(
          'Cover startup warming failed',
          error instanceof Error ? error.name : 'unknown',
        ),
      );
  return preview;
}
