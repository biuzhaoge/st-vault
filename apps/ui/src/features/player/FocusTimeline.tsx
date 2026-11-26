import { tr } from '../../shared/lib/i18n';
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useLayoutMotion } from '../../design/use-layout-motion';
import type { ViewWindow } from '../timeline/range-control';
import { useDisplayClock } from '../../shared/lib/sync';
import { useFocusTrackData } from '../timeline/use-track-data';
import { TimelineBands } from '../timeline/TimelineBands';
import { aggregateWindow } from '../timeline/range-control';
import { usePlaybackClock, type PlaybackClock } from './playback-clock';
import { fullCalendar, type ArchiveCalendar } from '../timeline/archive-calendar';
/** Coverage changes with data and wall time, not with every decoded media frame.
 * Its own subscriptions preserve language, live clipping and deletion updates. */
const FocusBands = memo(function FocusBands(props: ComponentProps<typeof TimelineBands>) {
  useTranslation();
  const [nowMs, setNowMs] = useState(Date.now());
  useDisplayClock(setNowMs, !!props.data);
  return <TimelineBands {...props} nowMs={nowMs} />;
});
export function FocusTimeline({
  subjectId,
  window,
  queryWindow = window,
  timelineStartMs,
  calendar = fullCalendar,
  atMs: requestedAtMs,
  playbackClock,
  onSeek,
}: {
  subjectId: string | null;
  window: ViewWindow;
  queryWindow?: ViewWindow;
  timelineStartMs: number;
  calendar?: ArchiveCalendar;
  atMs: number | null;
  playbackClock?: PlaybackClock;
  onSeek: (at: number) => void;
}): JSX.Element {
  const atMs = usePlaybackClock(playbackClock, requestedAtMs);
  const scale = useMemo(
    () => calendar.scale(window.fromMs, window.toMs),
    [calendar, window.fromMs, window.toMs],
  );
  const canSeek = !!subjectId && scale.duration > 0;
  const root = useRef<HTMLDivElement>(null),
    [widthPx, setWidthPx] = useState(180);
  const buckets = Math.max(120, Math.min(720, Math.round(widthPx)));
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setWidthPx(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const gesture = useRef<number | null>(null),
    lastScrub = useRef(-Infinity),
    pendingScrub = useRef<ReturnType<typeof setTimeout> | null>(null),
    [preview, setPreview] = useState<number | null>(null);
  const cancelPending = () => {
    if (pendingScrub.current !== null) clearTimeout(pendingScrub.current);
    pendingScrub.current = null;
  };
  const cancelGesture = () => {
    cancelPending();
    gesture.current = null;
    setPreview(null);
  };
  useLayoutEffect(() => {
    cancelGesture();
    return () => cancelPending();
  }, [subjectId, calendar]);
  const requestedWindow = aggregateWindow(window, 5000, timelineStartMs);
  const queryScope = aggregateWindow(queryWindow, 5000, timelineStartMs);
  const data = useFocusTrackData(subjectId, requestedWindow, queryScope, buckets);
  const cursor = subjectId === null ? null : (preview ?? atMs);
  const projection = `${subjectId}:${window.fromMs}:${window.toMs}:${scale.duration}:${cursor !== null}`;
  useLayoutMotion(root, subjectId ?? '', projection, '.focus-playhead', cursor);
  const targetAt = (element: HTMLElement, clientX: number): number => {
    const box = element.getBoundingClientRect();
    return Math.min(
      window.toMs - 1,
      Math.round(scale.at(Math.max(0, Math.min(1, (clientX - box.left) / Math.max(1, box.width))))),
    );
  };
  return (
    <div
      ref={root}
      className="viewer-focus"
      aria-label={tr('所选区间放大时间线')}
      data-from={window.fromMs}
      data-to={window.toMs}
    >
      <div
        className="focus-lane"
        role="slider"
        aria-disabled={!canSeek}
        data-player-seek="true"
        data-scrubbing={preview !== null ? 'true' : undefined}
        tabIndex={canSeek ? 0 : -1}
        aria-label={tr('区间播放位置')}
        aria-valuemin={window.fromMs}
        aria-valuemax={window.toMs}
        aria-valuenow={Math.max(window.fromMs, Math.min(window.toMs, atMs ?? window.fromMs))}
        onPointerDown={(event) => {
          if (!canSeek || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          cancelPending();
          gesture.current = targetAt(event.currentTarget, event.clientX);
          setPreview(gesture.current);
          lastScrub.current = performance.now();
          onSeek(gesture.current);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (gesture.current === null || !event.currentTarget.hasPointerCapture(event.pointerId))
            return;
          gesture.current = targetAt(event.currentTarget, event.clientX);
          setPreview(gesture.current);
          // Pointer feedback stays frame-rate smooth; give the decoder time to
          // expose a frame between seeks. Release always submits the exact end.
          const remaining = 80 - (performance.now() - lastScrub.current);
          if (remaining <= 0) {
            cancelPending();
            lastScrub.current = performance.now();
            onSeek(gesture.current);
          } else {
            pendingScrub.current ??= setTimeout(() => {
              pendingScrub.current = null;
              if (gesture.current !== null) {
                lastScrub.current = performance.now();
                onSeek(gesture.current);
              }
            }, remaining);
          }
        }}
        onPointerUp={(event) => {
          cancelPending();
          const target =
            gesture.current === null ? null : targetAt(event.currentTarget, event.clientX);
          gesture.current = null;
          setPreview(null);
          if (target !== null) onSeek(target);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={cancelGesture}
        onLostPointerCapture={cancelGesture}
      >
        <FocusBands
          widthPx={widthPx}
          animateWindow
          data={data}
          fromMs={window.fromMs}
          toMs={window.toMs}
          scale={scale}
        />
        {cursor !== null &&
          canSeek &&
          cursor >= window.fromMs &&
          cursor <= window.toMs &&
          !scale.hidden(cursor) && (
            <i
              className="focus-playhead"
              data-motion-key="playhead"
              style={{
                left: `clamp(1.5px, ${100 * scale.position(cursor)}%, calc(100% - 1.5px))`,
              }}
            />
          )}
      </div>
    </div>
  );
}
