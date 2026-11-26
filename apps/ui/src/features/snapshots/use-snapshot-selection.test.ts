import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import type { SnapshotItem } from '@st-vault/api-schema';
import { afterEach, expect, it, vi } from 'vitest';
import { SnapshotInput } from './use-snapshot-selection';

function fixture() {
  vi.useFakeTimers();
  const items: SnapshotItem[] = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => ({
    unitId: id,
    atMs: index,
    slotFromMs: index,
    slotToMs: index + 1,
    url: id,
    timeBasis: 'source-pdt',
    uncertaintyMs: 0,
  }));
  const play = vi.fn<(item: SnapshotItem) => void>(),
    double = vi.fn<(item: SnapshotItem) => void>(),
    commit = vi.fn<(ids: string[]) => void>(),
    turn = vi.fn();
  const input: SnapshotInput = new SnapshotInput(
    {
      scope: 's',
      items: items.slice(0, 3),
      page: 1,
      pagePending: false,
      motion: { press: vi.fn(), release: vi.fn(), cancel: vi.fn() },
      turnPage: turn,
      canTurnPage: (direction) => (direction < 0 ? input.options.page > 1 : input.options.page < 2),
      onPlay: play,
      onDoubleClick: double,
      onRangeCommit: commit,
    },
    vi.fn(),
  );
  let capture: 'source' | 'root' | null = null;
  const source = {
    isConnected: true,
    matches: () => true,
    setPointerCapture: () => {
      capture = 'source';
    },
    hasPointerCapture: () => capture === 'source',
    releasePointerCapture: () => {
      capture = null;
    },
  };
  const cell = (item: SnapshotItem, index: number) => ({
    dataset: { key: item.unitId },
    offsetTop: index * 30,
    offsetLeft: 0,
    offsetHeight: 30,
    offsetWidth: 100,
    closest: () => ({ dataset: { key: item.unitId } }),
  });
  const root = {
    isConnected: true,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: 100,
      bottom: 90,
      width: 100,
      height: 90,
    }),
    offsetWidth: 100,
    offsetHeight: 90,
    setPointerCapture: () => {
      capture = 'root';
    },
    releasePointerCapture: () => {
      capture = null;
    },
    hasPointerCapture: () => capture === 'root',
    querySelector: () => ({
      offsetLeft: 0,
      offsetTop: 0,
      querySelectorAll: () => input.options.items.map(cell),
    }),
  };
  const event = (type: string, y: number, index = 1) => {
    const item = input.options.items[index];
    const target = {
      closest: (s: string) =>
        !item ? null : s.includes('button') ? source : { dataset: { key: item.unitId } },
    };
    return {
      isPrimary: true,
      button: 0,
      pointerType: type,
      pointerId: 1,
      clientX: 50,
      clientY: y,
      nativeEvent: { pointerId: 1, pointerType: type },
      currentTarget: root,
      target,
      detail: 1,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
  };
  const pointer = (
    name: 'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerCancel',
    type: string,
    y: number,
    index = 1,
  ) =>
    input.viewportProps[name]?.(event(type, y, index) as unknown as PointerEvent<HTMLDivElement>);
  const click = (index: number, detail = 1, type = 'mouse') =>
    input.viewportProps.onClick?.({
      ...event(type, 45, index),
      detail,
    } as unknown as MouseEvent<HTMLDivElement>);
  const key = (index: number, key: string, shiftKey = false) =>
    input.viewportProps.onKeyDownCapture?.({
      ...event('mouse', 45, index),
      key,
      shiftKey,
    } as unknown as KeyboardEvent<HTMLDivElement>);
  const lost = (owner: typeof source | typeof root) =>
    input.viewportProps.onLostPointerCapture?.({
      ...event('mouse', 45),
      target: owner,
    } as unknown as PointerEvent<HTMLDivElement>);
  return { input, items, turn, play, double, commit, pointer, click, key, root, source, lost };
}
afterEach(() => vi.useRealTimers());

