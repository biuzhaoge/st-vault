import { accountSiteOrigin } from '../provider/site-routes.js';
import { createHash } from 'node:crypto';
import { runBackground } from '../runtime/background.js';
import { redactLog } from '../runtime/runtime-logs.js';
import { z } from 'zod';
import { accountSyncConfigSchema } from '@st-vault/api-schema';
import type { AccountSyncConfig, AccountSyncResult, AccountSyncStatus } from '@st-vault/api-schema';
import type {
  AccountSyncPort,
  ArchivePort,
  ProviderPort,
  SubjectInput,
  SupervisorPort,
  UnfollowedSubjectResult,
} from '../ports.js';
import type { KeyVault } from '../http/key-vault.js';
import { createHttp, ProviderError, waitFor } from '../provider/http.js';
import { accountAvatarSource } from '../provider/account-profile.js';
import type { ImportedAccountProfile } from '../provider/account-profile.js';
import { previewImageType } from '../previews/image-type.js';
import type { SyncClock } from '../runtime/sync-clock.js';
import { AccountActivation, type AccountActivationArchive } from './account-activation.js';
import type { ArchiveReasonProbe, OpenArchiveReasonProbe } from './archive-reasons.js';

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const archivedRecoveryBatch = 4;
const profileRefreshIntervalMs = 5 * 60_000;
const errorCodes = [
  'cookies_invalid',
  'cookies_domain_mismatch',
  'account_origin_invalid',
  'account_origin_redirect',
  'cookies_expired',
  'account_access_denied',
  'account_network_unavailable',
  'account_verification_required',
  'list_import_failed',
  'account_sync_timeout',
  'account_sync_unavailable',
  'account_library_changed',
] as const;
const storedProfileSchema = z
  .object({
    username: z.string().trim().min(1).max(256),
    followingCount: z.number().int().min(0).max(10000000),
    avatarSourceUrl: z.string().max(2048).nullable(),
  })
  .strict();
const storedSchema = z
  .object({
    version: z.literal(1),
    cookiesText: z.string().min(1).max(65536),
    origin: z.string().url().optional(),
    lastAttemptMs: timestamp,
    lastSuccessMs: timestamp,
    lastImportedCount: z.number().int().nonnegative().nullable(),
    error: z.enum(errorCodes).nullable(),
    needsReconnect: z.boolean(),
    profile: storedProfileSchema.nullable(),
  })
  .strict();
type Stored = z.infer<typeof storedSchema>;
type FailureCode =
  | (typeof errorCodes)[number]
  | 'account_sync_disconnected'
  | 'account_sync_busy'
  | 'account_sync_cancelled'
  | 'account_unfollow_subject_missing'
  | 'account_unfollow_protected'
  | 'account_unfollow_account_changed'
  | 'account_unfollow_failed'
  | 'account_origin_locked';
