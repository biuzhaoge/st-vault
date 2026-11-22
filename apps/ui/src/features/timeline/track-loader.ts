import { syncReadFailure } from '../../shared/lib/sync';
import type { TrackData } from './track-data';
export interface TrackPlan {
  visible: string[];
  fromMs: number;
  toMs: number;
  buckets: number;
  revision: number;
  paused?: boolean;
}
interface Row {
  subjectId: string;
  data: TrackData;
}
interface Entry {
  data: TrackData;
  scope: string;
  order: number;
}
interface Flight {
  plan: TrackPlan;
  ids: string[];
  controller: AbortController;
  invalidated: Set<string>;
}
const scope = (plan: TrackPlan): string =>
  `${plan.fromMs}:${plan.toMs}:${plan.buckets}:${plan.revision}`;
const cacheKey = (id: string, plan: TrackPlan): string =>
  `${id}:${plan.fromMs}:${plan.toMs}:${plan.buckets}`;
/** Scrolling changes priority, not ownership of a useful in-flight metadata batch. */
export class TrackLoader {
  private readonly entries = new Map<string, Entry>();
  private readonly resolved = new Map<string, { from: number; to: number; key?: string }>();
  private readonly failures = new Map<
    string,
    { scope: string; order: number; retryAt: number; attempts: number; transient: boolean }
  >();
  private plan: TrackPlan | null = null;
  private readonly running = new Set<Flight>();
  private requestOrder = 0;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  constructor(
    private readonly fetchRows: (
      ids: string[],
      plan: TrackPlan,
      signal: AbortSignal,
    ) => Promise<Row[]>,
    private readonly changed: () => void,
    private readonly limit = 64,
    private readonly options: { concurrency?: number; batchSize?: number } = {},
  ) {}
  get(id: string, from: number, to: number): TrackData | undefined {
    const cached = this.resolved.get(id);
    if (cached?.from === from && cached.to === to)
      return cached.key ? this.entries.get(cached.key)?.data : undefined;
    let key: string | undefined,
      rank = 0;
    for (const [candidate, entry] of this.entries) {
      const coverage = entry.data.coverage;
      if (coverage.subjectId !== id || coverage.fromMs >= to || coverage.toMs <= from) continue;
      const priority =
        coverage.fromMs === from && coverage.toMs === to
          ? 3
          : coverage.fromMs <= from && coverage.toMs >= to
            ? 2
            : 1;
      if (priority >= rank) {
        key = candidate;
        rank = priority;
      }
    }
    this.resolved.set(id, { from, to, key });
    while (this.resolved.size > this.limit)
      this.resolved.delete(this.resolved.keys().next().value!);
    return key ? this.entries.get(key)?.data : undefined;
  }
  getVisible(
    ids: readonly string[],
    from: number,
    to: number,
    buckets: number,
  ): ReadonlyMap<string, { data: TrackData | undefined; failed: boolean }> {
    const rows = new Map<string, { data: TrackData | undefined; failed: boolean }>();
    const currentWindow =
      this.plan?.fromMs === from && this.plan.toMs === to && this.plan.buckets === buckets;
    let waiting = false;
    // Cache and transport stay independent. Only the ready prefix of the current
    // viewport can reveal new detail, and a reported failure closes its turn.
    for (const id of ids) {
      const data = waiting ? undefined : this.get(id, from, to);
      const failed = currentWindow && this.failed(id);
      if (data || failed) rows.set(id, { data, failed });
      else waiting = true;
    }
    return rows;
  }
  failed(id: string): boolean {
    const failure = this.failures.get(id);
    return !!failure && !!this.plan && failure.scope === scope(this.plan);
  }
  update(plan: TrackPlan): void {
    if (this.closed) return;
    this.plan = plan;
    if (plan.paused) {
      clearTimeout(this.retry);
      for (const flight of this.running) flight.controller.abort();
      this.running.clear();
      return;
    }
    const wanted = new Set(plan.visible);
    // View ownership, rather than React render frequency, determines retention.
    for (const id of wanted) {
      this.get(id, plan.fromMs, plan.toMs);
      const key = this.resolved.get(id)?.key;
      const entry = key ? this.entries.get(key) : undefined;
      if (key && entry) {
        this.entries.delete(key);
        this.entries.set(key, entry);
      }
    }
    this.resolved.clear();
    for (const flight of this.running) {
      const previous = flight.plan;
      if (
        previous.fromMs !== plan.fromMs ||
        previous.toMs !== plan.toMs ||
        previous.buckets !== plan.buckets ||
        flight.ids.every((id) => !wanted.has(id))
      ) {
        flight.controller.abort();
        this.running.delete(flight);
      }
    }
    this.start();
  }
  pause(): void {
    if (this.plan && !this.plan.paused) this.update({ ...this.plan, paused: true });
  }
  invalidate(ids: readonly string[]): void {
    const subjects = new Set(ids);
    for (const entry of this.entries.values())
      if (subjects.has(entry.data.coverage.subjectId)) entry.scope = '';
    for (const flight of this.running)
      for (const id of flight.ids) if (subjects.has(id)) flight.invalidated.add(id);
    for (const id of subjects) if (!this.failures.get(id)?.transient) this.failures.delete(id);
    this.start();
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.retry);
    for (const flight of this.running) flight.controller.abort();
    this.running.clear();
    this.entries.clear();
    this.resolved.clear();
    this.failures.clear();
  }
  private start(): void {
    clearTimeout(this.retry);
    if (this.closed || !this.plan || this.plan.paused) return;
    const plan = this.plan,
      key = scope(plan),
      retryAt = (id: string): number => {
        const failure = this.failures.get(id);
        // A fresh content revision cannot shorten transport/server backoff.
        return failure && (failure.transient || failure.scope === key) ? failure.retryAt : 0;
      },
      pending = (id: string): boolean =>
        [...this.running].some((flight) => scope(flight.plan) === key && flight.ids.includes(id)),
      needs = (id: string): boolean =>
        this.entries.get(cacheKey(id, plan))?.scope !== key &&
        Date.now() >= retryAt(id) &&
        !pending(id);
    const wanted = [...new Set(plan.visible)].slice(0, this.limit);
    while (this.running.size < (this.options.concurrency ?? 2)) {
      // Match the server's three-row execution wave: an atomic response should
      // not hold completed visible rows behind a second wave in the same packet.
      const ids = wanted.filter(needs).slice(0, this.options.batchSize ?? 3);
      if (!ids.length) break;
      this.load(plan, ids, key);
    }
    const now = Date.now();
    const next = Math.min(
      ...wanted
        .filter((id) => !pending(id) && this.entries.get(cacheKey(id, plan))?.scope !== key)
        .map(retryAt)
        .filter((at) => at > now),
    );
    if (Number.isFinite(next)) this.retry = setTimeout(() => this.start(), next - now);
  }
  private load(plan: TrackPlan, ids: string[], key: string): void {
    const current = {
      plan,
      ids,
      controller: new AbortController(),
      order: ++this.requestOrder,
      invalidated: new Set<string>(),
    };
    this.running.add(current);
    void this.fetchRows(ids, plan, current.controller.signal)
      .then((rows) => {
        if (this.closed || current.controller.signal.aborted) return;
        for (const row of rows) {
          const rowKey = cacheKey(row.subjectId, plan);
          if (this.superseded(row.subjectId, plan, current.order)) continue;
          this.entries.delete(rowKey);
          // Keep usable data until the next read covers the newer observation.
          this.entries.set(rowKey, {
            data: row.data,
            scope: current.invalidated.has(row.subjectId) ? '' : key,
            order: current.order,
          });
          this.failures.delete(row.subjectId);
        }
        while (this.entries.size > this.limit)
          this.entries.delete(this.entries.keys().next().value!);
        this.resolved.clear();
        this.changed();
      })
      .catch((error) => {
        if (this.closed || current.controller.signal.aborted) return;
        // Retry transport/overload failures, never repeat invalid requests on a timer.
        const outcome = syncReadFailure(error, current.controller.signal);
        const transient = outcome.status === 'retry';
        for (const id of ids) {
          if (this.superseded(id, plan, current.order)) continue;
          if (!transient && current.invalidated.has(id)) continue;
          const previous = this.failures.get(id);
          const attempts =
            previous && (previous.transient || previous.scope === key) ? previous.attempts + 1 : 1;
          this.failures.set(id, {
            scope: key,
            order: current.order,
            attempts,
            transient,
            retryAt: transient
              ? Math.max(
                  outcome.notBeforeMs,
                  Date.now() + Math.min(30000, 3000 * 2 ** Math.min(4, attempts - 1)),
                )
              : Infinity,
          });
        }
        while (this.failures.size > this.limit)
          this.failures.delete(this.failures.keys().next().value!);
        console.warn('Timeline rows unavailable', error);
        this.changed();
      })
      .finally(() => {
        this.running.delete(current);
        this.start();
      });
  }
  private superseded(id: string, plan: TrackPlan, order: number): boolean {
    // Ordering covers data and failures even after another plan revision arrives.
    return (
      (this.entries.get(cacheKey(id, plan))?.order ?? 0) > order ||
      (this.failures.get(id)?.order ?? 0) > order
    );
  }
}
