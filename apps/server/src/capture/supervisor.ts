import type { CaptureState, Subject } from '@st-vault/api-schema';
import type { ArchivePort, ProviderPort, SupervisorPort } from '../ports.js';
import { ProviderError } from '../provider/http.js';
import {
  StatusEvidence,
  type StatusObservation,
  type StatusObservationTiming,
} from '../provider/status-evidence.js';
import type { SyncClock } from '../runtime/sync-clock.js';
import { CapturePollingDiagnostics } from './polling-diagnostics.js';
import { captureRotation } from './rotation.js';

const pollingJob = 'capture-status';

export interface SupervisorOptions {
  evidence?: StatusEvidence;
  clock?: SyncClock;
  archive: ArchivePort;
  provider: ProviderPort;
  pollMs?: number;
  backoffMs?: number;
  now?: () => number;
  autoStart?: boolean;
  runtime?: () => { pollMs: number };
  canRecord?: () => boolean;
  unknownLeaseMs?: number;
  offlineConfirmations?: number;
  recoveryWindowMs?: number;
  statusTimeoutMs?: number;
  statusConcurrency?: number;
}
interface Run {
  generation: number;
  controller: AbortController;
  done: Promise<void>;
  stopping: boolean;
  requestedAtMs: number;
  startedAtMs: number;
  firstCommitted: boolean;
}
export function createSupervisor(options: SupervisorOptions): SupervisorPort {
  const { archive, provider } = options;
  const pollMs = options.pollMs ?? 5000,
    backoffMs = options.backoffMs ?? 5000;
  const offlineConfirmations = options.offlineConfirmations ?? 2,
    recoveryWindowMs = options.recoveryWindowMs ?? 15000,
    statusTimeoutMs = options.statusTimeoutMs ?? 5000;
  const statusConcurrency = options.statusConcurrency ?? options.evidence?.concurrency ?? 8;
  if (
    (options.unknownLeaseMs !== undefined &&
      (!Number.isFinite(options.unknownLeaseMs) || options.unknownLeaseMs < 0)) ||
    !Number.isSafeInteger(offlineConfirmations) ||
    offlineConfirmations < 1 ||
    !Number.isFinite(recoveryWindowMs) ||
    recoveryWindowMs < 0 ||
    !Number.isFinite(statusTimeoutMs) ||
    statusTimeoutMs < 1 ||
    statusTimeoutMs > 30000 ||
    !Number.isSafeInteger(statusConcurrency) ||
    statusConcurrency < 1 ||
    statusConcurrency > 1024
  )
    throw new Error('invalid-observation-lease');
  if (!Number.isFinite(pollMs) || pollMs < 1 || !Number.isFinite(backoffMs) || backoffMs < 0)
    throw new Error('invalid-supervisor-options');
  const now = options.now ?? Date.now;
  const runs = new Map<string, Run>(),
    states = new Map<string, CaptureState>(),
    failures = new Map<string, number>();
  let generation = 0,
    closed = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | undefined,
    closeTask: Promise<void> | undefined,
    pollController: AbortController | undefined;
  const policyChecks = new Set<Promise<void>>();
  const listeners = new Set<() => void>();
  const urgent = new Set<string>();
  const requests = new Map<string, number>();
  const discardRequest = (id: string): void => {
    urgent.delete(id);
    requests.delete(id);
  };
  const setState = (id: string, state: CaptureState): void => {
    if (states.get(id) === state) return;
    states.set(id, state);
    for (const listener of listeners) listener();
  };
  const rotationVisited = new Set<string>();
  const diagnostics = new Map<string, { error: string | null; lastSuccessMs: number | null }>();
  const polling = new CapturePollingDiagnostics();
  let pollCursor = 0,
    cycleStartedAt = 0,
    monitoredCount = 0,
    statusLatencyMs = 1000,
    rotationStartedAt = now(),
    rotationTimingStartedAt = performance.now(),
    rotationMs: number | null = null;
  const runtime = (): { pollMs: number } => {
    const value = options.runtime?.() ?? { pollMs };
    if (!Number.isFinite(value.pollMs) || value.pollMs < 1)
      throw new Error('invalid-supervisor-runtime');
    return value;
  };
  const stop = (
    id: string,
    reason: 'policy' | 'storage' | 'private' | 'offline' | 'public-evidence-expired' | 'shutdown',
  ): void => {
    const run = runs.get(id);
    if (run && !run.stopping) {
      run.stopping = true;
      console.info(
        JSON.stringify({
          event: 'capture_stop_requested',
          subjectId: id,
          generation: run.generation,
          reason,
          requestedAtMs: now(),
          lastPublicAtMs: evidence.snapshot(id).lastPublicAtMs,
          publicUntilMs: evidence.snapshot(id).publicUntilMs,
          lastCommitAtMs: diagnostics.get(id)?.lastSuccessMs ?? null,
        }),
      );
      setState(id, 'STOPPING');
      run.controller.abort();
    }
  };
  const monitored = (subject: Subject): boolean => !subject.archived && subject.monitorEnabled;
  const recordingEnabled = (subject: Subject): boolean =>
    monitored(subject) && subject.archiveReason !== 'region_restricted' && subject.autoRecord;
  const recordingAllowed = (): boolean => options.canRecord?.() ?? true;
  // Allow for a full bounded-concurrency rotation, not only one nominal poll tick.
  // Failed observations never extend this lease or renew the last known state.
  const observationLease = (): number =>
    Math.min(
      600000,
      Math.ceil(
        Math.max(
          15000,
          runtime().pollMs * 3,
          Math.ceil(monitoredCount / Math.min(statusConcurrency, evidence.monitorCapacity)) *
            Math.max(rotationMs === null ? 1000 : 1, statusLatencyMs) *
            3,
          (rotationMs ?? 0) * 3,
        ),
      ),
    );
  const expireEvidence = (): void => {
    for (const id of runs.keys()) if (!evidence.public(id)) stop(id, 'public-evidence-expired');
  };
  const evidence =
    options.evidence ??
    new StatusEvidence({
      provider,
      now,
      leaseMs: () => options.unknownLeaseMs ?? observationLease(),
      timeoutMs: statusTimeoutMs,
      publicConcurrency: statusConcurrency,
      offlineConfirmations,
      recoveryWindowMs,
      persist: (id, status, at, lease, transitionAt) =>
        archive.setObservation(id, status, at, lease, transitionAt),
    });
  evidence.configureLease(() => options.unknownLeaseMs ?? observationLease());
  const eligible = (subject: Subject): boolean =>
    recordingEnabled(subject) &&
    subject.providerStatus === 'PUBLIC' &&
    evidence.publicForStart(subject.id);
  const detachEvidence = evidence.subscribe((id, state) => {
    if (state.revocation === 'PRIVATE') stop(id, 'private');
    else if (state.revocation === 'OFFLINE') stop(id, 'offline');
  });
  const schedule = (): void => {
    if (closed || options.autoStart === false || options.clock) return;
    timer = setTimeout(
      () => {
        void reconcile()
          .catch(() => undefined)
          .finally(schedule);
      },
      Math.max(100, runtime().pollMs - (Date.now() - cycleStartedAt)),
    );
    timer.unref();
  };
  const launch = (subject: Subject): void => {
    if (closed || !recordingAllowed() || !eligible(subject)) return;
    if (runs.has(subject.id)) return;
    if ((failures.get(subject.id) ?? 0) > now()) {
      setState(subject.id, 'BACKOFF');
      return;
    }
    const run: Run = {
      generation: ++generation,
      controller: new AbortController(),
      done: Promise.resolve(),
      stopping: false,
      requestedAtMs: requests.get(subject.id) ?? Date.now(),
      startedAtMs: Date.now(),
      firstCommitted: false,
    };
    discardRequest(subject.id);
    runs.set(subject.id, run);
    diagnostics.set(subject.id, {
      error: null,
      lastSuccessMs: diagnostics.get(subject.id)?.lastSuccessMs ?? null,
    });
    setState(subject.id, 'RESOLVING');
    run.done = Promise.resolve()
      .then(async () => {
        if (run.controller.signal.aborted) return;
        await provider.capture(
          subject,
          {
            commit: async (input) => {
              if (
                closed ||
                run.controller.signal.aborted ||
                runs.get(subject.id)?.generation !== run.generation
              )
                throw new Error('capture-generation-cancelled');
              const writingAt = Date.now();
              const result = await archive.commit(input);
              diagnostics.set(subject.id, { error: null, lastSuccessMs: now() });
              failures.delete(subject.id);
              if (!run.firstCommitted) {
                run.firstCommitted = true;
                console.info(
                  JSON.stringify({
                    event: 'capture_first_commit',
                    subjectId: subject.id,
                    generation: run.generation,
                    requestedAtMs: run.requestedAtMs,
                    startedAtMs: run.startedAtMs,
                    committedAtMs: Date.now(),
                    elapsedMs: Date.now() - run.requestedAtMs,
                    admissionMs: run.startedAtMs - run.requestedAtMs,
                    writeMs: Date.now() - writingAt,
                  }),
                );
                if (!run.controller.signal.aborted) setState(subject.id, 'CAPTURING');
              }
              return result;
            },
          },
          run.controller.signal,
        );
      })
      .catch((error: unknown) => {
        if (!run.controller.signal.aborted) {
          failures.set(subject.id, now() + backoffMs);
          const safeError =
            error instanceof ProviderError
              ? error.code
              : error instanceof Error && error.message === 'STORAGE_LOW_OR_UNAVAILABLE'
                ? 'STORAGE_LOW_OR_UNAVAILABLE'
                : 'capture-failed';
          diagnostics.set(subject.id, {
            error: safeError,
            lastSuccessMs: diagnostics.get(subject.id)?.lastSuccessMs ?? null,
          });
          console.warn(
            JSON.stringify({
              event: 'capture_failed',
              subjectId: subject.id,
              code: safeError,
              generation: run.generation,
              lastCommitAtMs: diagnostics.get(subject.id)?.lastSuccessMs ?? null,
            }),
          );
        }
      })
      .finally(() => {
        if (runs.get(subject.id)?.generation !== run.generation) return;
        runs.delete(subject.id);
        setState(subject.id, closed || run.stopping ? 'IDLE' : 'BACKOFF');
        // Keep completed finite sources from being resolved in a tight loop.
        if (!closed && !run.stopping && !failures.has(subject.id))
          failures.set(subject.id, now() + backoffMs);
      });
  };
  const listSubjects = async (phase: 'inventory' | 'policyRecheck'): Promise<Subject[]> => {
    const startedAt = performance.now();
    try {
      return await archive.listSubjects({ activity: false });
    } finally {
      polling.time(phase, performance.now() - startedAt);
    }
  };
  const cycle = async (sweep: {
    sweepBudgetMs: number | null;
    sweepWorkers: number | null;
  }): Promise<void> => {
    cycleStartedAt = Date.now();
    const subjects = await listSubjects('inventory');
    if (closed) return;
    const nextCount = subjects.filter(monitored).length;
    if (nextCount !== monitoredCount) {
      rotationStartedAt = now();
      rotationTimingStartedAt = performance.now();
      rotationMs = null;
      rotationVisited.clear();
    }
    monitoredCount = nextCount;
    const storageReady = recordingAllowed();
    const byId = new Map(subjects.map((subject) => [subject.id, subject]));
    for (const id of rotationVisited) {
      const subject = byId.get(id);
      if (!subject || !monitored(subject)) rotationVisited.delete(id);
    }
    for (const id of runs.keys()) {
      const subject = byId.get(id);
      if (!storageReady || !subject || !recordingEnabled(subject))
        stop(id, storageReady ? 'policy' : 'storage');
    }
    const controller = new AbortController();
    pollController = controller;
    expireEvidence();
    // Fair rolling workers avoid a slow batch holding up every later subject. Each sweep
    // has a deadline; unvisited subjects retain only their bounded persisted lease.
    const admissionStarted = performance.now();
    const admissionAt = Date.now();
    const budgetMs = (sweep.sweepBudgetMs = Math.max(1000, runtime().pollMs));
    const deadline = admissionAt + budgetMs;
    // Keep a single rotation across captures and followed subjects. Repartitioning
    // captures first would starve everyone else when requests exhaust a sweep.
    const rotation = captureRotation(subjects, pollCursor, urgent, (id) => evidence.pendingFor(id));
    let selected = 0;
    let capacityLimited = false;
    let deadlineReached = false;
    const observe = async (): Promise<void> => {
      while (!closed && !controller.signal.aborted) {
        if (Date.now() >= deadline) {
          deadlineReached = true;
          return;
        }
        if (
          evidence.pending >= evidence.concurrency ||
          evidence.monitorPending >= evidence.monitorCapacity
        ) {
          capacityLimited = true;
          return;
        }
        const next = rotation.next();
        if (!next) return;
        selected++;
        const { subject } = next;
        pollCursor = next.cursor;
        if (!monitored(subject)) {
          polling.count('disabledCandidates');
          continue;
        }
        if (evidence.pendingFor(subject.id)) {
          polling.count('pendingCandidates');
          continue;
        }
        const started = Date.now();
        const timing: StatusObservationTiming = {
          upstreamCalls: 0,
          upstreamRetries: 0,
          admissionDeadlines: 0,
          upstreamDeadlines: 0,
        };
        let result: StatusObservation | undefined;
        try {
          result = await evidence.observe(
            subject,
            controller.signal,
            options.evidence && !urgent.has(subject.id) ? runtime().pollMs / 2 : 0,
            'monitor',
            timing,
          );
        } catch (error) {
          if (closed || controller.signal.aborted) return;
          throw error;
        } finally {
          polling.observe(timing, result?.status);
        }
        if (closed || controller.signal.aborted) return;
        rotationVisited.add(subject.id);
        if (rotationVisited.size >= monitoredCount) {
          rotationMs = Math.max(1, now() - rotationStartedAt);
          rotationStartedAt = now();
          const finished = performance.now();
          polling.time('rotation', finished - rotationTimingStartedAt);
          rotationTimingStartedAt = finished;
          rotationVisited.clear();
        }
        if (result.status !== 'UNKNOWN') {
          if (urgent.has(subject.id) && result.status === 'PUBLIC') {
            const current = await archive.getSubject(subject.id, { activity: false });
            if (current) launch(current);
          }
          // Persistence is part of the shared observation, hence rotation cost.
          statusLatencyMs = statusLatencyMs * 0.9 + Math.max(1, Date.now() - started) * 0.1;
        }
        urgent.delete(subject.id);
        if (result.status !== 'PUBLIC') requests.delete(subject.id);
      }
    };
    const workers = (sweep.sweepWorkers = Math.min(statusConcurrency, evidence.monitorCapacity));
    const outcomes = await Promise.allSettled(
      Array.from({ length: workers }, () =>
        observe().catch((error: unknown) => {
          controller.abort();
          throw error;
        }),
      ),
    );
    const tailMs = performance.now() - admissionStarted - budgetMs;
    if (tailMs > 0) polling.time('tail', tailMs);
    if (selected < subjects.length && !closed && !controller.signal.aborted) {
      if (capacityLimited) polling.count('capacityLimitedSweeps');
      if (deadlineReached) polling.count('deadlineLimitedSweeps');
    }
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    if (closed) return;
    // Re-read policies after network waits; an in-flight public response cannot resurrect a disabled target.
    const latest = await listSubjects('policyRecheck');
    if (closed) return;
    const latestById = new Map(latest.map((subject) => [subject.id, subject]));
    const latestStorageReady = recordingAllowed();
    for (const id of requests.keys()) {
      const current = latestById.get(id);
      if (!current || !recordingEnabled(current)) {
        discardRequest(id);
        if (!runs.has(id)) setState(id, 'IDLE');
      }
    }
    for (const id of runs.keys()) {
      const current = latestById.get(id);
      if (!latestStorageReady || !current || !recordingEnabled(current))
        stop(id, latestStorageReady ? 'policy' : 'storage');
    }
    for (const subject of latest) {
      if (latestStorageReady && eligible(subject)) launch(subject);
      else if (!runs.has(subject.id)) setState(subject.id, 'IDLE');
    }
    if (pollController === controller) pollController = undefined;
  };
  function requestRecording(ids: string[], requestedAtMs = Date.now()): Promise<void> {
    const work = (async () => {
      const subjects =
        ids.length === 1
          ? [await archive.getSubject(ids[0], { activity: false })].filter(
              (row): row is Subject => row !== null,
            )
          : await archive.listSubjects({ activity: false });
      if (closed) return;
      const requested = new Set(ids);
      for (const subject of subjects) {
        if (!requested.has(subject.id)) continue;
        if (!recordingEnabled(subject)) {
          discardRequest(subject.id);
          stop(subject.id, 'policy');
          continue;
        }
        if (runs.has(subject.id)) continue;
        if (
          subject.providerStatus === 'PUBLIC' &&
          subject.observedAtMs !== null &&
          now() >= subject.observedAtMs &&
          now() - subject.observedAtMs < observationLease()
        )
          evidence.seedPublic(subject, subject.observedAtMs);
        if (eligible(subject)) {
          requests.set(subject.id, requestedAtMs);
          launch(subject);
        } else if (subject.providerStatus === 'UNKNOWN' || subject.providerStatus === 'PUBLIC') {
          urgent.add(subject.id);
          requests.set(subject.id, requestedAtMs);
          setState(subject.id, 'QUEUED');
        }
      }
      if (urgent.size) {
        const sweep = pending ?? reconcile();
        void sweep
          .then(async () => {
            if (!closed && urgent.size) await reconcile();
          })
          .catch((error) =>
            console.warn(
              'Requested recording reconciliation failed',
              error instanceof Error ? error.message : 'unknown',
            ),
          );
      }
    })();
    policyChecks.add(work);
    return work.finally(() => policyChecks.delete(work));
  }
  function reconcile(): Promise<void> {
    if (closed) return Promise.resolve();
    if (pending) {
      polling.count('coalescedReconciles');
      const current = pending;
      const checkedGenerations = new Map([...runs].map(([id, run]) => [id, run.generation]));
      // A policy edit must revoke an active generation without waiting for a slow status batch.
      const check = archive.listSubjects({ activity: false }).then((subjects) => {
        if (closed) return;
        const byId = new Map(subjects.map((subject) => [subject.id, subject]));
        const storageReady = recordingAllowed();
        for (const id of runs.keys()) {
          const subject = byId.get(id);
          if (
            (!storageReady || !subject || !recordingEnabled(subject)) &&
            runs.get(id)?.generation === checkedGenerations.get(id)
          )
            stop(id, storageReady ? 'policy' : 'storage');
        }
      });
      policyChecks.add(check);
      return Promise.all([current, check])
        .then(() => undefined)
        .finally(() => {
          policyChecks.delete(check);
        });
    }
    const startedAt = performance.now();
    const sweep = { sweepBudgetMs: null, sweepWorkers: null };
    pending = cycle(sweep)
      .catch((error: unknown) => {
        polling.count('failedSweeps');
        throw error;
      })
      .finally(() => {
        pending = undefined;
        polling.finish({
          startedAt,
          monitored: monitoredCount,
          ...sweep,
          skippedClockRuns: options.clock?.skippedRuns(pollingJob) ?? 0,
        });
      });
    return pending;
  }
  // Poll completion is not a prerequisite for expiring capture authorization.
  const leaseTimer = options.clock
    ? undefined
    : setInterval(() => {
        if (!closed) expireEvidence();
      }, 250);
  leaseTimer?.unref();
  const detachLease = options.clock?.subscribe('capture-lease', () => expireEvidence(), {
    everyPulse: true,
  });
  const detachPoll =
    options.autoStart !== false
      ? options.clock?.subscribe(pollingJob, reconcile, { immediate: true })
      : undefined;
  if (options.autoStart !== false && !options.clock) {
    timer = setTimeout(() => {
      void reconcile()
        .catch(() => undefined)
        .finally(schedule);
    }, 0);
    timer.unref();
  }
  return {
    requestRecording,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reconcile,
    states: () => Object.fromEntries(states),
    diagnostics: () => Object.fromEntries(diagnostics),
    close: () => {
      if (closeTask) return closeTask;
      closed = true;
      if (timer) clearTimeout(timer);
      clearInterval(leaseTimer);
      detachLease?.();
      detachPoll?.();
      pollController?.abort();
      detachEvidence();
      for (const id of runs.keys()) stop(id, 'shutdown');
      closeTask = (async () => {
        await pending?.catch(() => undefined);
        if (!options.evidence) await evidence.close();
        await Promise.all([...policyChecks].map((check) => check.catch(() => undefined)));
        await Promise.all([...runs.values()].map((run) => run.done));
      })();
      return closeTask;
    },
  };
}
