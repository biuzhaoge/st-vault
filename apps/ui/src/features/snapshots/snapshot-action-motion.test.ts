import { afterEach, expect, it, vi } from 'vitest';
import { animateSnapshotAction } from './snapshot-action-motion';

function fixture(reduced = false) {
  vi.stubGlobal('window', { matchMedia: () => ({ matches: reduced }) });
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  const previous = { id: 'snapshot-action-favorite', cancel: vi.fn() };
  const unrelated = { id: 'layout', cancel: vi.fn() };
  const animation = { cancel: vi.fn() };
  const mark = {
    animate: vi.fn<(frames: Keyframe[], options: KeyframeAnimationOptions) => typeof animation>(
      () => animation,
    ),
    getAnimations: () => [previous, unrelated],
  };
  const querySelector = vi.fn<() => typeof mark | null>(() => mark);
  const grid = { querySelector } as unknown as HTMLElement;
  return { grid, querySelector, previous, unrelated, mark, animation };
}

afterEach(() => vi.unstubAllGlobals());

it.each([
  ['play', 'playing', 1],
  ['favorite', 'favorite', 1],
  ['unfavorite', 'favorite', 0],
] as const)('animates only the intended mark for %s', (action, markName, endOpacity) => {
  const { grid, querySelector, mark, previous, unrelated, animation } = fixture();
  expect(animateSnapshotAction(grid, 'one', action)).toBe(animation);
  expect(querySelector).toHaveBeenCalledWith(
    `:scope > .snapshot-cell > button[data-key="one"] > .snapshot-${markName}-mark`,
  );
  expect(mark.animate).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ opacity: endOpacity, offset: 1 })]),
    expect.objectContaining({ id: `snapshot-action-${action}`, fill: 'none' }),
  );
  expect(previous.cancel).toHaveBeenCalledTimes(1);
  expect(unrelated.cancel).not.toHaveBeenCalled();
});

it('keeps the playback badge centered throughout the click confirmation', () => {
  const { grid, mark } = fixture();
  animateSnapshotAction(grid, 'one', 'play');
  const [frames] = mark.animate.mock.calls[0];
  for (const frame of frames) expect(frame.transform).toMatch(/^(scale\([.\d]+\)|none)$/);
});

it('uses the persistent state alone with reduced motion or after a card leaves the page', () => {
  const { grid, querySelector, mark } = fixture(true);
  expect(animateSnapshotAction(grid, 'one', 'play')).toBeUndefined();
  expect(mark.animate).not.toHaveBeenCalled();
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  expect(animateSnapshotAction(null, 'one', 'favorite')).toBeUndefined();
  querySelector.mockReturnValueOnce(null);
  expect(animateSnapshotAction(grid, 'one', 'unfavorite')).toBeUndefined();
});
