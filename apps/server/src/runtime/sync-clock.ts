export interface SyncTick {
  nowMs: number;
  intervalMs: number;
}
export const syncSkipped = Symbol('sync-skipped');
type WorkResult = void | typeof syncSkipped;

interface Job {
  name: string;
  work: (tick: SyncTick) => WorkResult | Promise<WorkResult>;
  running: boolean;
  active: boolean;
  pulse: boolean;
  lastStartedAtMs: number | null;
  lastFinishedAtMs: number | null;
  consecutiveFailures: number;
  skippedRuns: number;
  pending?: Promise<void>;
}
export interface ScheduledWorkStatus {
  name: string;
  running: boolean;
  lastStartedAtMs: number | null;
  lastFinishedAtMs: number | null;
  failed: boolean;
  consecutiveFailures?: number;
  nextTickAtMs: number;
}
/** One process clock; independent jobs never overlap or delay each other's next admission. */
export class SyncClock {
  private readonly jobs = new Set<Job>();
  private readonly pending = new Set<Promise<void>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private last: number;
  private period = 0;
  private stopped = false;
  constructor(private readonly options: { intervalMs: () => number; now?: () => number }) {
    this.last = this.now();
    this.timer = setInterval(() => this.pulse(), 250);
    this.timer.unref();
  }
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
  intervalMs(): number {
    const value = this.options.intervalMs();
    if (!Number.isFinite(value) || value < 1 || value > 300000)
      throw new Error('INVALID_SYNC_INTERVAL');
    return value;
  }
  periodNumber(): number {
    return this.period;
  }
  private run(job: Job, tick: SyncTick): Promise<void> | undefined {
    if (this.stopped || !job.active) return;
    if (job.running) {
      job.skippedRuns++;
      return job.pending;
    }
    job.running = true;
    job.lastStartedAtMs = tick.nowMs;
    const work = Promise.resolve()
      .then(() => {
        if (job.active && !this.stopped) return job.work(tick);
        return syncSkipped;
      })
      .then((result) => {
        if (result !== syncSkipped) job.consecutiveFailures = 0;
      })
      .catch((error) => {
        job.consecutiveFailures++;
        console.warn(
          'Synchronization failed',
          job.name,
          error instanceof Error ? error.name : 'unknown',
        );
      })
      .finally(() => {
        job.running = false;
        job.pending = undefined;
        job.lastFinishedAtMs = this.now();
        this.pending.delete(work);
      });
    this.pending.add(work);
    job.pending = work;
    return work;
  }
  private pulse(): void {
    if (this.stopped) return;
    const tick = { nowMs: this.now(), intervalMs: this.intervalMs() };
    const due = tick.nowMs - this.last >= tick.intervalMs || tick.nowMs < this.last;
    if (due) {
      this.last = tick.nowMs;
      this.period++;
    }
    for (const job of this.jobs) if (due || job.pulse) void this.run(job, tick);
  }
  subscribe(
    name: string,
    work: Job['work'],
    options: { everyPulse?: boolean; immediate?: boolean } = {},
  ): () => void {
    if (this.stopped) throw new Error('SYNC_CLOCK_CLOSED');
    const job: Job = {
      name,
      work,
      running: false,
      active: true,
      pulse: options.everyPulse ?? false,
      lastStartedAtMs: null,
      lastFinishedAtMs: null,
      consecutiveFailures: 0,
      skippedRuns: 0,
    };
    this.jobs.add(job);
    if (options.immediate) void this.run(job, { nowMs: this.now(), intervalMs: this.intervalMs() });
    return () => {
      job.active = false;
      this.jobs.delete(job);
    };
  }
  /** Due callbacks suppressed while that subscription's current run was active. */
  skippedRuns(name: string): number {
    for (const job of this.jobs) if (job.name === name) return job.skippedRuns;
    return 0;
  }
  runNow(name: string): Promise<void> | undefined {
    const job = [...this.jobs].find((item) => item.name === name);
    return (
      job?.pending ?? (job && this.run(job, { nowMs: this.now(), intervalMs: this.intervalMs() }))
    );
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    for (const job of this.jobs) job.active = false;
    this.jobs.clear();
  }
  /** Scheduling facts only. Domain failures and backoff remain owned by each job. */
  status(): ScheduledWorkStatus[] {
    const next = this.last + this.intervalMs();
    return [...this.jobs].map((job) => ({
      name: job.name,
      running: job.running,
      lastStartedAtMs: job.lastStartedAtMs,
      lastFinishedAtMs: job.lastFinishedAtMs,
      failed: job.consecutiveFailures > 0,
      consecutiveFailures: job.consecutiveFailures,
      nextTickAtMs: job.pulse ? this.now() + 250 : next,
    }));
  }
  async close(): Promise<void> {
    this.stop();
    await Promise.allSettled([...this.pending]);
  }
}
