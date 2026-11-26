import { prefersReducedMotion } from '../../design/use-reduced-motion';

const feedback = {
  play: {
    mark: 'playing',
    duration: 250,
    frames: [
      { transform: 'scale(.84)', opacity: 0.65 },
      { transform: 'scale(1.08)', opacity: 1, offset: 0.48 },
      { transform: 'none', opacity: 1, offset: 1 },
    ],
  },
  favorite: {
    mark: 'favorite',
    duration: 390,
    frames: [
      { transform: 'scale(.58)', opacity: 0.45 },
      { transform: 'scale(1.28)', opacity: 1, offset: 0.42 },
      { transform: 'scale(.96)', opacity: 1, offset: 0.76 },
      { transform: 'none', opacity: 1, offset: 1 },
    ],
  },
  unfavorite: {
    mark: 'favorite',
    duration: 240,
    frames: [
      { transform: 'none', opacity: 1 },
      { transform: 'scale(1.08)', opacity: 1, offset: 0.26 },
      { transform: 'scale(.54)', opacity: 0, offset: 1 },
    ],
  },
};

/** The gesture has resolved. Animate its mark once, then let the live state own its paint. */
export function animateSnapshotAction(
  grid: HTMLElement | null,
  unitId: string,
  action: keyof typeof feedback,
): Animation | undefined {
  if (!grid || prefersReducedMotion()) return;
  const { mark, duration, frames } = feedback[action];
  const node = grid.querySelector<HTMLElement>(
    `:scope > .snapshot-cell > button[data-key="${CSS.escape(unitId)}"] > .snapshot-${mark}-mark`,
  );
  if (!node?.animate) return;
  for (const animation of node.getAnimations())
    if (animation.id.startsWith('snapshot-action-')) animation.cancel();
  return node.animate(frames, {
    id: `snapshot-action-${action}`,
    duration,
    easing: 'cubic-bezier(.22,.72,.3,1)',
    fill: 'none',
  });
}