it.each(['mouse', 'touch'])(
  'hands a %s press and release to the same gesture when the second press is in time',
  (type) => {
    const { input, pointer, click, play, double, items } = fixture();
    const { press, release } = input.options.motion;
    const waitMs = type === 'touch' ? 300 : 500;
    const tap = () => {
      pointer('onPointerDown', type, 45);
      pointer('onPointerUp', type, 45);
      click(1, 1, type);
    };
    tap();
    expect(press).toHaveBeenLastCalledWith('b', false);
    expect(release).toHaveBeenLastCalledWith(waitMs);
    vi.advanceTimersByTime(waitMs - 40);
    expect(play).not.toHaveBeenCalled();
    tap();
    expect(press).toHaveBeenLastCalledWith('b', true);
    expect(double).toHaveBeenCalledExactlyOnceWith(items[1]);
    expect(play).not.toHaveBeenCalled();
    tap();
    expect(press).toHaveBeenLastCalledWith('b', false);
    vi.advanceTimersByTime(waitMs);
    expect(play).toHaveBeenCalledExactlyOnceWith(items[1]);
  },
);

it('follows a new contact immediately and commits the first card when the next click completes', () => {
  const { input, pointer, click, play, items } = fixture();
  pointer('onPointerDown', 'mouse', 15, 0);
  pointer('onPointerUp', 'mouse', 15, 0);
  click(0);
  vi.advanceTimersByTime(60);
  pointer('onPointerDown', 'mouse', 45);
  expect(play).not.toHaveBeenCalled();
  expect(input.options.motion.press).toHaveBeenLastCalledWith('b', false);
  pointer('onPointerUp', 'mouse', 45);
  click(1);
  expect(play).toHaveBeenCalledExactlyOnceWith(items[0]);
  expect(input.options.motion.release).toHaveBeenCalledTimes(2);
  vi.runAllTimers();
  expect(play.mock.calls.map(([unit]) => unit.unitId)).toEqual(['a', 'b']);
});

it('keeps the second press active while the first card finishes its pending single click', () => {
  const { input, pointer, click, play, items } = fixture();
  const { press, cancel } = input.options.motion;
  click(0);
  vi.advanceTimersByTime(450);
  pointer('onPointerDown', 'mouse', 45);
  expect(press).toHaveBeenLastCalledWith('b', false);
  vi.advanceTimersByTime(51);
  expect(play).toHaveBeenCalledExactlyOnceWith(items[0]);
  expect(cancel).not.toHaveBeenCalled();
  pointer('onPointerCancel', 'mouse', 45);
  expect(cancel).toHaveBeenCalledOnce();
  vi.runAllTimers();
  expect(play).toHaveBeenCalledExactlyOnceWith(items[0]);
});

it('cancels the gesture on pointer cancellation, swipes, range selection, and page departure', () => {
  const { input, pointer, click, play, key } = fixture();
  const { press, release, cancel } = input.options.motion;
  pointer('onPointerDown', 'touch', 45);
  pointer('onPointerCancel', 'touch', 45);
  expect(cancel).toHaveBeenCalledOnce();
  pointer('onPointerDown', 'touch', 45);
  pointer('onPointerMove', 'touch', 56);
  expect(cancel).toHaveBeenCalledTimes(2);
  pointer('onPointerUp', 'touch', 56);
  click(1, 1, 'touch');
  vi.mocked(cancel).mockClear();
  pointer('onPointerDown', 'mouse', 45);
  pointer('onPointerMove', 'mouse', 56);
  expect(cancel).toHaveBeenCalledOnce();
  pointer('onPointerUp', 'mouse', 56);
  click(1);
  key(1, ' ', true);
  vi.mocked(press).mockClear();
  pointer('onPointerDown', 'mouse', 15, 0);
  expect(press).not.toHaveBeenCalled();
  pointer('onPointerUp', 'mouse', 15, 0);
  click(0);
  expect(input.selection).toBeNull();
  expect(release).not.toHaveBeenCalled();
  click(1);
  input.cancelPageTap();
  click(2);
  input.suspend();
  click(1);
  key(1, 'f');
  vi.runAllTimers();
  expect(play).not.toHaveBeenCalled();
  click(0, 0);
  expect(play).toHaveBeenCalledTimes(1);
});

