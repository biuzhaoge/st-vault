import type { RefObject } from 'react';
import { prefersReducedMotion } from '../../design/use-reduced-motion';

const compressed = 'scale(.965)';
const settle = 'cubic-bezier(.2,.7,.3,1)';

/** A captured button stays still. One interruptible motion owns its photograph. */
export class SnapshotGestureMotion {
  private active?: { surface: HTMLElement; animation: Animation };
  constructor(private readonly grid: RefObject<HTMLElement>) {}

  private surface(unitId: string): HTMLElement | undefined {
    return (
      this.grid.current?.querySelector<HTMLElement>(
        `:scope > .snapshot-cell > button[data-key="${CSS.escape(unitId)}"] > .snapshot-picture`,
      ) ?? undefined
    );
  }

  private move(
    surface: HTMLElement | undefined,
    phase: 'press' | 'return' | 'favorite',
    duration: number,
    frames: Keyframe[],
  ): void {
    if (!surface?.animate || prefersReducedMotion()) {
      this.cancel();
      return;
    }
    // Sample before cancelling: the next gesture picks up the exact rendered pose, even mid-rotation.
    const from = this.active?.surface === surface ? getComputedStyle(surface).transform : 'none';
    this.cancel();
    const animation = surface.animate([{ transform: from, easing: settle }, ...frames], {
      id: `snapshot-gesture-${phase}`,
      duration,
      fill: phase === 'press' ? 'forwards' : 'none',
    });
    this.active = { surface, animation };
    if (phase !== 'press')
      animation.onfinish = () => {
        if (this.active?.animation === animation) this.active = undefined;
      };
  }

  press(unitId: string, continuing: boolean): void {
    const surface = this.surface(unitId);
    if (continuing && this.active && this.active.surface === surface && !prefersReducedMotion()) {
      this.active.animation.pause();
      return;
    }
    this.move(surface, 'press', 85, [{ transform: compressed }]);
  }

  release(waitMs: number): void {
    if (!this.active) return;
    const { surface, animation } = this.active;
    if (prefersReducedMotion()) {
      this.cancel();
      return;
    }
    if (animation.id === 'snapshot-gesture-return') {
      // The following click resolves the double tap. A rejected action can still recover naturally.
      animation.play();
      return;
    }
    // A tap can end before its first painted frame. Complete the dip in the same return animation.
    const frames: Keyframe[] =
      Number(animation.currentTime) < 65
        ? [{ transform: compressed, offset: 0.13, easing: settle }]
        : [];
    frames.push({ transform: 'none' });
    this.move(surface, 'return', waitMs, frames);
  }

  favorite(unitId: string): void {
    this.move(this.surface(unitId), 'favorite', 310, [
      { transform: 'scale(.975) rotate(-2.6deg)', offset: 0.24, easing: 'ease-in-out' },
      { transform: 'scale(.995) rotate(1.7deg)', offset: 0.52, easing: 'ease-in-out' },
      { transform: 'rotate(-.65deg)', offset: 0.76, easing: settle },
      { transform: 'none' },
    ]);
  }

  cancel(): void {
    if (!this.active) return;
    this.active.animation.onfinish = null;
    this.active.animation.cancel();
    this.active = undefined;
  }
}