export class AccountSyncError extends Error {
  constructor(
    readonly code: FailureCode,
    cause?: unknown,
  ) {
    super(code, cause === undefined ? undefined : { cause });
  }
}
export function accountUnfollowBinding(status: AccountSyncStatus): string | undefined {
  if (!status.connected || !status.origin || !status.profile || status.needsReconnect) return;
  return createHash('sha256')
    .update(JSON.stringify([status.origin, status.profile.username.toLowerCase()]))
    .digest('hex');
}
interface Job {
  generation: number;
  controller: AbortController;
  kind: 'configure' | 'refresh' | 'disconnect' | 'recover' | 'unfollow';
  work: Promise<AccountSyncResult>;
  timedOut: boolean;
  accepted: boolean;
}
export interface AccountSyncOptions {
  clock: SyncClock;
  origin?: string;
  onImported?: (subjectIds: string[]) => void | Promise<void>;
  archive: AccountActivationArchive &
    Pick<
      ArchivePort,
      | 'followedAccountSubjects'
      | 'archivedAccountSubjects'
      | 'recordVerifiedUnfollowed'
      | 'recordVerifiedBlocked'
      | 'recordManualUnfollow'
      | 'addIndexedAccountSubjects'
    >;
  provider: Pick<ProviderPort, 'importList' | 'importAccount' | 'unfollowAccountSubject'> & {
    openArchiveReasonProbe?: (
      cookiesText: string,
      origin: string,
      username: string | undefined,
      signal: AbortSignal,
    ) => Promise<ArchiveReasonProbe>;
  };
  supervisor: Pick<SupervisorPort, 'reconcile'>;
  vault: Pick<KeyVault, 'readSealedSecret' | 'writeSealedSecret'>;
  now?: () => number;
  timeoutMs?: number;
  startupDelayMs?: number;
  fetch?: typeof globalThis.fetch;
  transportSignal?: () => AbortSignal;
}
export interface AccountSyncService extends AccountSyncPort {
  avatar(signal?: AbortSignal): Promise<Uint8Array>;
  unfollow(id: string, binding: string, signal?: AbortSignal): Promise<void>;
  openArchiveReasonProbe: OpenArchiveReasonProbe;
}
function failure(error: unknown): (typeof errorCodes)[number] {
  if (error instanceof Error && error.message === 'ACCOUNT_ACTIVATION_LIBRARY_MISMATCH')
    return 'account_library_changed';
  if (error instanceof ProviderError) {
    if (error.code === 'upstream-request') return 'account_network_unavailable';
    if (error.code === 'request-deadline') return 'account_sync_timeout';
    if (error.challenge) return 'account_verification_required';
    if (error.code === 'cookies-domain-mismatch') return 'cookies_domain_mismatch';
    if (error.code === 'account-redirect-denied') return 'account_origin_redirect';
    if (['invalid-cookies', 'no-applicable-cookies'].includes(error.code)) return 'cookies_invalid';
    if (error.code === 'account-session-unavailable' || error.status === 401)
      return 'cookies_expired';
    if (error.code === 'upstream-http' && error.status === 403) return 'account_access_denied';
  }
  return error instanceof AccountSyncError &&
    errorCodes.includes(error.code as (typeof errorCodes)[number])
    ? (error.code as (typeof errorCodes)[number])
    : 'list_import_failed';
}

