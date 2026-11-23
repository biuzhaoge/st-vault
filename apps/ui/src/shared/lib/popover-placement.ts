export type PopoverSide = 'above' | 'below';
interface PopoverViewport {
  width: number;
  height: number;
  left?: number;
  top?: number;
  layoutHeight?: number;
}

export function visiblePopoverViewport(): PopoverViewport {
  const visual = window.visualViewport;
  return visual
    ? {
        width: visual.width,
        height: visual.height,
        left: visual.offsetLeft,
        top: visual.offsetTop,
        layoutHeight: window.innerHeight,
      }
    : { width: window.innerWidth, height: window.innerHeight };
}

export function popoverPlacement(
  anchor: { left: number; top: number; bottom: number },
  panel: { width: number; height: number },
  viewport: PopoverViewport,
  preferredSide?: PopoverSide,
): { side: PopoverSide; left: number; top?: number; bottom?: number; maxHeight: number } {
  const left = (viewport.left ?? 0) + 12;
  const top = (viewport.top ?? 0) + 12;
  const right = left + viewport.width - 24;
  const bottom = top + viewport.height - 24;
  const below = Math.max(top, Math.min(anchor.bottom + 8, bottom));
  const above = Math.max(top, Math.min(anchor.top - 8, bottom));
  const spaceBelow = bottom - below;
  const spaceAbove = above - top;
  const side =
    preferredSide ?? (panel.height <= spaceBelow || spaceBelow >= spaceAbove ? 'below' : 'above');
  return {
    side,
    left: Math.max(left, Math.min(anchor.left, right - panel.width)),
    ...(side === 'below'
      ? { top: below }
      : { bottom: (viewport.layoutHeight ?? viewport.height) - above }),
    maxHeight: Math.max(0, side === 'below' ? spaceBelow : spaceAbove),
  };
}
