import type { MediaTimeRange } from '@st-vault/api-schema';
import { calendarSlot, DAY_MS } from '../../shared/lib/time';

type Seam = 'earlier' | 'later';
interface Gap {
  from: number;
  to: number;
  seam: number;
  removedThrough: number;
}

/** A prefix index supports inverse lookups during dragging and drawing many rows. */
class GapAxis {
  private readonly gaps: Gap[] = [];
  constructor(ranges: readonly MediaTimeRange[]) {
    let removed = 0;
    for (const { fromMs: from, toMs: to } of ranges) {
      if (to <= from) continue;
      this.gaps.push({ from, to, seam: from - removed, removedThrough: removed + to - from });
      removed += to - from;
    }
  }
  private lastAt(value: number, field: 'from' | 'seam', inclusive = true): Gap | undefined {
    let lo = 0,
      hi = this.gaps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const point = this.gaps[mid][field];
      if (point < value || (inclusive && point === value)) lo = mid + 1;
      else hi = mid;
    }
    return this.gaps[lo - 1];
  }
  project(at: number): number {
    const gap = this.lastAt(at, 'from');
    return gap ? Math.max(gap.seam, at - gap.removedThrough) : at;
  }
  invert(at: number, side: Seam): number {
    return at + (this.lastAt(at, 'seam', side === 'later')?.removedThrough ?? 0);
  }
  hidden(at: number): boolean {
    return this.nextVisible(at) > at;
  }
  nextVisible(at: number): number {
    return Math.max(at, this.lastAt(at, 'from')?.to ?? at);
  }
}

export interface TimelineScale {
  duration: number;
  position: (at: number) => number;
  coordinate: (at: number) => number;
  at: (fraction: number, side?: Seam) => number;
  restore: (coordinate: number, side?: Seam) => number;
  hidden: (at: number) => boolean;
  nextVisible: (at: number) => number;
  shift: (at: number, offset: number) => number;
}

export class ArchiveCalendar {
  private readonly time: GapAxis;
  private readonly slots: GapAxis;
  constructor(emptyDays: readonly MediaTimeRange[]) {
    this.time = new GapAxis(emptyDays);
    this.slots = new GapAxis(
      emptyDays.map(({ fromMs, toMs }) => ({
        fromMs: calendarSlot(fromMs),
        toMs: calendarSlot(toMs),
      })),
    );
  }
  hidden(at: number): boolean {
    return this.time.hidden(at);
  }
  slot(rawSlot: number): number {
    return this.slots.project(rawSlot);
  }
  restoreSlot(slot: number, side: Seam): number {
    return this.slots.invert(slot, side);
  }
  visibleSpan(from: number, to: number): number {
    return (this.slot(calendarSlot(to)) - this.slot(calendarSlot(from))) * (DAY_MS / 2);
  }
  shift(at: number, offset: number): number {
    return this.time.invert(this.time.project(at) + offset, offset < 0 ? 'earlier' : 'later');
  }
  scale(from: number, to: number): TimelineScale {
    const start = this.time.project(from);
    const duration = Math.max(0, this.time.project(to) - start);
    const coordinate = (at: number) => this.time.project(at) - start;
    const restore = (value: number, side: Seam = 'later') => this.time.invert(start + value, side);
    return {
      duration,
      coordinate,
      position: (at) => coordinate(at) / Math.max(1, duration),
      at: (fraction, side) =>
        restore(duration * fraction, side ?? (fraction >= 1 ? 'earlier' : 'later')),
      restore,
      hidden: (at) => this.hidden(at),
      nextVisible: (at) => this.time.nextVisible(at),
      shift: (at, offset) => this.shift(at, offset),
    };
  }
}

export const fullCalendar = new ArchiveCalendar([]);