it('keeps source-to-viewport capture transfers and cancels when either owner actually loses capture', () => {
  const { input, pointer, click, key, lost, source, root, play, turn } = fixture();
  key(1, ' ', true);
  pointer('onPointerDown', 'mouse', 45);
  source.releasePointerCapture();
  lost(source);
  vi.advanceTimersByTime(500);
  expect(input.pointer).toBeNull();
  click(1);
  expect(input.selection!.selected.size).toBe(1);
  pointer('onPointerDown', 'touch', 45);
  source.releasePointerCapture();
  // Browsers may defer the lostcapture event until the next pointer movement.
  vi.advanceTimersByTime(400);
  expect(input.pointer).toBeNull();
  pointer('onPointerDown', 'mouse', 45);
  pointer('onPointerMove', 'mouse', 89);
  lost(source);
  expect(input.pointer!.drag).toBeDefined();
  root.releasePointerCapture();
  lost(root);
  vi.runAllTimers();
  expect(input.pointer).toBeNull();
  expect([...input.selection!.selected.keys()]).toEqual(['b']);
  expect(play).not.toHaveBeenCalled();
  expect(turn).not.toHaveBeenCalled();
});

it('clears a touch compression when release crosses the swipe threshold without a move event', () => {
  const { input, pointer, play, double } = fixture();
  pointer('onPointerDown', 'touch', 45);
  expect(input.options.motion.press).toHaveBeenCalledWith('b', false);
  pointer('onPointerUp', 'touch', 61);
  expect(input.options.motion.cancel).toHaveBeenCalled();
  expect(input.options.motion.release).not.toHaveBeenCalled();
  vi.runAllTimers();
  expect(play).not.toHaveBeenCalled();
  expect(double).not.toHaveBeenCalled();
});

it('recovers when a delayed capture finds an expired pointer and when a mouse release occurs outside a gap', () => {
  const { input, root, pointer, key, commit } = fixture();
  pointer('onPointerDown', 'mouse', 45, -1);
  expect(input.pointer).toBeNull();
  key(1, ' ', true);
  pointer('onPointerDown', 'touch', 45);
  vi.spyOn(root, 'setPointerCapture').mockImplementationOnce(() => {
    throw new DOMException('pointer no longer active', 'NotFoundError');
  });
  vi.advanceTimersByTime(500);
  expect(input.pointer).toBeNull();
  expect([...input.selection!.selected.keys()]).toEqual(['b']);
  pointer('onPointerDown', 'mouse', 45);
  pointer('onPointerMove', 'mouse', 79);
  pointer('onPointerUp', 'mouse', 79);
  expect(input.selection).toBeNull();
  expect(commit).toHaveBeenCalledExactlyOnceWith(['c']);
});

it('cancels delayed taps on page changes, and restores the committed selection when a drag loses focus', () => {
  const { input, play, turn, pointer, click, key } = fixture();
  click(0);
  input.cancelPageTap();
  vi.runAllTimers();
  expect(play).not.toHaveBeenCalled();
  key(1, ' ', true);
  pointer('onPointerDown', 'mouse', 45);
  pointer('onPointerMove', 'mouse', 89);
  input.cancelPageTap();
  expect(input.pointer!.drag).toBeDefined();
  input.suspend();
  vi.runAllTimers();
  expect(input.pointer).toBeNull();
  expect([...input.selection!.selected.keys()]).toEqual(['b']);
  expect(turn).not.toHaveBeenCalled();
});

it('rechecks pending click and hold identities against a sliding live page', () => {
  const { input, items, pointer, click, play } = fixture();
  click(0);
  input.options = { ...input.options, items: items.slice(1, 4) };
  vi.advanceTimersByTime(501);
  expect(play).not.toHaveBeenCalled();
  click(0);
  const updated = { ...items[1], atMs: 100 };
  input.options = { ...input.options, items: [updated, ...items.slice(2, 4)] };
  vi.advanceTimersByTime(501);
  expect(play).toHaveBeenCalledExactlyOnceWith(updated);
  pointer('onPointerDown', 'touch', 45, 0);
  input.options = { ...input.options, items: items.slice(2, 5) };
  vi.advanceTimersByTime(351);
  expect(input.pointer).toBeNull();
  click(0);
  vi.runAllTimers();
  expect(input.selection).toBeNull();
  expect(play).toHaveBeenCalledTimes(1);
});

