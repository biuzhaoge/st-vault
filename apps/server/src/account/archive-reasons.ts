import type {
  AccountSyncStatus,
  ArchiveReason,
  BackgroundTask,
  Subject,
} from '@st-vault/api-schema';
import type { AccountSyncPort, ArchivePort, UnfollowedSubjectResult } from '../ports.js';
import { ProviderError } from '../provider/http.js';
import type { SyncClock } from '../runtime/sync-clock.js';

export type ArchiveReasonProbe = ((
  providerId: number,
  signal: AbortSignal,
) => Promise<ArchiveReason | null>) & {
  unfollowBlocked?: (providerId: number, signal: AbortSignal) => Promise<void>;
  cleanupBlocked?: (
    id: string,
    providerId: number,
    signal: AbortSignal,
  ) => Promise<UnfollowedSubjectResult>;
};
export type OpenArchiveReasonProbe = (
  origin: string,
  signal: AbortSignal,
) => Promise<ArchiveReasonProbe>;

interface Options {
  archive: Pick<
    ArchivePort,
    | 'listSubjects'
    | 'accountActivation'
    | 'recordVerifiedUnfollowed'
    | 'acceptedSubjectCleanupIds'
    | 'resumeAcceptedSubjectCleanup'
    | 'recordArchiveRestriction'
  >;
  clock: Pick<SyncClock, 'subscribe' | 'runNow' | 'status'>;
  account: () => Pick<
    AccountSyncStatus,
    'origin' | 'connected' | 'needsReconnect' | 'running' | 'lastSuccessMs' | 'profile'
  >;
  openProbe: OpenArchiveReasonProbe;
  now: () => number;
  transportSignal?: () => AbortSignal;
  subscribeAccount?: AccountSyncPort['subscribe'];
  onUpdated?: (purged: boolean) => void;
}

const minute = 60_000;
const hour = 60 * minute;
const batchSize = 4;
const reasonLifetime = 2 * hour;
const jobName = 'archive-reasons';
interface Check {
  checkedAt: number;
  retryAt: number;
  reason: ArchiveReason | null;
}
type CheckUpdate = 'unchanged' | 'changed' | 'purged';

function routeFailure(error: ProviderError): string | undefined {
  if (error.challenge) return 'site_verification_required';
  if (error.status === 429) return 'site_rate_limited';
  if (error.code === 'request-deadline') return 'site_request_timeout';
  if (error.code === 'upstream-request') return 'site_network_unavailable';
  if ((error.status ?? 0) >= 500) return 'site_unavailable';
  return undefined;
}

