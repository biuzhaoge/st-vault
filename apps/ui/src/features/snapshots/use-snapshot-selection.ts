import {
  useLayoutEffect,
  useReducer,
  useState,
  type HTMLAttributes,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import type { SnapshotItem } from '@st-vault/api-schema';
import type { SnapshotGestureMotion } from './snapshot-gesture-motion';
import {
  SnapshotActivation,
  SnapshotRangeDrag,
  toggleSnapshot,
  type SnapshotSelection,
} from './snapshot-selection';

type Direction = -1 | 0 | 1;
interface Options {
  scope: string;
  page: number;
  items: SnapshotItem[];
  pagePending: boolean;
  motion: Pick<SnapshotGestureMotion, 'press' | 'release' | 'cancel'>;
  canTurnPage?: (direction: -1 | 1) => boolean;
  turnPage: (direction: -1 | 1) => void;
  onPlay: (item: SnapshotItem) => void;
  onDoubleClick: (item: SnapshotItem) => void;
  canCommitRange?: () => boolean;
  onRangeCommit: (ids: string[]) => void;
}
interface Pointer {
  id: number;
  touch: boolean;
  root: HTMLDivElement;
  start: SnapshotItem | null;
  startX: number;
  startY: number;
  x: number;
  y: number;
  capture?: Element;
  swipe?: 'x' | 'y';
  drag?: SnapshotRangeDrag;
  endpoint?: string;
  preview?: SnapshotSelection;
}
const empty: ReadonlyMap<string, SnapshotItem> = new Map();
const buttonSelector = '.snapshot-grid button[data-unit-index]';
const otherControl = (target: Element) => {
  const button = target.closest('button');
  return !!button && !button.matches(buttonSelector);
};

/** Pointer capture stays on the viewport across page changes. Only the current
 * pointer contributes a preview; cancelling it leaves the committed selection intact. */
export class SnapshotInput {
  selection: SnapshotSelection | null = null;
  pointer: Pointer | null = null;
  edge: Direction = 0;
  private pressTimer?: ReturnType<typeof setTimeout>;
  private edgeTimer?: ReturnType<typeof setTimeout>;
  private turnedPage?: number;
  private suppressClick = false;
  private lastPointerWasTouch = false;
  private touches: { id: number; x: number; y: number; at: number; unitId?: string }[] = [];
  private dismissedUnit?: string;
  private readonly activation = new SnapshotActivation();
  constructor(
    public options: Options,
    private readonly changed: () => void,
  ) {}
  private get clickWindowMs(): number {
    return this.lastPointerWasTouch ? 300 : 500;
  }

  private stopEdge(): void {
    clearTimeout(this.edgeTimer);
    this.edgeTimer = undefined;
    this.turnedPage = undefined;
    this.edge = 0;
  }
  private release(): void {
    clearTimeout(this.pressTimer);
    this.stopEdge();
    const pointer = this.pointer;
    this.pointer = null;
    if (pointer?.root.hasPointerCapture(pointer.id)) pointer.root.releasePointerCapture(pointer.id);
    else if (pointer?.capture?.hasPointerCapture(pointer.id))
      pointer.capture.releasePointerCapture(pointer.id);
  }
  reset = (): void => {
    this.options.motion.cancel();
    this.suppressClick ||= !!this.pointer;
    this.release();
    this.activation.cancel();
    this.selection = null;
    this.dismissedUnit = undefined;
  };
  clear = (): void => {
    this.reset();
    this.changed();
  };
  cancelPageTap = (): void => {
    this.options.motion.cancel();
    this.activation.cancel();
    if (this.pointer && !this.pointer.drag) this.suspend();
  };
  suspend = (): void => {
    this.options.motion.cancel();
    this.activation.cancel();
    if (!this.pointer) return;
    this.suppressClick = true;
    this.release();
    this.changed();
  };

  private capture(pointer: Pointer, owner: Element): boolean {
    if (owner.isConnected) {
      try {
        owner.setPointerCapture(pointer.id);
        if (owner.hasPointerCapture(pointer.id)) return true;
      } catch (error) {
        // A queued hold may outlive the native pointer after focus or its target is lost.
        if (!(error instanceof DOMException && error.name === 'NotFoundError')) throw error;
      }
    }
    this.suspend();
    return false;
  }
  private currentItem(key: string): SnapshotItem | undefined {
    return this.options.pagePending
      ? undefined
      : this.options.items.find((item) => item.unitId === key);
  }
  private item(node: Element | null): SnapshotItem | undefined {
    const key = node?.closest<HTMLElement>('.snapshot-grid .snapshot-cell[data-key]')?.dataset.key;
    return key ? this.currentItem(key) : undefined;
  }
  private hit(pointer: Pointer): SnapshotItem | undefined {
    const bounds = pointer.root.getBoundingClientRect();
    if (!bounds.width || !bounds.height || this.options.pagePending) return undefined;
    const grid = pointer.root.querySelector<HTMLElement>('.snapshot-grid');
    if (!grid) return undefined;
    const x =
      ((pointer.x - bounds.left) * pointer.root.offsetWidth) / bounds.width - grid.offsetLeft;
    const y =
      ((pointer.y - bounds.top) * pointer.root.offsetHeight) / bounds.height - grid.offsetTop;
    // Page transitions translate the live surface and retain inert ghosts. Layout
    // coordinates of its real cards keep the stationary pointer on the intended row.
    let nearest: HTMLElement | null = null,
      distance = Infinity;
    for (const cell of grid.querySelectorAll<HTMLElement>(':scope > .snapshot-cell[data-key]')) {
      const dx = Math.max(0, cell.offsetLeft - x, x - cell.offsetLeft - cell.offsetWidth);
      const dy = Math.max(0, cell.offsetTop - y, y - cell.offsetTop - cell.offsetHeight);
      const squared = dx * dx + dy * dy;
      if (squared < distance) {
        nearest = cell;
        distance = squared;
      }
    }
    return this.item(nearest);
  }
  private updateEdge(pointer: Pointer): boolean {
    const rect = pointer.root.getBoundingClientRect();
    const band = Math.min(24, rect.height / 4);
    let edge: Direction = 0;
    if (pointer.x >= rect.left && pointer.x <= rect.right && band > 0) {
      if (pointer.y <= rect.top + band) edge = -1;
      else if (pointer.y >= rect.bottom - band) edge = 1;
    }
    if (edge && this.options.canTurnPage?.(edge) === false) edge = 0;
    const changed = edge !== this.edge;
    if (changed) {
      this.stopEdge();
      this.edge = edge;
    }
    if (
      edge &&
      !this.options.pagePending &&
      this.turnedPage !== this.options.page &&
      !this.edgeTimer
    ) {
      const direction = edge;
      this.edgeTimer = setTimeout(() => {
        this.edgeTimer = undefined;
        if (
          this.pointer !== pointer ||
          this.edge !== direction ||
          this.options.pagePending ||
          this.options.canTurnPage?.(direction) === false
        )
          return;
        this.turnedPage = this.options.page;
        this.options.turnPage(direction);
      }, 450);
    }
    return changed;
  }
  refreshPage = (): void => {
    const pointer = this.pointer;
    if (!pointer?.drag || this.options.pagePending) return;
    pointer.drag.visit(this.options.items);
    pointer.endpoint = undefined;
    this.moveDrag(pointer);
  };
  private moveDrag(pointer: Pointer): void {
    const item = this.hit(pointer);
    const moved = !!(item && pointer.drag && item.unitId !== pointer.endpoint);
    if (moved && item && pointer.drag) {
      pointer.preview = pointer.drag.to(item);
      pointer.endpoint = item.unitId;
    }
    if (this.updateEdge(pointer) || moved) this.changed();
  }
  private begin(pointer: Pointer): void {
    if (this.pointer !== pointer || !pointer.start || pointer.swipe) return;
    const anchor = this.currentItem(pointer.start.unitId);
    // Capture may already be gone while the browser awaits another pointer
    // event to deliver lostpointercapture. A hold must never reacquire it.
    if (
      !anchor ||
      !pointer.capture?.hasPointerCapture(pointer.id) ||
      this.options.canCommitRange?.() === false
    ) {
      this.suspend();
      return;
    }
    if (!this.capture(pointer, pointer.root)) return;
    this.options.motion.cancel();
    this.activation.cancel();
    clearTimeout(this.pressTimer);
    pointer.drag = new SnapshotRangeDrag(anchor, this.selection);
    pointer.drag.visit(this.options.items);
    const endpoint = this.hit(pointer) ?? anchor;
    pointer.preview = pointer.drag.to(endpoint);
    pointer.endpoint = endpoint.unitId;
    this.suppressClick = true;
    this.updateEdge(pointer);
    this.changed();
  }
  private down = (event: PointerEvent<HTMLDivElement>): void => {
    if (!event.isPrimary || event.button !== 0 || this.pointer) return;
    this.lastPointerWasTouch = event.pointerType !== 'mouse';
    const target = event.target as Element;
    this.suppressClick = false;
    if (otherControl(target)) return;
    const item = this.item(target) ?? null;
    if (!item && event.pointerType === 'mouse') return;
    const pointer: Pointer = {
      id: event.pointerId,
      touch: this.lastPointerWasTouch,
      root: event.currentTarget,
      start: item,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
    };
    this.pointer = pointer;
    const owner = target.closest(buttonSelector) ?? pointer.root;
    pointer.capture = owner;
    if (!this.capture(pointer, owner)) return;
    if (item) {
      this.activation.hold(item);
      if (pointer.touch) this.pressTimer = setTimeout(() => this.begin(pointer), 350);
      if (!this.selection)
        this.options.motion.press(item.unitId, this.activation.pendingPlayId === item.unitId);
    }
  };
  private move = (event: PointerEvent<HTMLDivElement>): void => {
    const p = this.pointer;
    if (p?.id !== event.pointerId) return;
    p.x = event.clientX;
    p.y = event.clientY;
    if (p.drag) {
      this.moveDrag(p);
      return;
    }
    const dx = Math.abs(p.x - p.startX),
      dy = Math.abs(p.y - p.startY);
    if (p.touch) {
      if (p.swipe || Math.max(dx, dy) < 8) return;
      clearTimeout(this.pressTimer);
      this.options.motion.cancel();
      this.activation.cancel();
      p.swipe = dy > dx ? 'y' : 'x';
      if (p.swipe === 'y') this.capture(p, p.root);
    } else if (p.start && Math.hypot(dx, dy) >= 6) this.begin(p);
  };
  private up = (event: PointerEvent<HTMLDivElement>): void => {
    const p = this.pointer;
    if (p?.id !== event.pointerId) return;
    p.x = event.clientX;
    p.y = event.clientY;
    if (p.drag) {
      this.moveDrag(p);
      this.suppressClick = true;
    } else if (p.touch) {
      const dx = Math.abs(p.x - p.startX),
        dy = p.y - p.startY;
      this.suppressClick = !!p.swipe || Math.max(dx, Math.abs(dy)) >= 8;
      if (p.swipe !== 'x' && Math.abs(dy) >= 32 && Math.abs(dy) > dx)
        this.options.turnPage(dy < 0 ? 1 : -1);
    }
    if (this.suppressClick) {
      this.options.motion.cancel();
      this.activation.cancel();
    } else if (p.start) {
      if (!this.selection) this.options.motion.release(this.clickWindowMs);
      this.activation.resume(p.start);
    }
    this.release();
    if (p.touch) {
      const now = performance.now();
      this.touches = this.touches.filter((touch) => now - touch.at <= 1000);
      this.touches.push({
        id: p.id,
        x: p.x,
        y: p.y,
        at: now,
        unitId: this.suppressClick ? undefined : p.start?.unitId,
      });
      if (!this.suppressClick) {
        const item = p.start && this.currentItem(p.start.unitId);
        if (item || !p.start) this.activate(item ?? undefined, 1);
      }
    }
    if (p.drag) this.commitRange(p.preview);
  };
  private commitRange(selection: SnapshotSelection | undefined): void {
    this.selection = null;
    this.changed();
    if (selection?.selected.size) this.options.onRangeCommit([...selection.selected.keys()]);
  }
  private consumeTouchClick(event: MouseEvent<HTMLDivElement>): boolean {
    if (!event.detail) return false;
    const native = event.nativeEvent as globalThis.MouseEvent &
      Partial<globalThis.PointerEvent> & {
        sourceCapabilities?: { firesTouchEvents: boolean };
      };
    const explicitTouch =
      native.pointerType === 'touch' ||
      native.pointerType === 'pen' ||
      native.sourceCapabilities?.firesTouchEvents === true;
    // WebKit labels the compatibility click "mouse" without a mouse pointerdown.
    if (!explicitTouch && !this.lastPointerWasTouch) return false;
    const now = performance.now();
    const index = this.touches.findIndex(
      (tap) =>
        now - tap.at <= 1000 &&
        ((explicitTouch && tap.id === native.pointerId) ||
          (Math.abs(tap.x - event.clientX) < 8 && Math.abs(tap.y - event.clientY) < 8)),
    );
    if (index < 0) return false;
    const [touch] = this.touches.splice(index, 1);
    if (event.detail === 2 && touch.unitId) {
      const item = this.item(event.target as Element);
      if (item?.unitId === touch.unitId) this.activation.confirmDouble(item);
    }
    return true;
  }
  private activate(item: SnapshotItem | undefined, detail: number): void {
    if (!item) {
      if (this.selection && !this.options.pagePending) this.clear();
      return;
    }
    const timing = { waitMs: this.clickWindowMs, nativeDouble: detail === 2 };
    if (this.selection) {
      this.selection = toggleSnapshot(this.selection, item);
      this.dismissedUnit = this.selection ? undefined : item.unitId;
      if (!this.selection || detail === 0) this.activation.cancel();
      // Each tap updates its card immediately. A pair restores the initial selection.
      if (detail)
        this.activation.click(item, {
          ...timing,
          double: this.selection ? (unit) => this.options.onDoubleClick(unit) : undefined,
        });
      this.changed();
      return;
    }
    if (detail > 1 && this.dismissedUnit === item.unitId) {
      this.activation.cancel();
      return;
    }
    this.dismissedUnit = undefined;
    if (detail === 0) {
      this.options.motion.cancel();
      this.activation.cancel();
      this.options.onPlay(item);
    } else
      this.activation.click(item, {
        ...timing,
        single: (unit) => {
          const current = this.currentItem(unit.unitId);
          if (current) this.options.onPlay(current);
        },
        double: (unit) => this.options.onDoubleClick(unit),
      });
  }
  private cancel = (event: PointerEvent<HTMLDivElement>): void => {
    if (this.pointer?.id === event.pointerId) this.suspend();
  };
  readonly viewportProps: HTMLAttributes<HTMLDivElement> = {
    onPointerDown: this.down,
    onPointerMove: this.move,
    onPointerUp: this.up,
    onPointerCancel: this.cancel,
    onLostPointerCapture: (event) => {
      const p = this.pointer;
      // A source button also emits this event when its capture moves to the viewport.
      if (
        p?.id === event.pointerId &&
        !p.root.hasPointerCapture(p.id) &&
        !p.capture?.hasPointerCapture(p.id)
      )
        this.suspend();
    },
    onDragStart: (event) => event.preventDefault(),
    onContextMenu: (event) => {
      if (this.pointer?.start) event.preventDefault();
    },
    onClick: (event) => {
      const target = event.target as Element;
      if (otherControl(target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (this.pointer?.drag) return;
      if (this.consumeTouchClick(event)) return;
      if (event.detail && this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      this.activate(this.item(target), event.detail);
    },
    onKeyDownCapture: (event) => {
      if (event.key === 'Escape' && (this.selection || this.pointer?.drag)) {
        event.preventDefault();
        event.stopPropagation();
        this.clear();
        return;
      }
      if (event.altKey || event.metaKey || event.ctrlKey || event.repeat) return;
      if (this.pointer?.drag) return;
      const target = event.target as Element;
      if (!target.closest(buttonSelector)) return;
      const item = this.item(target);
      if (!item) return;
      if (event.key === 'Enter' && this.selection) {
        event.preventDefault();
        event.stopPropagation();
        this.activation.cancel();
        if (this.options.canCommitRange?.() !== false) this.commitRange(this.selection);
      } else if (event.key.toLowerCase() === 'f' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        this.activation.cancel();
        this.options.onDoubleClick(item);
      } else if (event.key === ' ' && event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        this.activation.cancel();
        this.options.motion.cancel();
        this.selection = this.selection
          ? toggleSnapshot(this.selection, item)
          : new SnapshotRangeDrag(item, null).to(item);
        this.changed();
      }
    },
  };
}

export function useSnapshotSelection(options: Options) {
  const [, changed] = useReducer((value: number) => value + 1, 0);
  const [input] = useState(() => new SnapshotInput(options, changed));
  useLayoutEffect(() => {
    input.options = options;
  });
  useLayoutEffect(() => {
    input.clear();
    return input.reset;
  }, [input, options.scope]);
  useLayoutEffect(input.cancelPageTap, [input, options.page]);
  useLayoutEffect(() => {
    const visibility = () => {
      if (document.hidden) input.suspend();
    };
    window.addEventListener('blur', input.suspend);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      window.removeEventListener('blur', input.suspend);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [input]);
  const previous = options.canTurnPage?.(-1) ?? true,
    next = options.canTurnPage?.(1) ?? true;
  useLayoutEffect(input.refreshPage, [
    input,
    options.items,
    options.page,
    options.pagePending,
    previous,
    next,
  ]);
  const selection = input.pointer?.preview ?? input.selection;
  return {
    viewportProps: input.viewportProps,
    selected: selection?.selected ?? empty,
    selectionActive: !!selection,
    dragging: !!input.pointer?.drag,
    edgeDirection: input.edge,
    clearSelection: input.clear,
  };
}