it('keeps native click semantics for keyboard, consumes selection edits, and never plays on an outside dismissal', () => {
  const { input, play, double, click, key } = fixture();
  click(1, 0);
  expect(play).toHaveBeenCalledTimes(1);
  key(1, ' ', true);
  expect([...input.selection!.selected.keys()]).toEqual(['b']);
  click(1, 0);
  expect(input.selection!.selected.size).toBe(0);
  click(1, 0);
  expect(input.selection!.selected.has('b')).toBe(true);
  click(0);
  click(0, 2);
  vi.runAllTimers();
  expect(input.selection).toBeNull();
  expect(play).toHaveBeenCalledTimes(1);
  key(1, 'f');
  expect(double).toHaveBeenCalledTimes(1);
});

it('gives immediate selection feedback and restores it when a mouse or touch double tap favorites that card', () => {
  const { input, key, click, double, play, items } = fixture();
  key(1, ' ', true);
  click(1);
  expect(input.selection!.selected.has('b')).toBe(false);
  vi.advanceTimersByTime(100);
  click(1, 2);
  expect(input.selection!.selected.has('b')).toBe(true);
  expect(double).toHaveBeenCalledExactlyOnceWith(items[1]);
  click(1);
  vi.advanceTimersByTime(501);
  expect(input.selection!.selected.has('b')).toBe(false);
  click(1); // Touch-generated clicks may both have detail=1.
  expect(input.selection!.selected.has('b')).toBe(true);
  click(1);
  expect(input.selection!.selected.has('b')).toBe(false);
  expect(double).toHaveBeenCalledTimes(2);
  click(0);
  click(0);
  vi.runAllTimers();
  expect(input.selection).toBeNull();
  expect(double).toHaveBeenCalledTimes(2);
  expect(play).not.toHaveBeenCalled();
});

it.each([
  ['mouse', 420, 130],
  ['touch', 249, 270],
] as const)(
  'pairs a second %s press immediately, even when its release arrives after the first-click deadline',
  (type, gap, hold) => {
    const { input, pointer, click, play, double, items } = fixture();
    pointer('onPointerDown', type, 45);
    pointer('onPointerUp', type, 45);
    click(1, 1, type);
    vi.advanceTimersByTime(gap);
    pointer('onPointerDown', type, 45);
    vi.advanceTimersByTime(hold);
    expect(play).not.toHaveBeenCalled();
    pointer('onPointerUp', type, 45);
    click(1, 1, type);
    vi.runAllTimers();
    expect(play).not.toHaveBeenCalled();
    expect(double).toHaveBeenCalledExactlyOnceWith(items[1]);
    expect(input.selection).toBeNull();
  },
);

it('honors a native double-click count in an existing selection after the application timer elapsed', () => {
  const { key, click, input, double, items, play } = fixture();
  key(1, ' ', true);
  click(1);
  vi.advanceTimersByTime(750);
  click(1, 2);
  expect(input.selection!.selected.has('b')).toBe(true);
  expect(double).toHaveBeenCalledExactlyOnceWith(items[1]);
  expect(play).not.toHaveBeenCalled();
});

it.each(['mouse', 'touch'] as const)(
  'starts a new %s tap after a single play has already committed',
  (type) => {
    const { pointer, click, play, double } = fixture();
    const tap = (detail: number) => {
      pointer('onPointerDown', type, 45);
      pointer('onPointerUp', type, 45);
      click(1, detail, type);
    };
    tap(1);
    vi.advanceTimersByTime(type === 'touch' ? 301 : 501);
    expect(play).toHaveBeenCalledOnce();
    tap(2);
    vi.runAllTimers();
    expect(double).not.toHaveBeenCalled();
    expect(play).toHaveBeenCalledTimes(2);
  },
);

