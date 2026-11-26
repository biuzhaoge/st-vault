import type { SnapshotItem } from '@st-vault/api-schema';
import { afterEach, expect, it, vi } from 'vitest';
import { SnapshotRangeDrag, toggleSnapshot, SnapshotActivation } from './snapshot-selection';

const unit = (unitId: string, slotFromMs: number): SnapshotItem => ({
  unitId,
  slotFromMs,
  slotToMs: slotFromMs + 10,
  atMs: slotFromMs + 2,
  url: '/' + unitId,
  timeBasis: 'source-pdt',
  uncertaintyMs: 0,
});
const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map((id, i) => unit(id, i * 20));
const ids = (value: ReturnType<SnapshotRangeDrag['to']>) => [...value.selected.keys()].sort();

it('selects only encountered media units, across pages in both directions, and retracts the moving edge', () => {
  const drag = new SnapshotRangeDrag(c, null);
  drag.visit([c, d, e]);
  expect(ids(drag.to(e))).toEqual(['c', 'd', 'e']);
  drag.visit([a, b]);
  expect(ids(drag.to(a))).toEqual(['a', 'b', 'c']);
  expect(ids(drag.to(b))).toEqual(['b', 'c']);
  expect(ids(drag.to(c))).toEqual(['c']);
});

it('inverts against the starting snapshot, including holes, while moving, shrinking and reversing', () => {
  const first = new SnapshotRangeDrag(b, null);
  first.visit([a, b, c, d, e]);
  const initial = toggleSnapshot(first.to(d), c)!;
  const drag = new SnapshotRangeDrag(c, initial);
  drag.visit([a, b, c, d, e]);
  expect(ids(drag.to(e))).toEqual(['b', 'c', 'e']);
  expect(ids(drag.to(d))).toEqual(['b', 'c']);
  expect(ids(drag.to(b))).toEqual(['c', 'd']);
  expect(ids(initial)).toEqual(['b', 'd']);
  const replacement = new SnapshotRangeDrag(a, initial);
  replacement.visit([a, b, c, d, e]);
  expect(ids(replacement.to(b))).toEqual(['a', 'b']);
});

it('retains the range when every unit is toggled off, consumes outside clicks, and uses stable IDs', () => {
  const drag = new SnapshotRangeDrag(b, null);
  const empty = toggleSnapshot(drag.to(b), { ...b, atMs: b.atMs + 1 })!;
  expect(ids(empty)).toEqual([]);
  expect(ids(toggleSnapshot(empty, b)!)).toEqual(['b']);
  expect(toggleSnapshot(empty, c)).toBeNull();
  const tie = unit('bb', b.slotFromMs);
  drag.visit([b, tie, c]);
  expect(ids(drag.to(tie))).toEqual(['b', 'bb']);
});

afterEach(() => vi.useRealTimers());
it('delivers a single click once and substitutes a double click on the same unit', () => {
  vi.useFakeTimers();
  const activate = new SnapshotActivation();
  const play = vi.fn<(item: SnapshotItem) => void>(),
    favorite = vi.fn<(item: SnapshotItem) => void>();
  const actions = { single: play, double: favorite, waitMs: 500 };
  activate.click(a, actions);
  vi.advanceTimersByTime(90);
  activate.click({ ...a }, actions);
  vi.runAllTimers();
  expect(play).not.toHaveBeenCalled();
  expect(favorite).toHaveBeenCalledExactlyOnceWith(a);
  activate.click(a, actions);
  activate.click(b, actions);
  vi.runAllTimers();
  expect(play.mock.calls.map(([item]) => item.unitId)).toEqual(['a', 'b']);
  activate.click(c, actions);
  activate.cancel();
  vi.runAllTimers();
  expect(play).toHaveBeenCalledTimes(2);
});
