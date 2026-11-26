import { afterEach, expect, it, vi } from 'vitest';
import { SnapshotGestureMotion } from './snapshot-gesture-motion';

function fixture() {
  const animations: {
    id: string;
    currentTime: number;
    pause: ReturnType<typeof vi.fn>;
    play: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    onfinish?: () => void;
  }[] = [];
  const surface = {
    animate: vi.fn((_frames: Keyframe[], options: KeyframeAnimationOptions) => {
      const animation = {
        id: options.id!,
        currentTime: 0,
        cancel: vi.fn(),
        pause: vi.fn(),
        play: vi.fn(),
      };
      animations.push(animation);
      return animation;
    }),
  };
  const querySelector = vi.fn(() => surface);
  const motion = new SnapshotGestureMotion({
    current: { querySelector } as unknown as HTMLElement,
  });
  const style = { transform: 'none' };
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) });
  vi.stubGlobal('getComputedStyle', () => style);
  vi.stubGlobal('CSS', { escape: (key: string) => key });
  return { animations, surface, motion, style, querySelector };
}
afterEach(() => vi.unstubAllGlobals());

it('gives a same-frame tap a visible compression before returning through the double-click window', () => {
  const { motion, surface, animations, querySelector } = fixture();
  motion.press('a', false);
  expect(querySelector.mock.calls[0]).toContain(
    ':scope > .snapshot-cell > button[data-key="a"] > .snapshot-picture',
  );
  motion.release(300);
  const [frames, options] = surface.animate.mock.calls[1];
  expect(frames.map((f) => f.transform)).toEqual(['none', 'scale(.965)', 'none']);
  expect(options).toMatchObject({ id: 'snapshot-gesture-return', duration: 300, fill: 'none' });
  expect(animations[0].cancel).toHaveBeenCalledOnce();
});

it('continues from a held press and freezes the actual return until a double tap resolves', () => {
  const { motion, surface, animations, style } = fixture();
  motion.press('a', false);
  animations[0].currentTime = 85;
  style.transform = 'matrix(0.965, 0, 0, 0.965, 0, 0)';
  motion.release(500);
  expect(surface.animate.mock.calls[1][0].map((f) => f.transform)).toEqual([
    style.transform,
    'none',
  ]);
  motion.press('a', true);
  expect(animations[1].pause).toHaveBeenCalledOnce();
  expect(surface.animate).toHaveBeenCalledTimes(2);
  style.transform = 'matrix(0.982, 0, 0, 0.982, 0, 0)';
  motion.release(500);
  motion.favorite('a');
  const [frames, options] = surface.animate.mock.calls[2];
  expect(frames[0].transform).toBe(style.transform);
  expect(frames.at(-1)?.transform).toBe('none');
  expect(frames.some((f) => String(f.transform).includes('rotate(-'))).toBe(true);
  expect(frames.some((f) => /rotate\(\d/.test(String(f.transform)))).toBe(true);
  expect(options.id).toBe('snapshot-gesture-favorite');
  expect(animations[1].cancel).toHaveBeenCalledOnce();
  motion.cancel();
  expect(animations[2].cancel).toHaveBeenCalledOnce();
});

it('cancels the old surface without animating when the preference changes to reduced motion', () => {
  const { motion, surface, animations } = fixture();
  motion.press('a', false);
  vi.stubGlobal('window', { matchMedia: () => ({ matches: true }) });
  motion.release(300);
  motion.favorite('a');
  motion.press('a', true);
  expect(surface.animate).toHaveBeenCalledTimes(1);
  expect(animations[0].cancel).toHaveBeenCalledOnce();
});