it('delivers touch taps even without clicks and consumes delayed compatibility clicks without intercepting mouse or keyboard input', () => {
  const { pointer, click, key, input, play, double, items } = fixture();
  const tap = (index: number) => {
    pointer('onPointerDown', 'touch', 45, index);
    pointer('onPointerUp', 'touch', 45, index);
  };
  tap(0);
  vi.advanceTimersByTime(301);
  expect(play).toHaveBeenCalledExactlyOnceWith(items[0]);
  key(1, ' ', true);
  tap(1);
  expect(input.selection!.selected.size).toBe(0);
  vi.advanceTimersByTime(220);
  tap(1);
  expect(input.selection!.selected.size).toBe(1);
  expect(double).toHaveBeenCalledExactlyOnceWith(items[1]);
  tap(0);
  expect(input.selection).toBeNull();
  click(0, 1, 'touch');
  pointer('onPointerDown', 'mouse', 45, 2);
  pointer('onPointerUp', 'mouse', 45, 2);
  click(2);
  click(1, 2, 'touch');
  vi.advanceTimersByTime(501);
  expect(play.mock.calls.map(([unit]) => unit.unitId)).toEqual(['a', 'c']);
  click(2, 0);
  expect(play.mock.calls.map(([unit]) => unit.unitId)).toEqual(['a', 'c', 'c']);
  expect(double).toHaveBeenCalledTimes(1);
});

it('uses a later native touch double-click count to confirm a slow pair without toggling selection a third time', () => {
  const { key, pointer, click, input, double, play } = fixture();
  const tap = (index: number, detail: number) => {
    pointer('onPointerDown', 'touch', 45, index);
    pointer('onPointerUp', 'touch', 45, index);
    click(index, detail, 'touch');
  };
  key(1, ' ', true);
  tap(1, 1);
  vi.advanceTimersByTime(600);
  tap(1, 2);
  expect(double).toHaveBeenCalledTimes(1);
  expect(input.selection!.selected.has('b')).toBe(true);
  tap(0, 1);
  vi.advanceTimersByTime(600);
  tap(0, 2);
  vi.runAllTimers();
  expect(double).toHaveBeenCalledTimes(1);
  expect(input.selection).toBeNull();
  expect(play).not.toHaveBeenCalled();
});

it('pairs WebKit mouse-labelled clicks with their touch contact while preserving a genuine mouse press at the same point', () => {
  const { pointer, click, play, double, items } = fixture();
  const touch = () => {
    pointer('onPointerDown', 'touch', 45);
    pointer('onPointerUp', 'touch', 45);
  };
  touch();
  click(1, 1, 'mouse');
  vi.advanceTimersByTime(501);
  expect(play).toHaveBeenCalledExactlyOnceWith(items[1]);
  expect(double).not.toHaveBeenCalled();

  touch();
  click(1, 1, 'mouse');
  vi.advanceTimersByTime(100);
  touch();
  click(1, 2, 'mouse');
  vi.advanceTimersByTime(501);
  expect(double).toHaveBeenCalledExactlyOnceWith(items[1]);
  expect(play).toHaveBeenCalledTimes(1);

  // A touch with no compatibility click leaves a matching position in the queue.
  touch();
  vi.advanceTimersByTime(301);
  pointer('onPointerDown', 'mouse', 45);
  pointer('onPointerUp', 'mouse', 45);
  click(1, 1, 'mouse');
  vi.advanceTimersByTime(501);
  expect(play).toHaveBeenCalledTimes(3);
  click(1, 0);
  expect(play).toHaveBeenCalledTimes(4);
  expect(double).toHaveBeenCalledTimes(1);
});