/** One persisted account, one actual importer, and bounded scheduling across restarts. */
export async function createAccountSync(options: AccountSyncOptions): Promise<AccountSyncService> {
  const defaultOrigin = accountSiteOrigin(options.origin);
  const now = options.now ?? Date.now,
    timeoutMs = options.timeoutMs ?? 120000,
    startupDelayMs = options.startupDelayMs ?? 10000;
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isFinite(startupDelayMs) ||
    startupDelayMs < 1
  )
    throw new Error('INVALID_ACCOUNT_SYNC_OPTIONS');
  let closed = false,
    generation = 0,
    notBeforeMs = 0,
    nextAttemptMs: number | null = null;
  let tail: Promise<unknown> = Promise.resolve(),
    active: Job | undefined,
    closing: Promise<void> | undefined;
  const jobs = new Set<Job>();
  const listeners = new Set<(topic?: 'subjects') => void>();
  const notify = (topic?: 'subjects'): void => {
    for (const listener of listeners) listener(topic);
  };
  let lastProfileRefreshMs: number | null = null;
  const warming = new Set<Promise<void>>();
  let stage: AccountSyncStatus['stage'];
  const warmImages = (ids: string[]): void => {
    if (!options.onImported || closed) return;
    const work = Promise.resolve()
      .then(() => {
        if (!closed) return options.onImported!(ids);
      })
      .catch((error: unknown) => {
        console.warn(
          'Imported image warming failed',
          error instanceof Error ? error.name : 'unknown',
        );
      })
      .finally(() => {
        warming.delete(work);
        if (!warming.size) notify();
      });
    warming.add(work);
    notify();
  };
  const avatarHttp = createHttp({
    fetch: options.fetch,
    timeoutMs: 5000,
    allow: (url) => accountAvatarSource(url.href) !== null,
  });
  interface AvatarTask {
    key: string;
    controller: AbortController;
    done: Promise<Uint8Array>;
  }
  const avatarTasks = new Set<AvatarTask>();
  let avatarPending: AvatarTask | undefined,
    avatarCache: { key: string; bytes: Uint8Array; expires: number } | undefined;
  const avatarKey = (): string =>
    connection.active?.profile
      ? JSON.stringify([
          connection.active.profile.username,
          connection.active.profile.avatarSourceUrl,
        ])
      : '';
  const clearAvatar = (): void => {
    avatarCache = undefined;
    avatarPending = undefined;
    for (const task of avatarTasks) task.controller.abort();
  };
  const empty = (): Omit<AccountSyncStatus, 'connected' | 'running' | 'nextAttemptMs'> => ({
    needsReconnect: false,
    lastAttemptMs: null,
    lastSuccessMs: null,
    lastImportedCount: null,
    error: null,
  });
  let state = empty();
  let consecutiveFailures = 0;
  let pendingMissingCount = 0;
  let favoritesIndexCount: number | undefined;
  let pendingProfileCount = 0;
  let archivedRecoveryCursor = 0;
  const adopt = (value: Stored): void => {
    state = {
      needsReconnect: value.needsReconnect,
      lastAttemptMs: value.lastAttemptMs,
      lastSuccessMs: value.lastSuccessMs,
      lastImportedCount: value.lastImportedCount,
      error: value.error,
    };
  };
  let committedAvatarKey = '';
  const connection = new AccountActivation<Stored>({
    archive: options.archive,
    vault: options.vault,
    parse: (value) => {
      const parsed = storedSchema.parse(value);
      return { ...parsed, origin: accountSiteOrigin(parsed.origin ?? defaultOrigin) };
    },
    changed: () => {
      if (connection.active) adopt(connection.active);
      else state = empty();
      const nextAvatarKey = avatarKey();
      if (nextAvatarKey !== committedAvatarKey) clearAvatar();
      committedAvatarKey = nextAvatarKey;
      notify();
    },
  });
  try {
    await connection.load();
    if (connection.recovering) await connection.recover();
  } catch (error) {
    state = {
      ...state,
      error:
        failure(error) === 'account_library_changed'
          ? 'account_library_changed'
          : 'account_sync_unavailable',
      needsReconnect: failure(error) === 'account_library_changed' || !connection.recovering,
    };
  }
  const status = (): AccountSyncStatus => ({
    origin: connection.active?.origin ?? defaultOrigin,
    ...state,
    ...(stage ? { stage } : {}),
    ...(warming.size ? { warmingCovers: true } : {}),
    ...(pendingMissingCount ? { pendingMissingCount } : {}),
    ...(favoritesIndexCount === undefined ? {} : { favoritesIndexCount }),
    ...(pendingProfileCount ? { pendingProfileCount } : {}),
    profile: connection.active?.profile
      ? {
          username: connection.active.profile.username,
          followingCount: connection.active.profile.followingCount,
          avatarUrl: accountAvatarSource(connection.active.profile.avatarSourceUrl)
            ? `/api/account-sync/avatar?version=${createHash('sha256')
                .update(connection.active.profile.avatarSourceUrl ?? '')
                .digest('hex')
                .slice(0, 16)}`
            : null,
        }
      : null,
    connected: connection.active !== null,
    running: jobs.size > 0,
    nextAttemptMs,
    consecutiveFailures,
  });
  const clearSchedule = (): void => {
    nextAttemptMs = null;
  };
  const dueAt = (): number =>
    Math.max(
      notBeforeMs,
      Math.max(
        connection.active?.lastAttemptMs ?? 0,
        connection.active?.lastSuccessMs ?? 0,
        state.lastAttemptMs ?? 0,
        state.lastSuccessMs ?? 0,
      ) + options.clock.intervalMs(),
    );
  const schedule = (startup = false): void => {
    clearSchedule();
    if (connection.recovering && state.error === 'account_library_changed') return;
    if (!closed && !jobs.size && connection.recovering) {
      nextAttemptMs = now() + options.clock.intervalMs();
      return;
    }
    if (closed || jobs.size || !connection.active || state.needsReconnect) return;
    // At most one network attempt per configured interval. Restarting never
    // bypasses the persisted attempt time; overdue startup waits a short grace.
    notBeforeMs = now() + (startup ? startupDelayMs : 1000);
    nextAttemptMs = dueAt();
  };
  const valid = (job: Job): void => {
    if (job.accepted) return;
    if (closed || job.generation !== generation || job.controller.signal.aborted)
      throw new AccountSyncError(job.timedOut ? 'account_sync_timeout' : 'account_sync_cancelled');
  };
  const invalidate = (): number => {
    generation++;
    clearSchedule();
    for (const job of jobs) if (!job.accepted) job.controller.abort();
    return generation;
  };
  const persist = async (value: Stored, job: Job): Promise<void> => {
    valid(job);
    try {
      await connection.update(value);
    } catch (error) {
      throw new AccountSyncError('account_sync_unavailable', error);
    }
    // The serialized vault write is the commit point. Cancellation cannot undo
    // an accepted durable write: adopt it before checking the generation again.
    // Later queued mutations therefore start from the same value as a restart.
    valid(job);
  };
  const launch = (
    kind: Job['kind'],
    number: number,
    run: (job: Job) => Promise<number | null>,
  ): Job => {
    const reportFailure = (code: (typeof errorCodes)[number]): void => {
      // A rejected candidate never replaced the saved credentials. Status belongs
      // to that committed connection; the caller receives the candidate's error.
      if (connection.recovering)
        state = { ...state, error: code, needsReconnect: code === 'account_library_changed' };
      else if (kind === 'configure' && connection.active) adopt(connection.active);
      else if (kind !== 'unfollow') state = { ...state, error: code };
    };
    const job: Job = {
      kind,
      generation: number,
      controller: new AbortController(),
      timedOut: false,
      accepted: false,
      work: Promise.resolve({ imported: null, status: status() }),
    };
    const work = tail
      .catch(() => undefined)
      .then(async () => {
        valid(job);
        if (connection.recovering && kind !== 'disconnect') {
          try {
            await connection.recover();
          } catch (error) {
            throw new AccountSyncError(
              failure(error) === 'account_library_changed'
                ? 'account_library_changed'
                : 'account_sync_unavailable',
              error,
            );
          }
          valid(job);
        }
        const deadline = setTimeout(() => {
          if (job.accepted) return;
          job.timedOut = true;
          if (!closed && job.generation === generation) reportFailure('account_sync_timeout');
          job.controller.abort();
        }, timeoutMs);
        try {
          const imported = await run(job);
          valid(job);
          return { imported, status: { ...status(), running: false } };
        } catch (error) {
          if (!closed && job.generation === generation) {
            const code = job.controller.signal.aborted
              ? job.timedOut
                ? 'account_sync_timeout'
                : 'account_sync_cancelled'
              : error instanceof AccountSyncError && error.code === 'account_sync_cancelled'
                ? error.code
                : failure(error);
            if (code !== 'account_sync_cancelled') reportFailure(code);
            else if (connection.active && !connection.recovering) adopt(connection.active);
          }
          if (error instanceof AccountSyncError) throw error;
          throw new AccountSyncError(failure(error));
        } finally {
          clearTimeout(deadline);
        }
      });
    jobs.add(job);
    active = job;
    // Keep ownership until actual work settles, even when a caller/deadline
    // has already stopped waiting for an importer which ignores cancellation.
    job.work = work
      .then(
        (result) => {
          if ((job.generation === generation || job.accepted) && kind !== 'unfollow')
            consecutiveFailures = 0;
          return result;
        },
        (error: unknown) => {
          if (
            !closed &&
            job.generation === generation &&
            (kind === 'refresh' || kind === 'recover') &&
            !(error instanceof AccountSyncError && error.code === 'account_sync_cancelled')
          )
            consecutiveFailures++;
          throw error;
        },
      )
      .finally(() => {
        jobs.delete(job);
        if (active === job) active = undefined;
        if (job.generation === generation) stage = undefined;
        notify();
        if (job.generation === generation || !jobs.size) schedule();
      });
    tail = job.work.catch(() => undefined);
    return job;
  };
  const wait = async (
    job: Job,
    signal?: AbortSignal,
    cancelOwner = false,
  ): Promise<AccountSyncResult> => {
    const cancel = (): void => {
      if (cancelOwner && !job.accepted) job.controller.abort();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const result = await waitFor(waitFor(job.work, job.controller.signal), signal);
      return { imported: result.imported, status: status() };
    } catch (error) {
      if (job.controller.signal.aborted || signal?.aborted)
        throw new AccountSyncError(
          job.timedOut ? 'account_sync_timeout' : 'account_sync_cancelled',
        );
      if (error instanceof AccountSyncError) throw error;
      throw new AccountSyncError('list_import_failed');
    } finally {
      signal?.removeEventListener('abort', cancel);
    }
  };
  const available = (): void => {
    if (closed) throw new AccountSyncError('account_sync_unavailable');
    if (jobs.size >= 8) throw new AccountSyncError('account_sync_busy');
  };
  const synchronize = async (
    job: Job,
    cookiesText: string,
    replacing: boolean,
    origin = connection.active?.origin ?? defaultOrigin,
    forceProfiles = true,
  ): Promise<number> => {
    const transport = options.transportSignal?.();
    const signal = transport
      ? AbortSignal.any([job.controller.signal, transport])
      : job.controller.signal;
    const validImport = (): void => {
      valid(job);
      if (transport?.aborted) throw new AccountSyncError('account_sync_cancelled');
    };
    const attempt = now();
    const previous = connection.active;
    const priorError = previous?.error;
    const previousUsername = previous?.profile?.username.toLowerCase();
    const changedOwner = (username: string): boolean =>
      replacing && previousUsername !== undefined && previousUsername !== username.toLowerCase();
    const verifyOwner = (username: string): void => {
      if (!replacing && previousUsername && previousUsername !== username.toLowerCase())
        throw new ProviderError('upstream-identity-mismatch');
    };
    const refreshProfiles =
      forceProfiles ||
      lastProfileRefreshMs === null ||
      attempt < lastProfileRefreshMs ||
      attempt - lastProfileRefreshMs >= profileRefreshIntervalMs;
    let nextRecoveryCursor = archivedRecoveryCursor;
    stage = options.provider.importAccount ? 'validating' : 'syncing';
    notify();
    state = { ...state, lastAttemptMs: attempt, error: null };
    if (!replacing && connection.active)
      await persist({ ...connection.active, lastAttemptMs: attempt }, job);
    let indexCount: number | undefined,
      verifiedFollowingCount: number | undefined,
      unresolvedProfileCount = 0,
      unverifiedMissingCount = 0,
      recoveredArchivedCount = 0,
      subjects: SubjectInput[],
      profile: ImportedAccountProfile | null = !replacing
        ? (connection.active?.profile ?? null)
        : null;
    try {
      validImport();
      if (options.provider.importAccount) {
        const result = await options.provider.importAccount(
          cookiesText,
          signal,
          () => {
            validImport();
            stage = 'syncing';
            notify();
          },
          origin,
          async (username) => {
            validImport();
            if (changedOwner(username)) return [];
            return await options.archive.followedAccountSubjects(true);
          },
          async (username, indexedIds) => {
            validImport();
            const readIndexed = () =>
              indexedIds?.length
                ? options.archive.archivedAccountSubjects(0, archivedRecoveryBatch, indexedIds)
                : [];
            if (changedOwner(username)) return await readIndexed();
            const readCandidates = (cursor: number) =>
              options.archive.archivedAccountSubjects(cursor, archivedRecoveryBatch);
            const [page, indexed] = await Promise.all([
              readCandidates(archivedRecoveryCursor),
              readIndexed(),
            ]);
            const candidates =
              page.length || !archivedRecoveryCursor ? page : await readCandidates(0);
            nextRecoveryCursor =
              candidates.length === archivedRecoveryBatch
                ? (candidates.at(-1)?.providerId ?? 0)
                : 0;
            const roster = new Map(candidates.map((row) => [row.providerId, row]));
            for (const row of indexed) roster.set(row.providerId, row);
            return [...roster.values()];
          },
          {
            refreshProfiles,
            onIndexed: replacing
              ? undefined
              : async ({ profile, indexedIds }) => {
                  validImport();
                  verifyOwner(storedProfileSchema.parse(profile).username);
                  const { addIndexedAccountSubjects } = options.archive;
                  if (!previousUsername || !addIndexedAccountSubjects || !indexedIds.length) return;
                  const activation = await options.archive.accountActivation();
                  validImport();
                  if (!activation) return;
                  const added = await addIndexedAccountSubjects.call(
                    options.archive,
                    indexedIds,
                    activation,
                    signal,
                  );
                  if (added) notify('subjects');
                  validImport();
                },
          },
        );
        subjects = result.subjects;
        indexCount = result.indexCount;
        verifiedFollowingCount = result.verifiedFollowingCount;
        unresolvedProfileCount = result.unresolvedProfileCount ?? 0;
        unverifiedMissingCount = result.unverifiedMissingCount ?? 0;
        recoveredArchivedCount = result.recoveredArchivedCount ?? 0;
        profile = storedProfileSchema.parse(result.profile);
        verifyOwner(profile.username);
        profile.avatarSourceUrl = accountAvatarSource(profile.avatarSourceUrl);
      } else subjects = await options.provider.importList(cookiesText, signal);
    } catch (error) {
      validImport();
      const code = failure(error);
      console.warn(
        JSON.stringify({ event: 'account_sync_failed', origin, code, operation: job.kind }),
      );
      if (!replacing && connection.active)
        await persist(
          {
            ...connection.active,
            lastAttemptMs: attempt,
            error: code,
            needsReconnect:
              connection.active.needsReconnect ||
              [
                'cookies_expired',
                'cookies_invalid',
                'cookies_domain_mismatch',
                'account_origin_redirect',
                'account_verification_required',
              ].includes(code),
          },
          job,
        );
      throw new AccountSyncError(code);
    }
    validImport();
    stage = 'saving';
    notify();
    const imported = verifiedFollowingCount ?? subjects.length - unverifiedMissingCount;
    let activatedGeneration: string;
    try {
      activatedGeneration = await connection.activate(
        subjects,
        {
          version: 1,
          origin,
          cookiesText,
          lastAttemptMs: attempt,
          lastSuccessMs: now(),
          lastImportedCount: imported,
          error: null,
          needsReconnect: false,
          profile,
        },
        validImport,
        () => {
          job.accepted = true;
        },
        {
          resetUnfollows:
            replacing && (!previousUsername || !profile || changedOwner(profile.username)),
        },
      );
    } catch (error) {
      if (error instanceof AccountSyncError) throw error;
      throw new AccountSyncError('account_sync_unavailable', error);
    }
    if (refreshProfiles) lastProfileRefreshMs = attempt;
    const finishUnfollow = options.archive.recordVerifiedUnfollowed;
    if (finishUnfollow) {
      for (const subject of subjects) {
        if (!subject.accountUnfollowConfirmed) continue;
        try {
          await finishUnfollow.call(options.archive, subject.id, activatedGeneration);
        } catch (error) {
          // The roster is already committed. The archive heartbeat can retry the cleanup.
          console.warn(
            JSON.stringify({ event: 'account_unfollow_cleanup_deferred', error: redactLog(error) }),
          );
        }
      }
    }
    archivedRecoveryCursor = profile && changedOwner(profile.username) ? 0 : nextRecoveryCursor;
    if (
      indexCount !== favoritesIndexCount ||
      unresolvedProfileCount !== pendingProfileCount ||
      unverifiedMissingCount !== pendingMissingCount ||
      recoveredArchivedCount
    )
      console.info(
        JSON.stringify({
          event: 'account_roster_reconciled',
          origin,
          directoryRows: subjects.length,
          verifiedFollowing: imported,
          pending: unverifiedMissingCount,
          ...(indexCount === undefined ? {} : { favoritesIndexCount: indexCount }),
          pendingProfiles: unresolvedProfileCount,
          ...(recoveredArchivedCount ? { recoveredArchived: recoveredArchivedCount } : {}),
        }),
      );
    pendingMissingCount = unverifiedMissingCount;
    favoritesIndexCount = indexCount;
    pendingProfileCount = unresolvedProfileCount;
    if (priorError)
      console.info(
        JSON.stringify({ event: 'account_sync_recovered', origin, previousError: priorError }),
      );
    runBackground(options.supervisor.reconcile(), 'account_reconcile_failed');
    warmImages(subjects.map((subject) => subject.id));
    return imported;
  };
  function refresh(signal?: AbortSignal, forceProfiles = true): Promise<AccountSyncResult> {
    try {
      available();
      if (signal?.aborted) throw new AccountSyncError('account_sync_cancelled');
      if (active?.kind === 'refresh' && active.generation === generation)
        return wait(active, signal);
      if (jobs.size) throw new AccountSyncError('account_sync_busy');
      if (!connection.active) throw new AccountSyncError('account_sync_disconnected');
      clearSchedule();
      const current = connection.active;
      return wait(
        launch('refresh', generation, (job) =>
          synchronize(job, current.cookiesText, false, current.origin, forceProfiles),
        ),
        signal,
      );
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new AccountSyncError('list_import_failed'),
      );
    }
  }
  async function unfollow(id: string, binding: string, signal?: AbortSignal): Promise<void> {
    available();
    if (signal?.aborted) throw new AccountSyncError('account_sync_cancelled');
    const saved = connection.active;
    if (!saved?.profile) throw new AccountSyncError('account_sync_disconnected');
    if (saved.needsReconnect) throw new AccountSyncError('cookies_expired');
    if (binding !== accountUnfollowBinding(status()))
      throw new AccountSyncError('account_unfollow_account_changed');
    const username = saved.profile.username.toLowerCase();
    const { recordManualUnfollow } = options.archive;
    const { unfollowAccountSubject } = options.provider;
    if (!recordManualUnfollow || !unfollowAccountSubject)
      throw new AccountSyncError('account_sync_unavailable');

    clearSchedule();
    const job = launch('unfollow', generation, async (job) => {
      const current = connection.active;
      if (
        !current?.origin ||
        current.origin !== saved.origin ||
        current.profile?.username.toLowerCase() !== username
      )
        throw new AccountSyncError('account_sync_cancelled');
      const origin = current.origin;
      if (current.needsReconnect) throw new AccountSyncError('cookies_expired');
      const activation = await options.archive.accountActivation();
      if (!activation) throw new AccountSyncError('account_sync_unavailable');
      const transport = options.transportSignal?.();
      const signal = transport
        ? AbortSignal.any([job.controller.signal, transport])
        : job.controller.signal;
      try {
        const result = await recordManualUnfollow.call(
          options.archive,
          id,
          activation,
          async () => {
            valid(job);
            if (signal.aborted) throw new AccountSyncError('account_sync_cancelled');
            await unfollowAccountSubject.call(
              options.provider,
              current.cookiesText,
              origin,
              username,
              Number(id.slice('stripchat:'.length)),
              signal,
            );
            // Once the upstream change is acknowledged, finish the local update even if the client leaves.
            job.accepted = true;
          },
        );
        if (result === 'missing') throw new AccountSyncError('account_unfollow_subject_missing');
        if (result === 'stale') throw new AccountSyncError('account_unfollow_protected');
      } catch (error) {
        if (error instanceof AccountSyncError) throw error;
        const code = failure(error);
        throw new AccountSyncError(
          code === 'list_import_failed' ? 'account_unfollow_failed' : code,
          error,
        );
      }
      runBackground(options.supervisor.reconcile(), 'account_reconcile_failed');
      return null;
    });
    await wait(job, signal, true);
  }
  function withBlockedCleanup(
    probe: ArchiveReasonProbe,
    saved: Stored,
    bindingSignal: AbortSignal,
  ): ArchiveReasonProbe {
    const { recordVerifiedBlocked } = options.archive;
    const { unfollowBlocked } = probe;
    if (!unfollowBlocked || !recordVerifiedBlocked || !saved.profile) return probe;
    const username = saved.profile.username.toLowerCase();
    const sameBinding = (current: Stored | null): boolean =>
      current !== null &&
      current.origin === saved.origin &&
      current.cookiesText === saved.cookiesText &&
      current.profile?.username.toLowerCase() === username &&
      !current.needsReconnect;
    const cleanupBlocked: NonNullable<ArchiveReasonProbe['cleanupBlocked']> = async (
      id,
      providerId,
      signal,
    ) => {
      const request = AbortSignal.any([bindingSignal, signal]);
      if (
        closed ||
        request.aborted ||
        !sameBinding(connection.active) ||
        id !== `stripchat:${providerId}`
      )
        return 'stale';
      if (jobs.size >= 8) throw new ProviderError('archive-unfollow-busy');
      let result: UnfollowedSubjectResult = 'stale';
      clearSchedule();
      const job = launch('unfollow', generation, async (job) => {
        if (!sameBinding(connection.active)) return null;
        const activation = await options.archive.accountActivation();
        valid(job);
        if (!activation) return null;
        const transport = options.transportSignal?.();
        const operation = AbortSignal.any(
          transport
            ? [job.controller.signal, request, transport]
            : [job.controller.signal, request],
        );
        if (operation.aborted) return null;
        try {
          result = await recordVerifiedBlocked.call(options.archive, id, activation, async () => {
            valid(job);
            if (operation.aborted) throw new ProviderError('cancelled');
            await unfollowBlocked.call(probe, providerId, operation);
            // Publish the upstream acknowledgement even if the initiating probe is cancelled.
            job.accepted = true;
          });
        } catch (error) {
          if (error instanceof AccountSyncError) throw error;
          throw new AccountSyncError('account_unfollow_failed', error);
        }
        return null;
      });
      try {
        await wait(job, request, true);
      } catch (error) {
        if (error instanceof AccountSyncError) {
          if (error.code === 'account_sync_cancelled') return 'stale';
          if (error.cause instanceof ProviderError) throw error.cause;
          if (error.code === 'account_sync_timeout') throw new ProviderError('request-deadline');
        }
        throw error;
      }
      return result;
    };
    return Object.assign(probe, { cleanupBlocked });
  }
  const detachClock = options.clock.subscribe('account-list', async () => {
    if (!closed && connection.recovering && !jobs.size && nextAttemptMs !== null) {
      if (now() >= nextAttemptMs)
        await wait(
          launch('recover', generation, async (job) => {
            job.accepted = true;
            stage = 'saving';
            notify();
            await connection.recover();
            runBackground(options.supervisor.reconcile(), 'account_reconcile_failed');
            return connection.active?.lastImportedCount ?? null;
          }),
        );
      return;
    }
    if (
      !closed &&
      connection.active &&
      !state.needsReconnect &&
      !jobs.size &&
      nextAttemptMs !== null
    ) {
      nextAttemptMs = dueAt();
      if (now() >= nextAttemptMs) await refresh(undefined, false);
    }
  });
  schedule(true);
  return {
    status,
    openArchiveReasonProbe: async (origin, signal) => {
      const saved = connection.active;
      const openProbe = options.provider.openArchiveReasonProbe;
      if (closed || signal.aborted || saved?.origin !== origin || !openProbe)
        throw new ProviderError('account-session-unavailable');
      const probe = await openProbe(saved.cookiesText, origin, saved.profile?.username, signal);
      return withBlockedCleanup(probe, saved, signal);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    avatar: async (signal) => {
      if (closed) throw new AccountSyncError('account_sync_unavailable');
      if (signal?.aborted) throw new AccountSyncError('account_sync_cancelled');
      const key = avatarKey(),
        url = accountAvatarSource(connection.active?.profile?.avatarSourceUrl);
      if (!key || !url) throw new AccountSyncError('account_sync_disconnected');
      if (avatarCache?.key === key && avatarCache.expires > now()) return avatarCache.bytes;
      if (avatarPending?.key === key) return await waitFor(avatarPending.done, signal);
      if (avatarTasks.size >= 2) throw new AccountSyncError('account_sync_busy');
      const controller = new AbortController();
      const done = (async () => {
        try {
          const bytes = await avatarHttp.bytes(url, {
            signal: controller.signal,
            maxBytes: 512 * 1024,
          });
          if (closed || controller.signal.aborted || key !== avatarKey())
            throw new AccountSyncError('account_sync_disconnected');
          if (!previewImageType(bytes)) throw new AccountSyncError('account_sync_unavailable');
          avatarCache = { key, bytes, expires: now() + 300000 };
          return bytes;
        } catch (error) {
          if (error instanceof AccountSyncError) throw error;
          throw new AccountSyncError('account_sync_unavailable');
        }
      })();
      const task = { key, controller, done };
      avatarTasks.add(task);
      avatarPending = task;
      void done
        .finally(() => {
          avatarTasks.delete(task);
          if (avatarPending === task) avatarPending = undefined;
        })
        .catch(() => undefined);
      return await waitFor(done, signal);
    },
    configure: async (
      config: AccountSyncConfig,
      signal?: AbortSignal,
    ): Promise<AccountSyncResult> => {
      available();
      const parsed = accountSyncConfigSchema.parse(config);
      if (signal?.aborted) throw new AccountSyncError('account_sync_cancelled');
      let origin: string;
      try {
        origin = accountSiteOrigin(parsed.origin ?? connection.active?.origin ?? defaultOrigin);
      } catch {
        throw new AccountSyncError('account_origin_invalid');
      }
      if (connection.active && origin !== connection.active.origin)
        throw new AccountSyncError('account_origin_locked');
      const currentGeneration = invalidate();
      const job = launch('configure', currentGeneration, async (current) => {
        if (connection.active && origin !== connection.active.origin)
          throw new AccountSyncError('account_origin_locked');
        return synchronize(current, parsed.cookiesText, true, origin);
      });
      return wait(job, signal, true);
    },
    refresh,
    unfollow,
    disconnect: async () => {
      available();
      let draft: AccountSyncConfig | null = null;
      const currentGeneration = invalidate();
      const job = launch('disconnect', currentGeneration, async (current) => {
        valid(current);
        try {
          // Capture committed credentials inside the serialized operation. Only
          // the explicit disconnect caller receives them after successful removal.
          const active = connection.active;
          draft = active ? { cookiesText: active.cookiesText, origin: active.origin } : null;
          await connection.disconnect();
          pendingMissingCount = 0;
          favoritesIndexCount = undefined;
          pendingProfileCount = 0;
          archivedRecoveryCursor = 0;
          await options.supervisor.reconcile();
        } catch {
          throw new AccountSyncError('account_sync_unavailable');
        }

        valid(current);
        return null;
      });
      await wait(job);
      return draft;
    },
    close: () => {
      if (closing) return closing;
      closed = true;
      listeners.clear();
      detachClock?.();
      invalidate();
      clearAvatar();
      closing = Promise.allSettled([tail, ...[...avatarTasks].map((task) => task.done)]).then(
        () => undefined,
      );
      return closing;
    },
  };
}
