import type { PublicStatus } from '@st-vault/api-schema';
import type { StatusObservationTiming } from '../provider/status-evidence.js';

const reportIntervalMs = 60_000;
const latencyBoundsMs = [
  1, 5, 10, 25, 50, 100, 250, 500, 1000, 2000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000,
  600_000,
];

class Latencies {
  private readonly buckets = new Uint32Array(latencyBoundsMs.length + 1);
  private count = 0;
  private maxMs = 0;

  add(ms: number): void {
    const index = latencyBoundsMs.findIndex((bound) => ms <= bound);
    this.buckets[index < 0 ? latencyBoundsMs.length : index]++;
    this.count++;
    this.maxMs = Math.max(this.maxMs, ms);
  }

  snapshot(): { count: number; maxMs: number | null; p95UpperMs: number | null } {
    if (!this.count) return { count: 0, maxMs: null, p95UpperMs: null };
    const maxMs = Math.ceil(this.maxMs);
    let rank = Math.ceil(this.count * 0.95);
    const bucket = this.buckets.findIndex((size) => (rank -= size) <= 0);
    return {
      count: this.count,
      maxMs,
      p95UpperMs: Math.min(latencyBoundsMs[bucket] ?? maxMs, maxMs),
    };
  }
}

const emptyTimings = () => ({
  inventory: new Latencies(),
  policyRecheck: new Latencies(),
  admission: new Latencies(),
  upstream: new Latencies(),
  persist: new Latencies(),
  sweep: new Latencies(),
  tail: new Latencies(),
  rotation: new Latencies(),
});
const emptyCounts = () => ({
  sweeps: 0,
  failedSweeps: 0,
  coalescedReconciles: 0,
  capacityLimitedSweeps: 0,
  deadlineLimitedSweeps: 0,
  disabledCandidates: 0,
  pendingCandidates: 0,
  observations: 0,
  cacheHits: 0,
  sharedObservations: 0,
  unknownObservations: 0,
  upstreamCalls: 0,
  upstreamRetries: 0,
  admissionDeadlines: 0,
  upstreamDeadlines: 0,
  persistenceFailures: 0,
});

/** Fixed-size, process-local diagnostics. Nothing here participates in scheduling. */
export class CapturePollingDiagnostics {
  private timings = emptyTimings();
  private counts = emptyCounts();
  private windowStartedAt = performance.now();
  private nextReportAt = this.windowStartedAt;
  private clockSkipsAtReport = 0;

  count(key: keyof ReturnType<typeof emptyCounts>, count = 1): void {
    this.counts[key] += count;
  }

  time(phase: keyof ReturnType<typeof emptyTimings>, elapsedMs: number): void {
    this.timings[phase].add(elapsedMs);
  }

  observe(timing: StatusObservationTiming, status?: PublicStatus): void {
    this.count('observations');
    if (status === 'UNKNOWN') this.count('unknownObservations');
    if (timing.source === 'cache') this.count('cacheHits');
    if (timing.source === 'shared') this.count('sharedObservations');
    if (timing.source === 'blocked') this.count('pendingCandidates');
    this.count('upstreamCalls', timing.upstreamCalls);
    this.count('upstreamRetries', timing.upstreamRetries);
    this.count('admissionDeadlines', timing.admissionDeadlines);
    this.count('upstreamDeadlines', timing.upstreamDeadlines);
    if (timing.persistenceFailed) this.count('persistenceFailures');
    if (timing.admissionMs !== undefined) this.time('admission', timing.admissionMs);
    if (timing.upstreamMs !== undefined) this.time('upstream', timing.upstreamMs);
    if (timing.persistMs !== undefined) this.time('persist', timing.persistMs);
  }

  finish(options: {
    startedAt: number;
    monitored: number;
    sweepBudgetMs: number | null;
    sweepWorkers: number | null;
    skippedClockRuns: number;
  }): void {
    const now = performance.now();
    this.count('sweeps');
    this.time('sweep', now - options.startedAt);
    if (now < this.nextReportAt) return;
    console.info(
      JSON.stringify({
        event: 'capture_polling',
        windowMs: Math.round(now - this.windowStartedAt),
        monitored: options.monitored,
        sweepBudgetMs: options.sweepBudgetMs,
        sweepWorkers: options.sweepWorkers,
        counts: {
          ...this.counts,
          skippedClockRuns: Math.max(0, options.skippedClockRuns - this.clockSkipsAtReport),
        },
        timings: Object.fromEntries(
          Object.entries(this.timings).map(([phase, values]) => [phase, values.snapshot()]),
        ),
      }),
    );
    this.windowStartedAt = now;
    this.nextReportAt = now + reportIntervalMs;
    this.clockSkipsAtReport = options.skippedClockRuns;
    this.timings = emptyTimings();
    this.counts = emptyCounts();
  }
}