it('keeps touch swipes as paging and distinguishes a long press from the generated click', () => {
  const { input, turn, play, pointer, click, commit } = fixture();
  pointer('onPointerDown', 'touch', 68);
  pointer('onPointerMove', 'touch', 30);
  vi.advanceTimersByTime(400);
  pointer('onPointerUp', 'touch', 23);
  click(1);
  expect(turn).toHaveBeenCalledExactlyOnceWith(1);
  expect(input.selection).toBeNull();
  pointer('onPointerDown', 'touch', 45);
  vi.advanceTimersByTime(350);
  pointer('onPointerMove', 'touch', 78);
  pointer('onPointerUp', 'touch', 79);
  click(2);
  vi.runAllTimers();
  expect(input.selection).toBeNull();
  expect(commit).toHaveBeenCalledExactlyOnceWith(['b', 'c']);
  expect(play).not.toHaveBeenCalled();
});
it('turns once per ready page, stops at the end, retracts on reverse, and rolls back a cancelled pointer', () => {
  const { input, turn, items, pointer, commit } = fixture();
  pointer('onPointerDown', 'mouse', 45);
  pointer('onPointerMove', 'mouse', 88);
  expect(input.edge).toBe(1);
  vi.advanceTimersByTime(2000);
  expect(turn).toHaveBeenCalledExactlyOnceWith(1);
  input.options = { ...input.options, page: 2, pagePending: true };
  input.refreshPage();
  vi.advanceTimersByTime(1000);
  expect(turn).toHaveBeenCalledTimes(1);
  input.options = { ...input.options, items: items.slice(3), pagePending: false };
  input.refreshPage();
  expect(input.edge).toBe(0);
  expect([...input.pointer!.preview!.selected.keys()]).toEqual(['b', 'c', 'd', 'e', 'f']);
  pointer('onPointerMove', 'mouse', 1);
  expect([...input.pointer!.preview!.selected.keys()]).toEqual(['b', 'c', 'd']);
  expect(input.edge).toBe(-1);
  pointer('onPointerCancel', 'mouse', 1);
  vi.runAllTimers();
  expect(input.selection).toBeNull();
  expect(input.pointer).toBeNull();
  expect(commit).not.toHaveBeenCalled();
  expect(turn).toHaveBeenCalledTimes(1);
});

it('commits the released mouse range once and starts the next gesture from its new anchor', () => {
  const { input, commit, pointer, click, play } = fixture();
  pointer('onPointerDown', 'mouse', 45);
  vi.advanceTimersByTime(500);
  expect(input.pointer?.drag).toBeUndefined();
  pointer('onPointerMove', 'mouse', 79);
  expect(commit).not.toHaveBeenCalled();
  pointer('onPointerUp', 'mouse', 15);
  click(1);
  vi.runAllTimers();
  expect(commit).toHaveBeenCalledExactlyOnceWith(['b', 'a']);
  expect(input.selection).toBeNull();
  expect(play).not.toHaveBeenCalled();

  pointer('onPointerDown', 'mouse', 79, 2);
  pointer('onPointerMove', 'mouse', 45);
  pointer('onPointerUp', 'mouse', 45);
  expect(commit).toHaveBeenLastCalledWith(['c', 'b']);
  expect(commit).toHaveBeenCalledTimes(2);
});

it('cancels a range on Escape and confirms keyboard selection on Enter', () => {
  const { input, pointer, key, click, commit, play } = fixture();
  pointer('onPointerDown', 'mouse', 45);
  pointer('onPointerMove', 'mouse', 79);
  key(1, 'Escape');
  pointer('onPointerUp', 'mouse', 79);
  click(1);
  expect(commit).not.toHaveBeenCalled();

  key(1, ' ', true);
  key(1, 'Enter');
  vi.runAllTimers();
  expect(commit).toHaveBeenCalledExactlyOnceWith(['b']);
  expect(input.selection).toBeNull();
  expect(play).not.toHaveBeenCalled();
});
it('clears pending activations, hold timers and edge timers when the scope is replaced', () => {
  const { input, play, turn, pointer, click } = fixture();
  click(0);
  pointer('onPointerDown', 'touch', 45);
  input.reset();
  click(1);
  vi.runAllTimers();
  expect(play).not.toHaveBeenCalled();
  expect(input.pointer).toBeNull();
  pointer('onPointerDown', 'mouse', 45);
  pointer('onPointerMove', 'mouse', 89);
  input.reset();
  vi.runAllTimers();
  expect(turn).not.toHaveBeenCalled();
});
