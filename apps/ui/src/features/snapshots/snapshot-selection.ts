import type { SnapshotItem } from '@st-vault/api-schema';

export interface SnapshotSelection {
  first: SnapshotItem;
  last: SnapshotItem;
  selected: ReadonlyMap<string, SnapshotItem>;
}

function compare(a: SnapshotItem, b: SnapshotItem): number {
  if (a.unitId === b.unitId) return 0;
  return a.slotFromMs - b.slotFromMs || (a.unitId < b.unitId ? -1 : 1);
}

function within(first: SnapshotItem, item: SnapshotItem, last: SnapshotItem): boolean {
  return compare(first, item) <= 0 && compare(item, last) <= 0;
}

export function toggleSnapshot(
  selection: SnapshotSelection,
  item: SnapshotItem,
): SnapshotSelection | null {
  if (!within(selection.first, item, selection.last)) return null;
  const selected = new Map(selection.selected);
  if (!selected.delete(item.unitId)) selected.set(item.unitId, item);
  return { ...selection, selected };
}

/** Each pointer starts with an immutable selection. Reversing its direction undoes
 * only changes from that pointer, including across pages already traversed. */
export class SnapshotRangeDrag {
  private readonly visited = new Map<string, SnapshotItem>();
  private readonly base: SnapshotSelection | null;
  constructor(
    private readonly anchor: SnapshotItem,
    previous: SnapshotSelection | null,
  ) {
    this.base = previous && within(previous.first, anchor, previous.last) ? previous : null;
    this.visited.set(anchor.unitId, anchor);
  }
  visit(items: SnapshotItem[]): void {
    for (const item of items) this.visited.set(item.unitId, item);
  }
  to(endpoint: SnapshotItem): SnapshotSelection {
    let first = this.anchor,
      last = endpoint;
    if (compare(first, last) > 0) [first, last] = [last, first];
    const selected = new Map(this.base?.selected);
    for (const item of this.visited.values()) {
      if (!within(first, item, last)) continue;
      if (!selected.delete(item.unitId)) selected.set(item.unitId, item);
    }
    if (this.base && compare(this.base.first, first) < 0) first = this.base.first;
    if (this.base && compare(this.base.last, last) > 0) last = this.base.last;
    return { first, last, selected };
  }
}

type Activate = (item: SnapshotItem) => void;
interface ClickActions {
  single?: Activate;
  double?: Activate;
  waitMs: number;
  nativeDouble?: boolean;
}
interface PendingActivation {
  id: string;
  single?: () => void;
  double?: Activate;
  waitMs: number;
}
export class SnapshotActivation {
  private pending?: PendingActivation;
  private timer?: ReturnType<typeof setTimeout>;
  private previous?: { id: string; double?: Activate };
  private nativeConfirmation?: { id: string; double?: Activate };
  get pendingPlayId(): string | undefined {
    return this.pending?.single ? this.pending.id : undefined;
  }
  cancel(): void {
    clearTimeout(this.timer);
    this.pending = undefined;
    this.previous = undefined;
    this.nativeConfirmation = undefined;
  }
  hold(item: SnapshotItem): void {
    if (this.pending?.id === item.unitId) clearTimeout(this.timer);
  }
  resume(item: SnapshotItem): void {
    const pending = this.pending;
    if (pending?.id !== item.unitId) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.pending = undefined;
      pending.single?.();
    }, pending.waitMs);
  }
  click(item: SnapshotItem, actions: ClickActions): void {
    const previous = this.pending;
    const sameUnit = this.previous?.id === item.unitId ? this.previous : undefined;
    this.cancel();
    // Only selection edits may accept a late platform double-click count: they never seek.
    if (!actions.single) this.previous = { id: item.unitId, double: actions.double };
    if (previous?.id === item.unitId) {
      previous.double?.(item);
      return;
    }
    previous?.single?.();
    if (sameUnit && actions.nativeDouble) {
      sameUnit.double?.(item);
      return;
    }
    this.nativeConfirmation = sameUnit;
    const { single } = actions;
    this.pending = {
      id: item.unitId,
      single: single ? () => single(item) : undefined,
      double: actions.double,
      waitMs: actions.waitMs,
    };
    this.resume(item);
  }
  confirmDouble(item: SnapshotItem): void {
    const previous = this.nativeConfirmation;
    if (previous?.id !== item.unitId) return;
    this.cancel();
    previous.double?.(item);
  }
}
