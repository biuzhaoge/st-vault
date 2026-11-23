import { tr } from '../../shared/lib/i18n';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import type { RowAnchor, RowAnchorStore } from './row-anchor';
import { Icon } from '../../design/Icon';
import { connectionGeometry } from './connection-geometry';
import { createPortal } from 'react-dom';
export function RowConnection({
  anchor: anchorStore,
  workspace,
  viewer,
  name,
  onClose,
}: {
  anchor: RowAnchorStore;
  workspace: RefObject<HTMLDivElement>;
  viewer: RefObject<HTMLElement>;
  name: string;
  onClose: () => void;
}): JSX.Element {
  const anchor = useSyncExternalStore(
    anchorStore.subscribe,
    anchorStore.snapshot,
    anchorStore.snapshot,
  );
  const rail = useRef<HTMLDivElement>(null);
  const [fullscreenTarget, setFullscreenTarget] = useState<Element | null>(null);
  useLayoutEffect(() => {
    const update = (): void => setFullscreenTarget(document.fullscreenElement);
    document.addEventListener('fullscreenchange', update);
    return () => document.removeEventListener('fullscreenchange', update);
  }, []);
  const [geometry, setGeometry] = useState<
    | (ReturnType<typeof connectionGeometry> & {
        offscreen: RowAnchor['offscreen'];
        attached: boolean;
      })
    | null
  >(null);
  // The workspace is an ancestor ref: subscribe after the whole commit, when
  // that ref is attached, rather than abandoning setup in a child layout effect.
  useEffect(() => {
    if (!rail.current || !viewer.current || !workspace.current) {
      setGeometry(null);
      return;
    }
    const workspaceElement = workspace.current;
    let frameId: number | undefined;
    const measure = (): void => {
      frameId = undefined;
      const anchor = anchorStore.snapshot();
      if (!anchor) {
        setGeometry(null);
        return;
      }
      const box = (fullscreenTarget ?? rail.current)?.getBoundingClientRect();
      const frame = (fullscreenTarget ?? viewer.current)?.getBoundingClientRect();
      if (!box || !frame) return;
      const scroller = workspaceElement.querySelector<HTMLElement>('.track-table-scroll');
      const viewport = scroller?.getBoundingClientRect();
      const viewportBottom = viewport && scroller ? viewport.top + scroller.clientHeight : 0;
      const row =
        scroller?.querySelector('.track-row-motion-ghost.selected') ??
        scroller?.querySelector('.track-row.selected');
      const node = row?.querySelector('.record-button') ?? row?.querySelector('.track-cover-wrap');
      const coverPort = node?.getBoundingClientRect();
      const targetY = coverPort ? coverPort.top + coverPort.height / 2 : anchor.y;
      let offscreen = anchor.offscreen;
      if (coverPort && viewport && offscreen !== 'filtered') {
        offscreen = targetY < viewport.top ? 'above' : targetY >= viewportBottom ? 'below' : null;
      }
      const attached = !offscreen && !!coverPort;
      let y = targetY;
      if (viewport && offscreen) y = offscreen === 'below' ? viewportBottom - 7 : viewport.top + 7;
      const next = {
        ...connectionGeometry(
          box,
          { right: frame.right - 16, top: frame.top + 16, height: 0 },
          y,
          attached ? coverPort?.left : undefined,
        ),
        offscreen,
        attached,
      };
      setGeometry((current) =>
        current?.route === next.route &&
        current.offscreen === offscreen &&
        current.attached === attached
          ? current
          : next,
      );
    };
    const schedule = (): void => {
      frameId ??= window.requestAnimationFrame(measure);
    };
    measure();
    const unsubscribe = anchorStore.subscribe(schedule);
    const observer = new ResizeObserver(schedule);
    observer.observe(rail.current);
    observer.observe(viewer.current);
    observer.observe(workspace.current);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    workspaceElement.addEventListener('stv-row-motion', schedule);
    return () => {
      unsubscribe();
      if (frameId !== undefined) window.cancelAnimationFrame(frameId);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      workspaceElement.removeEventListener('stv-row-motion', schedule);
    };
  }, [anchorStore, workspace, viewer, fullscreenTarget]);
  const disconnect = geometry && (
    <button
      className="connection-close"
      style={{ left: geometry.startX, top: geometry.y }}
      aria-label={tr('关闭播放器')}
      title={tr('断开连接 · 关闭播放器')}
      onClick={onClose}
    >
      <Icon name="link-off" />
    </button>
  );
  return (
    <div ref={rail} className="connection-rail" data-connected={!!anchor} aria-hidden={!anchor}>
      {anchor && geometry && (
        <>
          <svg
            className="row-connection"
            aria-label={tr('{{v0}} 播放连接', { v0: name })}
            data-offscreen={geometry.offscreen ?? 'visible'}
          >
            <title>{name}</title>
            <path className="connection-bus" d={geometry.route} />
            <path className="connection-signal" d={geometry.route} />
            {!geometry.attached && <circle cx={geometry.endX} cy={geometry.endY} r="2" />}
            {(geometry.offscreen === 'above' || geometry.offscreen === 'below') && (
              <path
                className="connection-arrow"
                d={
                  geometry.offscreen === 'below'
                    ? `M ${geometry.endX - 7} ${geometry.endY - 6} l 4 5 4 -5`
                    : `M ${geometry.endX - 7} ${geometry.endY + 6} l 4 -5 4 5`
                }
              />
            )}
          </svg>
          {fullscreenTarget ? createPortal(disconnect, fullscreenTarget) : disconnect}
        </>
      )}
    </div>
  );
}
