import { useRef, type HTMLAttributes } from 'react';

/** A tap stays with the original button. Only a vertical swipe takes pointer capture. */
export function useSnapshotSwipe(
  scope: string,
  turn: (direction: -1 | 1) => void,
): HTMLAttributes<HTMLDivElement> {
  const start = useRef<{
    pointerId: number;
    x: number;
    y: number;
    scope: string;
    axis: 'x' | 'y' | null;
  } | null>(null);
  const suppressClick = useRef(false);
  return {
    onPointerDown(event) {
      if (!event.isPrimary || event.button !== 0) return;
      suppressClick.current = false;
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return;
      start.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        scope,
        axis: null,
      };
    },
    onPointerMove(event) {
      const gesture = start.current;
      if (gesture?.pointerId !== event.pointerId || gesture.axis) return;
      const dx = Math.abs(event.clientX - gesture.x),
        dy = Math.abs(event.clientY - gesture.y);
      if (Math.max(dx, dy) < 8) return;
      gesture.axis = dy > dx ? 'y' : 'x';
      if (gesture.axis === 'y') event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerUp(event) {
      const gesture = start.current;
      if (gesture?.pointerId !== event.pointerId) return;
      start.current = null;
      const dx = Math.abs(event.clientX - gesture.x),
        dy = event.clientY - gesture.y;
      suppressClick.current = !!gesture.axis || Math.max(dx, Math.abs(dy)) >= 8;
      if (
        gesture.scope === scope &&
        gesture.axis !== 'x' &&
        Math.abs(dy) >= 32 &&
        Math.abs(dy) > dx
      )
        turn(dy < 0 ? 1 : -1);
    },
    onPointerCancel(event) {
      if (start.current?.pointerId === event.pointerId) start.current = null;
    },
    onClickCapture(event) {
      if (!suppressClick.current || event.detail === 0) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