/** Archive causes are observations of the current account and route. */
export function createArchiveReasons({
  archive,
  clock,
  account,
  openProbe,
  now,
  transportSignal,
  subscribeAccount,
  onUpdated,
}: Options) {
  const checks = new Map<number, Check>();
  let origin: string | null = null;
  let username: string | undefined;
  let transport: AbortSignal | undefined;
  let binding = new AbortController();
  let archivedIds: number[] | undefined;
  let storedReasons = new Set<number>();
  let backoff: { until: number; error: string } | undefined;
  let consecutiveFailures = 0;
  let lastSuccessAtMs: number | undefined;
  let lastRunAtMs: number | undefined;
  let cleanupAfter = 0;
  let waitingForAccount = false;
  let pending: Promise<void> | undefined;
  let closed = false;

  function updateBinding(status: ReturnType<Options['account']>): boolean {
    const next =
      !closed && status.connected && status.lastSuccessMs !== null ? (status.origin ?? null) : null;
    const nextTransport = transportSignal?.();
    const nextUsername = next ? status.profile?.username.toLowerCase() : undefined;
    if (origin === next && username === nextUsername && transport === nextTransport) return false;
    binding.abort();
    binding = new AbortController();
    origin = next;
    username = nextUsername;
    transport = nextTransport;
    archivedIds = undefined;
    storedReasons.clear();
    backoff = undefined;
    consecutiveFailures = 0;
    lastSuccessAtMs = undefined;
    lastRunAtMs = undefined;
    cleanupAfter = 0;
    waitingForAccount = false;
    const hadEvidence = checks.size > 0;
    checks.clear();
    return hadEvidence;
  }

  function reasonAt(id: number, at: number): ArchiveReason | undefined {
    const check = checks.get(id);
    return check && at < check.checkedAt + reasonLifetime ? (check.reason ?? undefined) : undefined;
  }

  function deferProbe(error: ProviderError, code: string, at: number): void {
    if (!backoff || backoff.until <= at)
      console.warn(
        JSON.stringify({
          event: 'archive_reason_probe_deferred',
          code: error.code,
          status: error.status,
        }),
      );
    const until = at + Math.max(5 * minute, error.retryAfterMs ?? 0);
    if (!backoff || backoff.until < until) backoff = { until, error: code };
  }

  function retryCheck(
    id: number,
    error: unknown,
    signal: AbortSignal,
    failureEvent?: 'archive_blocked_unfollow_deferred',
  ): CheckUpdate {
    updateBinding(account());
    if (signal.aborted) return 'unchanged';
    if (!(error instanceof ProviderError)) throw error;
    if (failureEvent && error.code !== 'cancelled')
      console.warn(JSON.stringify({ event: failureEvent, code: error.code, status: error.status }));
    const checkedAt = now();
    const blocked = routeFailure(error);
    if (blocked) deferProbe(error, blocked, checkedAt);
    const previous = checks.get(id);
    checks.set(id, {
      reason: previous?.reason ?? null,
      checkedAt: previous?.checkedAt ?? checkedAt,
      retryAt:
        checkedAt +
        (previous?.reason && previous.reason !== 'account_disabled' ? 15 * minute : minute),
    });
    return 'unchanged';
  }

  function removeChecked(id: number): void {
    checks.delete(id);
    archivedIds = archivedIds?.filter((providerId) => providerId !== id);
  }

  async function checkReason(
    probe: ArchiveReasonProbe,
    subject: Subject,
    generation: string | null,
    signal: AbortSignal,
  ): Promise<CheckUpdate> {
    const id = subject.providerId;
    let reason: ArchiveReason | null;
    try {
      reason = await probe(id, signal);
    } catch (error) {
      return retryCheck(id, error, signal);
    }
    updateBinding(account());
    if (signal.aborted) return 'unchanged';
    const previousRestriction = subject.archiveReason;
    const canReplaceRestriction =
      reason === 'account_deleted' ||
      reason === 'region_restricted' ||
      (reason === 'unfollowed' && previousRestriction === 'account_disabled');
    if (
      previousRestriction &&
      previousRestriction !== 'unfollowed' &&
      reason !== previousRestriction &&
      !canReplaceRestriction
    )
      reason = null;
    const cleanupBlocked = probe.cleanupBlocked;
    let cleanupResult: UnfollowedSubjectResult | undefined;
    let restrictionChanged: boolean | undefined;
    if (reason === 'account_disabled' && cleanupBlocked) {
      try {
        cleanupResult = await cleanupBlocked(subject.id, id, signal);
      } catch (error) {
        return retryCheck(id, error, signal, 'archive_blocked_unfollow_deferred');
      }
      restrictionChanged = cleanupResult === 'retained' && reason !== subject.archiveReason;
    } else if (reason === 'unfollowed' && archive.recordVerifiedUnfollowed) {
      if (!generation) return 'unchanged';
      cleanupResult = await archive.recordVerifiedUnfollowed(subject.id, generation);
    } else if (reason && reason !== 'unfollowed' && archive.recordArchiveRestriction) {
      if (!generation) return 'unchanged';
      restrictionChanged =
        reason !== subject.archiveReason &&
        (await archive.recordArchiveRestriction(subject.id, generation, reason));
    }
    if (cleanupResult === 'purged' || cleanupResult === 'missing') {
      removeChecked(id);
      if (!signal.aborted) lastSuccessAtMs = now();
      return cleanupResult === 'purged' ? 'purged' : 'changed';
    }
    if (cleanupResult === 'stale' || signal.aborted) return 'unchanged';
    const checkedAt = now();
    const previous = reasonAt(id, checkedAt);
    lastSuccessAtMs = checkedAt;
    checks.set(id, {
      reason,
      checkedAt,
      retryAt: checkedAt + (reason && reason !== 'unfollowed' && !cleanupResult ? hour : minute),
    });
    return (restrictionChanged ?? previous !== (reason ?? undefined)) ? 'changed' : 'unchanged';
  }

  async function sample(): Promise<boolean | undefined> {
    const status = account();
    updateBinding(status);
    const selected = origin;
    const signal = transport ? AbortSignal.any([binding.signal, transport]) : binding.signal;
    if (!selected || signal.aborted || status.needsReconnect) return;
    waitingForAccount = status.running;
    if (waitingForAccount) return;
    const subjects = await archive.listSubjects({ activity: false, includeCleanup: true });
    const current = account();
    updateBinding(current);
    if (signal.aborted || current.needsReconnect) return;
    waitingForAccount = current.running;
    if (waitingForAccount) return;
    const unverified = subjects.filter(
      (row) => row.archived && row.archiveReason !== 'region_restricted',
    );
    archivedIds = unverified.map(({ providerId }) => providerId);
    storedReasons = new Set(
      unverified.filter((row) => row.archiveReason).map(({ providerId }) => providerId),
    );
    const ids = new Set(archivedIds);
    for (const id of checks.keys()) if (!ids.has(id)) checks.delete(id);
    const at = now();
    const recovering = backoff;
    // Apply authenticated evidence only while this account roster is still active.
    const generation =
      archive.recordVerifiedUnfollowed ||
      archive.resumeAcceptedSubjectCleanup ||
      archive.recordArchiveRestriction
        ? await archive.accountActivation()
        : null;
    const latest = account();
    updateBinding(latest);
    if (signal.aborted || latest.needsReconnect) return;
    waitingForAccount = latest.running;
    if (waitingForAccount) return;
    const cleaned = await finishAccepted(generation, signal);
    if (signal.aborted || now() < (backoff?.until ?? 0)) return;
    const dueAt = (id: number) => checks.get(id)?.retryAt ?? 0;
    const batch = unverified
      .filter(({ providerId }) => !cleaned.has(providerId) && dueAt(providerId) <= at)
      .sort((a, b) => dueAt(a.providerId) - dueAt(b.providerId))
      .slice(0, recovering ? 1 : batchSize);
    if (!batch.length) {
      if (backoff && backoff.until <= at) backoff = undefined;
      return unverified.length === 0;
    }
    lastRunAtMs = at;
    let probe: ArchiveReasonProbe;
    try {
      probe = await openProbe(selected, signal);
    } catch (error) {
      updateBinding(account());
      if (signal.aborted) return;
      if (!(error instanceof ProviderError)) throw error;
      const code =
        routeFailure(error) ??
        (error.status === 401 || error.code === 'account-session-unavailable'
          ? 'account_reconnect'
          : 'status_sync_failed');
      deferProbe(error, code, now());
      return;
    }
    updateBinding(account());
    if (signal.aborted) return;
    const results = await Promise.allSettled(
      batch.map((subject) => checkReason(probe, subject, generation, signal)),
    );
    const purged = results.some(
      (result) => result.status === 'fulfilled' && result.value === 'purged',
    );
    const changed = results.some(
      (result) => result.status === 'fulfilled' && result.value === 'changed',
    );
    if (purged || (changed && !signal.aborted)) onUpdated?.(purged);
    if (signal.aborted) return;
    if (backoff === recovering) backoff = undefined;
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    return true;
  }

  async function finishAccepted(
    generation: string | null,
    signal: AbortSignal,
  ): Promise<Set<number>> {
    const completed = new Set<number>();
    const { acceptedSubjectCleanupIds, resumeAcceptedSubjectCleanup } = archive;
    if (!acceptedSubjectCleanupIds || !resumeAcceptedSubjectCleanup || !generation)
      return completed;
    let ready = await acceptedSubjectCleanupIds.call(archive, cleanupAfter, batchSize);
    if (cleanupAfter && !ready.length)
      ready = await acceptedSubjectCleanupIds.call(archive, 0, batchSize);
    if (signal.aborted) return completed;
    cleanupAfter = ready.length === batchSize ? (ready.at(-1)?.providerId ?? 0) : 0;
    if (!ready.length) return completed;
    lastRunAtMs = now();
    const results = await Promise.allSettled(
      ready.map((subject) => resumeAcceptedSubjectCleanup.call(archive, subject.id, generation)),
    );
    let purged = false;
    for (const [index, result] of results.entries()) {
      if (
        result.status !== 'fulfilled' ||
        (result.value !== 'purged' && result.value !== 'missing')
      )
        continue;
      const id = ready[index].providerId;
      completed.add(id);
      removeChecked(id);
      purged ||= result.value === 'purged';
    }
    if (completed.size) {
      if (!signal.aborted) lastSuccessAtMs = now();
      if (purged || !signal.aborted) onUpdated?.(purged);
    }
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
    return completed;
  }

  const detach = clock.subscribe(jobName, () => {
    updateBinding(account());
    const signal = binding.signal;
    const previousBackoff = backoff;
    pending = sample()
      .then((checked) => {
        if (signal.aborted) return;
        if (backoff && backoff !== previousBackoff) consecutiveFailures++;
        else if (checked) consecutiveFailures = 0;
      })
      .catch((error: unknown) => {
        if (!signal.aborted) consecutiveFailures++;
        throw error;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  });
  const detachAccount = subscribeAccount?.(() => {
    const status = account();
    if (updateBinding(status)) onUpdated?.(false);
    if (!waitingForAccount || status.running) return;
    waitingForAccount = false;
    // Both subscribers can start on the same heartbeat. Resume the deferred batch after
    // the account settles, once SyncClock has released the earlier invocation.
    setImmediate(() => {
      if (!closed) void clock.runNow(jobName);
    }).unref();
  });

  return {
    snapshot(): (row: Subject) => ArchiveReason | undefined {
      updateBinding(account());
      const at = now();
      return (row) =>
        row.archived
          ? (row.archiveReason ??
            (archive.recordArchiveRestriction ? undefined : reasonAt(row.providerId, at)))
          : undefined;
    },
    backgroundTask(): BackgroundTask {
      const accountStatus = account();
      updateBinding(accountStatus);
      const at = now();
      const scheduled = clock.status().find((job) => job.name === jobName);
      const disabled = !origin || accountStatus.needsReconnect;
      const running = Boolean(pending && !waitingForAccount);
      const retrying = consecutiveFailures > 0;
      const processed = archivedIds?.filter(
        (id) => storedReasons.has(id) || reasonAt(id, at) !== undefined,
      ).length;
      const nextDue = archivedIds?.reduce(
        (earliest, id) => Math.min(earliest, checks.get(id)?.retryAt ?? at),
        Infinity,
      );
      const nextRunAtMs =
        !disabled && scheduled && nextDue !== Infinity
          ? Math.max(scheduled.nextTickAtMs, nextDue ?? at, backoff?.until ?? 0)
          : null;
      return {
        id: jobName,
        group: 'sync',
        state: disabled
          ? 'disabled'
          : running
            ? 'running'
            : retrying
              ? 'retrying'
              : nextRunAtMs === null
                ? 'idle'
                : 'waiting',
        lastRunAtMs,
        lastSuccessAtMs,
        nextRunAtMs,
        consecutiveFailures: disabled ? 0 : consecutiveFailures,
        ...(processed === undefined ? {} : { processed, total: archivedIds?.length }),
        error:
          disabled || running ? null : (backoff?.error ?? (retrying ? 'status_sync_failed' : null)),
      };
    },
    async close(): Promise<void> {
      closed = true;
      detach();
      detachAccount?.();
      binding.abort();
      await Promise.allSettled(pending ? [pending] : []);
    },
  };
}
