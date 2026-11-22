import { useTranslation } from 'react-i18next';
import { flushSync } from 'react-dom';
import { tr } from '../../shared/lib/i18n';
import {
  forwardRef,
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type CSSProperties,
} from 'react';
import type { Subject } from '@st-vault/api-schema';
import { formatDateTime } from './timeline';
import {
  DAY_MS,
  aggregateWindow,
  directoryBucketCount,
  viewPanRatio,
  type ViewWindow,
} from './range-control';
import { useTrackData } from './use-track-data';
import {
  SUBJECT_ROW_HEIGHT,
  virtualRows,
  reconcileRowViewport,
  revealRowViewport,
  restoreRowViewport,
} from '../directory/virtual-list';
import type { ListPosition } from '../../shared/lib/workspace-state';
import { CoverImage } from '../directory/CoverImage';
import { useRowMotion } from '../directory/use-row-motion';
import { displayStatus } from '../directory/subjects';
import { RecordingMode } from '../directory/RecordingMode';
import { useSyncClock } from '../../shared/lib/sync';
import { TimeRangeControl } from './TimeRangeControl';
import { indicateRow, panTimeline, joinTimelinePan } from '../../design/motion';
import { TimelineBands, TimelineRails, type TrackData } from './TimelineBands';
import { dragRange, snapCoverageRange } from './selection-range';
import { calendarDivisions } from './ruler';
import { TrackGestureSession, type TrackGesture } from './track-gesture';
import { useLayoutMotion } from '../../design/use-layout-motion';
import { TimelineHoverPreview, type TimelineHoverHandle } from './TimelineHoverPreview';
import { hoverMediaTime } from './hover-preview';

import type { RowAnchor } from '../player/row-anchor';
export type { RowAnchor } from '../player/row-anchor';
const PAN_LAYERS =
  '.track-lane > .timeline-scene, .timeline-grid > .timeline-scene, .time-ruler-row .timeline-ruler > .timeline-scene, .selection-timeline > .timeline-scene';
const SCROLL_SETTLE_MS = 120;
const TrackGrid = memo(function TrackGrid({ fromMs, toMs, nowMs }: ViewWindow & { nowMs: number }) {
  const divisions = useMemo(
    () =>
      calendarDivisions(fromMs, toMs, DAY_MS).map((tick) => (
        <i
          key={tick.atMs}
          className={`division-${tick.level}`}
          data-window-edge={tick.position === 0 ? 'start' : tick.position === 1 ? 'end' : undefined}
          style={{ left: `${tick.position * 100}%` }}
        />
      )),
    [fromMs, toMs],
  );
  return (
    <div className="timeline-grid-anchor" aria-hidden="true">
      <div className="timeline-grid">
        <div className="timeline-scene">
          {nowMs >= fromMs - DAY_MS && nowMs < toMs + DAY_MS && (
            <div
              className="live-now-line"
              style={{ left: `${(100 * (nowMs - fromMs)) / (toMs - fromMs)}%` }}
              data-at={nowMs}
            />
          )}
          {divisions}
        </div>
      </div>
    </div>
  );
});
interface SelectionDraft {
  id: string;
  range: ViewWindow;
}
interface SelectionOverlayHandle {
  update: (draft: SelectionDraft | null) => void;
}
// Keep frame-by-frame drawing state out of the board: its rows contain hundreds
// of coverage spans that do not change while drawing.
const SelectionOverlay = forwardRef<
  SelectionOverlayHandle,
  {
    subjects: Subject[];
    selectedId: string | null;
    selection: ViewWindow;
    fromMs: number;
    toMs: number;
    count: number;
    timelineStartMs: number;
    nowMs: number;
    selectionGeneration: number;
    onCommit: (subject: Subject, range: ViewWindow) => void;
  }
>(function SelectionOverlay(
  {
    subjects,
    selectedId,
    selection,
    fromMs,
    toMs,
    count,
    timelineStartMs,
    nowMs,
    selectionGeneration,
    onCommit,
  },
  ref,
) {
  const [draft, setDraft] = useState<SelectionDraft | null>(null);
  useImperativeHandle(ref, () => ({ update: setDraft }), []);
  const shownSelection = draft?.range ?? selection,
    shownId = draft?.id ?? selectedId;
  const duration = toMs - fromMs;
  const selectionLeft = (100 * (shownSelection.fromMs - fromMs)) / duration,
    selectionRight = (100 * (shownSelection.toMs - fromMs)) / duration;
  const selectedIndex = subjects.findIndex((subject) => subject.id === (shownId ?? selectedId));
  const selectionVisible =
    shownId !== null &&
    selectedIndex >= 0 &&
    selectedIndex < count &&
    selectionRight > selectionLeft &&
    shownSelection.toMs > fromMs - DAY_MS &&
    shownSelection.fromMs < toMs + DAY_MS;
  const selectionInView = selectionVisible && selectionRight > 0 && selectionLeft < 100;
  const root = useRef<HTMLDivElement>(null);
  useLayoutMotion(
    root,
    `${selectedId}:${selectedIndex}:${fromMs}:${toMs}:${selectionGeneration}:${draft ? 'gesture' : 'settled'}`,
    draft ? 'drawing' : `${shownSelection.fromMs}:${shownSelection.toMs}:${selectionVisible}`,
  );
  return (
    <div className="selection-timeline">
      {/* View panning owns the scene; local FLIP measures inside that moving origin. */}
      <div className="timeline-scene">
        <div className="selection-row-motion" ref={root}>
          <div
            className={`range-selection${draft ? ' is-drawing' : ''}`}
            role="region"
            aria-label={tr('取画面选区')}
            data-selected-subject={shownId ?? ''}
            data-motion-key="selection"
            data-from={shownSelection.fromMs}
            data-to={shownSelection.toMs}
            aria-hidden={!selectionInView}
            style={{
              top: Math.max(0, Math.min(count - 1, selectedIndex)) * SUBJECT_ROW_HEIGHT,
              height: SUBJECT_ROW_HEIGHT,
              opacity: selectionVisible ? 1 : 0,
              left: `${selectionLeft}%`,
              width: `${Math.max(0, selectionRight - selectionLeft)}%`,
            }}
          >
            {!draft &&
              selectionVisible &&
              (['from', 'to'] as const).map((edge) => (
                <button
                  key={edge}
                  className={`selection-edge ${edge}`}
                  data-edge={edge}
                  role="slider"
                  tabIndex={selectionInView ? 0 : -1}
                  aria-label={edge === 'from' ? tr('选区起点') : tr('选区终点')}
                  aria-valuemin={timelineStartMs}
                  aria-valuemax={nowMs}
                  aria-valuenow={edge === 'from' ? selection.fromMs : selection.toMs}
                  aria-valuetext={formatDateTime(
                    edge === 'from' ? selection.fromMs : selection.toMs,
                  )}
                  onKeyDown={(event) => {
                    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const subject = subjects.find((s) => s.id === selectedId);
                    if (!subject) return;
                    const delta =
                        (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 60000 : 1000),
                      next = dragRange(
                        edge === 'from' ? selection.toMs : selection.fromMs,
                        (edge === 'from' ? selection.fromMs : selection.toMs) + delta,
                        { fromMs: timelineStartMs, toMs: Date.now() },
                      );
                    if (next) onCommit(subject, next);
                  }}
                >
                  <i />
                </button>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
});
interface TrackPresentation {
  view: string;
  arrival: number;
}
const TrackRow = memo(function TrackRow({
  subject,
  data,
  scrolling,
  failed,
  selected,
  selecting,
  coverRevision,
  presentation,
  revealDelayMs,
  priority,
  widthPx,
  fromMs,
  toMs,
  onChoose,
  onRecordingChange,
}: {
  subject: Subject;
  data: TrackData | undefined;
  scrolling: boolean;
  failed: boolean;
  selected: boolean;
  selecting: boolean;
  coverRevision: number;
  presentation: TrackPresentation;
  revealDelayMs: number;
  priority: 'visible' | 'prefetch';
  widthPx: number;
  fromMs: number;
  toMs: number;
  onChoose: (subject: Subject, utc?: number) => void;
  onRecordingChange: (subject: Subject, record: boolean) => Promise<void>;
}) {
  useTranslation();
  const visible = priority === 'visible';
  const painted = useRef<{ data: TrackData; presentation: TrackPresentation } | null>(null);
  const retained =
    painted.current?.presentation.view === presentation.view ? painted.current : null;
  // Cache hits can be as expensive to mount as network responses. Keep painted
  // rows intact through the gesture and hydrate newly exposed rows after it.
  const timeline = scrolling
    ? retained?.data
    : visible
      ? (data ??
        (retained?.presentation.arrival === presentation.arrival ? retained.data : undefined))
      : undefined;
  const trackState = timeline
    ? 'ready'
    : !visible || scrolling
      ? 'idle'
      : failed
        ? 'failed'
        : 'loading';
  useLayoutEffect(() => {
    if (!scrolling) painted.current = timeline ? { data: timeline, presentation } : null;
  }, [scrolling, timeline, presentation]);
  return (
    <div
      className={`track-row${selected ? ' selected' : ''}${selecting ? ' is-selecting' : ''}`}
      data-subject-id={subject.id}
    >
      <div className={`track-label status-cell-${displayStatus(subject).toLowerCase()}`}>
        <button
          className="subject-preview"
          onClick={(event) => {
            if (event.detail === 0) onChoose(subject);
          }}
          aria-label={subject.handle}
          aria-current={selected ? 'true' : undefined}
          title={[subject.handle, subject.formerNames?.join(' / '), subject.id]
            .filter(Boolean)
            .join(' · ')}
        >
          <CoverImage
            id={subject.id}
            revision={coverRevision}
            status={displayStatus(subject)}
            priority={priority}
          >
            <strong className="subject-name">
              {subject.handle}
              {!!subject.formerNames?.length && <small>{subject.formerNames.join(' / ')}</small>}
            </strong>
          </CoverImage>
        </button>
        {!subject.archived && (
          <RecordingMode
            appearance="record"
            value={subject.autoRecord}
            captureState={subject.captureState}
            providerStatus={subject.providerStatus}
            label={tr('{{v0}} 是否录制', { v0: subject.handle })}
            onChange={(record) => onRecordingChange(subject, record)}
          />
        )}
      </div>
      <div
        aria-busy={visible && !timeline && trackState !== 'failed'}
        className="track-lane"
        data-track-state={trackState}
        style={
          timeline ? ({ '--track-reveal-delay': `${revealDelayMs}ms` } as CSSProperties) : undefined
        }
        role="group"
        tabIndex={0}
        aria-label={tr('{{v0}} 录制时间线', { v0: subject.handle })}
        data-from={fromMs}
        data-to={toMs}
      >
        <div className="timeline-scene">
          {/* Only the opacity layer restarts on view changes. The scene keeps its pan clock. */}
          {timeline ? (
            <TimelineBands
              key={presentation.view}
              widthPx={widthPx}
              overscanMs={DAY_MS}
              data={timeline}
              fromMs={fromMs}
              toMs={toMs}
            />
          ) : (
            <TimelineRails />
          )}
          <span className="track-loading" aria-hidden="true" />
        </div>
        {trackState === 'failed' && <small className="track-placeholder">{tr('读取失败')}</small>}
      </div>
    </div>
  );
});
export function TrackBoard({
  subjects,
  filterKey = '',
  selectedId,
  fromMs,
  toMs,
  selection,
  timelineStartMs,
  nowMs,
  account,
  filters,
  onChoose,
  onRangeChoose,
  onAnchor,
  onViewChange,
  onMove,
  onRecordingChange,
  reveal,
  restorePosition,
  onPosition,
}: {
  restorePosition?: ListPosition | null;
  onPosition?: (position: ListPosition) => void;
  reveal?: { id: string; token: number } | null;
  subjects: Subject[];
  filterKey?: string;
  selectedId: string | null;
  fromMs: number;
  toMs: number;
  selection: ViewWindow;
  timelineStartMs: number;
  nowMs: number;
  onChoose: (subject: Subject, utc?: number, range?: ViewWindow) => void;
  onRangeChoose: (
    subject: Subject,
    range: ViewWindow,
    signal: AbortSignal,
  ) => Promise<ViewWindow | null>;
  onAnchor: (anchor: RowAnchor | null) => void;
  onViewChange: (window: ViewWindow) => void;
  onMove: (direction: -1 | 1) => void;
  account?: ReactNode;
  filters?: ReactNode;
  onRecordingChange: (subject: Subject, record: boolean) => Promise<void>;
}): JSX.Element {
  const [viewport, setViewport] = useState({ top: 0, height: 500 });
  const [scrolling, setScrolling] = useState(false);
  const [scrollArrival, setScrollArrival] = useState(0);
  const scrollPace = useRef({ active: false, settle: undefined as number | undefined });
  const mountedRows = useRef({ start: 0, end: 0 });
  // Native scrolling owns pixels; React only needs changes to the visible row set.
  const nativeViewport = useRef(viewport);
  const horizontalScroll = useRef(0);
  const [rulerWidth, setRulerWidth] = useState(600);
  const [drag, setDrag] = useState<TrackGesture | null>(null);
  const gesture = useRef<TrackGestureSession | null>(null);
  const draft = useRef<SelectionDraft | null>(null);
  const overlay = useRef<SelectionOverlayHandle | null>(null);
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const setDraft = (value: SelectionDraft | null): void => {
    if (draft.current?.id !== value?.id) setSelectingId(value?.id ?? null);
    draft.current = value;
    overlay.current?.update(value);
  };
  const commitRequest = useRef<AbortController | null>(null);
  const hoverPreview = useRef<TimelineHoverHandle | null>(null);
  useEffect(() => {
    hoverPreview.current?.show(null);
  }, [fromMs, toMs, filterKey]);
  const selectionGeneration = useRef(0);
  const selectionFrame = useRef<number | undefined>();
  const pendingUpdate = useRef<(() => void) | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const board = useRef<HTMLElement | null>(null);
  const previousView = useRef({ fromMs, toMs });
  const animations = useRef<Animation[]>([]);
  const headerViewport = useRef<HTMLDivElement | null>(null);
  const scrollDirection = useRef(1);
  useLayoutEffect(() => {
    const ratio = viewPanRatio(previousView.current, { fromMs, toMs });
    previousView.current = { fromMs, toMs };
    const nodes = Array.from(board.current?.querySelectorAll<HTMLElement>(PAN_LAYERS) ?? []);
    const width = board.current?.querySelector('.track-lane')?.clientWidth ?? rulerWidth;
    animations.current = panTimeline(nodes, ratio * width, animations.current);
  }, [fromMs, toMs]);
  useEffect(() => () => animations.current.forEach((animation) => animation.cancel()), []);
  useEffect(() => () => window.clearTimeout(scrollPace.current.settle), []);

  const [coverRevision, setCoverRevision] = useState(0);
  const viewRef = useRef({ fromMs, toMs });
  viewRef.current = { fromMs, toMs };
  const subjectsRef = useRef(subjects);
  subjectsRef.current = subjects;
  const rowActions = useRef({ onChoose, onRecordingChange });
  rowActions.current = { onChoose, onRecordingChange };
  const chooseRow = useRef((subject: Subject, utc?: number) =>
    rowActions.current.onChoose(subject, utc),
  ).current;
  const recordRow = useRef((subject: Subject, record: boolean) =>
    rowActions.current.onRecordingChange(subject, record),
  ).current;
  const subjectIds = useMemo(() => subjects.map((subject) => subject.id), [subjects]);
  const ids = useMemo(() => subjectIds.join('|'), [subjectIds]);
  const previousRows = useRef({ ids: subjectIds, filterKey });
  const handledReveal = useRef(0);
  const restoredPosition = useRef(false);
  const restoringPosition = !restoredPosition.current && restorePosition && subjects.length > 0;
  const revealViewport =
    reveal && reveal.token !== handledReveal.current
      ? revealRowViewport(subjectIds, reveal.id, viewport.height)
      : null;
  const rowTop =
    revealViewport ??
    (restoringPosition ? restoreRowViewport(subjectIds, restorePosition, viewport.height) : null) ??
    reconcileRowViewport(
      previousRows.current.ids,
      subjectIds,
      nativeViewport.current.top,
      viewport.height,
      previousRows.current.filterKey !== filterKey,
    );
  // Render the anchored virtual range before restoring native scroll, so React never
  // briefly shrinks the spacer extent and lets the browser clamp the old offset.
  const relocatingRows = rowTop !== nativeViewport.current.top;
  useLayoutEffect(() => {
    previousRows.current = { ids: subjectIds, filterKey };
    if (relocatingRows) {
      // A held vertical drag uses its original scroll offset on every move.
      // Advance that origin too, otherwise its next event would undo the anchor.
      gesture.current?.compensateScroll(rowTop - nativeViewport.current.top);
      nativeViewport.current = { ...nativeViewport.current, top: rowTop };
      setViewport((current) => ({ ...current, top: rowTop }));
      if (scroller.current) scroller.current.scrollTop = rowTop;
    }
    if (restoringPosition && scroller.current) {
      scroller.current.scrollLeft = restorePosition.left;
      restoredPosition.current = true;
    }
    // The compositor can already have scrolled ahead of the latest scroll event.
    // Only explicit restoration/reordering may write a pixel offset back to it.
    const nativeTop = scroller.current?.scrollTop ?? rowTop;
    const topSubject = subjects[Math.floor(nativeTop / SUBJECT_ROW_HEIGHT)];
    if (topSubject)
      onPosition?.({
        id: topSubject.id,
        offset: Math.round(nativeTop % SUBJECT_ROW_HEIGHT),
        left: Math.round(scroller.current?.scrollLeft ?? 0),
      });
    if (revealViewport !== null && reveal) {
      handledReveal.current = reveal.token;
      const target = scroller.current?.querySelector<HTMLButtonElement>(
        `[data-subject-id="${CSS.escape(reveal.id)}"] .subject-preview`,
      );
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const row = target?.closest<HTMLElement>('.track-row');
      if (row) indicateRow(row);
    }
  }, [ids, filterKey, rowTop, viewport.top, reveal?.token]);
  useLayoutEffect(() => {
    const element = scroller.current,
      header = headerViewport.current;
    if (!element || !header) return;
    const measure = (): void => {
      const height = element.clientHeight;
      element.style.setProperty('--track-viewport-height', `${height}px`);
      // Controls use the gutter too; only the ruler excludes it to stay aligned with rows.
      header.style.setProperty(
        '--track-scrollbar-width',
        `${element.offsetWidth - element.clientWidth}px`,
      );
      header.style.setProperty('--track-content-width', `${element.scrollWidth}px`);
      header.style.setProperty('--track-scroll-left', `${element.scrollLeft}px`);
      horizontalScroll.current = element.scrollLeft;
      nativeViewport.current = { top: element.scrollTop, height };
      setViewport((previous) => (previous.height === height ? previous : { ...previous, height }));
      const width = header.querySelector('.timeline-ruler')?.clientWidth ?? 600;
      setRulerWidth(width);
    };
    const observer = new ResizeObserver(measure);
    measure();
    observer.observe(element);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  const count = subjects.length;
  const { start, end } = virtualRows(
    count,
    rowTop,
    viewport.height,
    scrolling ? scrollDirection.current * 4 : 0,
  );
  useRowMotion(
    scroller,
    subjectIds,
    ids,
    `${fromMs}:${toMs}:${reveal?.token ?? 0}:${selectedId}`,
    rowTop,
    viewport.height,
    rulerWidth,
    start,
    end,
    selectedId,
  );
  useLayoutEffect(() => {
    mountedRows.current = { start, end };
    if (!animations.current.length) return;
    const nodes = Array.from(board.current?.querySelectorAll<HTMLElement>(PAN_LAYERS) ?? []);
    animations.current = joinTimelinePan(nodes, animations.current);
  }, [start, end, ids]);
  const visibleStart = Math.floor(rowTop / SUBJECT_ROW_HEIGHT),
    visibleEnd = Math.ceil((rowTop + viewport.height) / SUBJECT_ROW_HEIGHT);
  const visibleIds = useMemo(
    () => subjectIds.slice(visibleStart, visibleEnd),
    [subjectIds, visibleStart, visibleEnd],
  );

  // The calendar includes today's remaining empty hours. Keep its full range:
  // clipping only the right edge to now can invert an upcoming half-day window.
  const { fromMs: queryFrom, toMs: queryTo } = aggregateWindow({ fromMs, toMs }, 5000);
  const buckets = directoryBucketCount({ fromMs: queryFrom, toMs: queryTo }, rulerWidth);
  const trackData = useTrackData({
    visible: visibleIds,
    fromMs: queryFrom,
    toMs: queryTo,
    buckets,
    paused: scrolling,
  });
  const visibleTracks = scrolling
    ? undefined
    : trackData.getVisible(visibleIds, queryFrom, queryTo, buckets);
  const presentation = useMemo<TrackPresentation>(
    () => ({ view: `${filterKey}:${fromMs}:${toMs}`, arrival: scrollArrival }),
    [filterKey, fromMs, toMs, scrollArrival],
  );
  const revealStepMs = Math.min(24, 240 / Math.max(1, visibleIds.length - 1));
  useSyncClock(() => {
    if (!scrollPace.current.active) setCoverRevision((n) => n + 1);
  });
  const rows = subjects.slice(start, end),
    duration = toMs - fromMs;
  const targetAt = (element: HTMLElement, clientX: number): number => {
    const box = element.getBoundingClientRect();
    return Math.round(
      fromMs + Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * duration,
    );
  };
  const cancelGesture = (keepDraft = false): void => {
    window.cancelAnimationFrame(selectionFrame.current ?? 0);
    selectionFrame.current = undefined;
    pendingUpdate.current = null;
    gesture.current?.cancel();
    gesture.current = null;
    setDrag(null);
    if (!keepDraft) setDraft(null);
  };
  useLayoutEffect(() => {
    cancelGesture();
    commitRequest.current?.abort();
    commitRequest.current = null;
  }, [selectedId]);
  useEffect(
    () => () => {
      window.cancelAnimationFrame(selectionFrame.current ?? 0);
      commitRequest.current?.abort();
    },
    [],
  );
  const updateAnchor = (root: HTMLDivElement | null, top: number): void => {
    if (!root || !selectedId) {
      onAnchor(null);
      return;
    }
    const box = root.getBoundingClientRect(),
      index = subjects.findIndex((subject) => subject.id === selectedId);
    const y = box.top + index * SUBJECT_ROW_HEIGHT + SUBJECT_ROW_HEIGHT / 2 - top;
    onAnchor({
      y: Math.max(box.top + 7, Math.min(box.top + root.clientHeight - 7, y)),
      offscreen:
        index < 0
          ? 'filtered'
          : y < box.top
            ? 'above'
            : y > box.top + root.clientHeight
              ? 'below'
              : null,
    });
  };
  useLayoutEffect(() => {
    updateAnchor(scroller.current, rowTop);
  }, [selectedId, ids, rowTop, onAnchor]);
  const commitRange = (subject: Subject, range: ViewWindow): void => {
    commitRequest.current?.abort();
    const controller = new AbortController();
    commitRequest.current = controller;
    selectionGeneration.current++;
    const coverage = trackData.get(subject.id, fromMs, toMs)?.coverage;
    const known = coverage && coverage.fromMs <= range.fromMs && coverage.toMs >= range.toMs;
    const preview = known ? snapCoverageRange(range, coverage) : null;
    setDraft(preview ? { id: subject.id, range: preview } : null);
    // Cached coverage previews the release immediately; the archive may have
    // committed fresh media since that cache was read, including into an empty window.
    void onRangeChoose(subject, range, controller.signal)
      .then(() => {
        if (controller.signal.aborted || commitRequest.current !== controller) return;
        setDraft(null);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && commitRequest.current === controller) {
          console.warn('Timeline selection unavailable', error);
          setDraft(null);
        }
      });
  };
  return (
    <section
      ref={board}
      className="track-board aligned-track-board"
      style={{ '--subject-row-height': `${SUBJECT_ROW_HEIGHT}px` } as CSSProperties}
      aria-label={tr('主播与录制时间线对照表')}
    >
      <TimelineHoverPreview ref={hoverPreview} />
      <div className="track-header-viewport" ref={headerViewport}>
        <div className="arrangement-controls">
          <div className="directory">{account}</div>
          <TimeRangeControl
            fromMs={fromMs}
            toMs={toMs}
            timelineStartMs={timelineStartMs}
            nowMs={nowMs}
            filters={filters}
            onChange={onViewChange}
            onMove={onMove}
          />
        </div>
      </div>
      <div
        className="track-table-scroll"
        ref={scroller}
        tabIndex={-1}
        data-gesture={drag ?? ''}
        data-scrolling={scrolling}
        onPointerDown={(event) => {
          if (event.button !== 0 || !event.isPrimary || gesture.current) return;
          hoverPreview.current?.show(null);
          const target = event.target as Element,
            overlay = target.closest('.range-selection'),
            lane = target.closest<HTMLElement>('.track-lane'),
            preview = target.closest('.subject-preview');
          if (!lane && !preview && !overlay) return;
          const id = overlay
            ? (draft.current?.id ?? selectedId)
            : target.closest<HTMLElement>('.track-row')?.dataset.subjectId;
          const ruler = headerViewport.current?.querySelector<HTMLElement>(
            '.time-range-control .timeline-ruler',
          );
          if (!id || !ruler) return;
          commitRequest.current?.abort();
          setDraft(null);
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          const edge = target.closest<HTMLElement>('[data-edge]')?.dataset.edge ?? null;
          const at =
            edge === 'from'
              ? selection.fromMs
              : edge === 'to'
                ? selection.toMs
                : targetAt(ruler, event.clientX);
          const currentWindow = { fromMs, toMs };
          gesture.current = new TrackGestureSession({
            id,
            preview: !!preview,
            x: event.clientX,
            y: event.clientY,
            at,
            width: ruler.getBoundingClientRect().width,
            scrollTop: event.currentTarget.scrollTop,
            window: currentWindow,
            selection,
            edge,
            timelineStartMs,
          });
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = gesture.current;
          if (!current) {
            const target = event.target as Element;
            const id =
              target.closest<HTMLElement>('.track-row')?.dataset.subjectId ??
              (target.closest('.range-selection') ? selectedId : null);
            const subject = subjectsRef.current.find((item) => item.id === id);
            const ruler = headerViewport.current?.querySelector<HTMLElement>('.timeline-ruler');
            const lane = target.closest('.track-lane,.range-selection');
            const row =
              id && lane
                ? event.currentTarget.querySelector<HTMLElement>(
                    `.track-row[data-subject-id="${CSS.escape(id)}"]`,
                  )
                : null;
            const recording = row?.querySelector('.recording-line')?.getBoundingClientRect();
            const track = row?.querySelector('.track-lane')?.getBoundingClientRect();
            const viewport =
              recording && track ? event.currentTarget.getBoundingClientRect() : null;
            const bounds =
              recording && track && viewport
                ? {
                    left: Math.max(8, track.left, viewport.left),
                    right: Math.min(window.innerWidth - 8, track.right, viewport.right),
                    top: Math.max(0, recording.top, viewport.top),
                    bottom: Math.min(window.innerHeight, recording.bottom, viewport.bottom),
                  }
                : null;
            const coverage = id ? trackData.get(id, fromMs, toMs)?.coverage : undefined;
            const at =
              subject &&
              ruler &&
              lane &&
              bounds &&
              event.clientY >= bounds.top &&
              event.clientY < bounds.bottom &&
              event.pointerType !== 'touch' &&
              coverage
                ? hoverMediaTime(
                    coverage.buckets,
                    targetAt(ruler, event.clientX),
                    duration / ruler.getBoundingClientRect().width,
                  )
                : null;
            hoverPreview.current?.show(
              subject && at !== null && bounds
                ? {
                    id: subject.id,
                    at,
                    revision: coverage!.revision,
                    x: event.clientX,
                    y: event.clientY,
                    bounds,
                  }
                : null,
            );
          }
          if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const previousMode = current.mode;
          const motion = current.move(event.clientX, event.clientY, Date.now());
          if (!current.mode) return;
          if (!previousMode) setDrag(current.mode);
          if (motion.kind === 'scroll') {
            event.currentTarget.scrollTop = motion.top;
            return;
          }
          if (motion.kind === 'selection') {
            // Track the pointer throughout the drag; snap or discard only on release.
            pendingUpdate.current = () => {
              const range = motion.range;
              setDraft(range ? { id: current.id, range } : null);
            };
          } else return;
          selectionFrame.current ??= window.requestAnimationFrame(() => {
            selectionFrame.current = undefined;
            pendingUpdate.current?.();
            pendingUpdate.current = null;
          });
        }}
        onPointerUp={(event) => {
          const current = gesture.current;
          if (!current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const subject = subjectsRef.current.find((item) => item.id === current.id);
          const result = current.finish(event.clientX, Date.now());
          const select = result.kind === 'selection' && !!subject;
          cancelGesture(!!select);
          if (result.kind === 'selection' && subject) commitRange(subject, result.range);
          else if (result.kind === 'choose' && subject) onChoose(subject);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => cancelGesture()}
        onPointerLeave={() => hoverPreview.current?.show(null)}
        onLostPointerCapture={() => {
          if (gesture.current) cancelGesture();
        }}
        onAuxClick={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            commitRequest.current?.abort();
            cancelGesture();
          }
        }}
        onScroll={(event) => {
          hoverPreview.current?.show(null);
          if (
            headerViewport.current &&
            horizontalScroll.current !== event.currentTarget.scrollLeft
          ) {
            headerViewport.current.style.setProperty(
              '--track-scroll-left',
              `${event.currentTarget.scrollLeft}px`,
            );
            horizontalScroll.current = event.currentTarget.scrollLeft;
          }
          const previousViewport = nativeViewport.current;
          const next = {
            top: event.currentTarget.scrollTop,
            height: event.currentTarget.clientHeight,
          };
          const first = Math.floor(next.top / SUBJECT_ROW_HEIGHT);
          const last = Math.ceil((next.top + next.height) / SUBJECT_ROW_HEIGHT);
          const delta = next.top - previousViewport.top;
          const pace = scrollPace.current;
          const changesRows =
            first !== Math.floor(previousViewport.top / SUBJECT_ROW_HEIGHT) ||
            last !==
              Math.ceil((previousViewport.top + previousViewport.height) / SUBJECT_ROW_HEIGHT);
          const moving = delta !== 0 && (pace.active || changesRows);
          const enteringScroll = moving && !pace.active;
          if (moving) {
            scrollDirection.current = Math.sign(delta);
            if (enteringScroll) trackData.pause();
            pace.active = true;
            window.clearTimeout(pace.settle);
            pace.settle = window.setTimeout(() => {
              pace.active = false;
              setScrollArrival((arrival) => arrival + 1);
              setScrolling(false);
            }, SCROLL_SETTLE_MS);
          }
          const topSubject =
            subjects[Math.floor(event.currentTarget.scrollTop / SUBJECT_ROW_HEIGHT)];
          if (topSubject)
            onPosition?.({
              id: topSubject.id,
              offset: Math.round(event.currentTarget.scrollTop % SUBJECT_ROW_HEIGHT),
              left: Math.round(event.currentTarget.scrollLeft),
            });
          nativeViewport.current = next;
          updateAnchor(event.currentTarget, next.top);
          const commitViewport = (): void => {
            if (enteringScroll) setScrolling(true);
            setViewport((previous) =>
              previous.height === next.height &&
              Math.floor(previous.top / SUBJECT_ROW_HEIGHT) === first &&
              Math.ceil((previous.top + previous.height) / SUBJECT_ROW_HEIGHT) === last
                ? previous
                : next,
            );
          };
          // A scrollbar jump can skip all overscan. Commit the cheap row shells
          // before the next paint, while ordinary scroll stays on React's normal lane.
          if (
            count &&
            (first < mountedRows.current.start || Math.min(last, count) > mountedRows.current.end)
          )
            flushSync(commitViewport);
          else commitViewport();
        }}
      >
        <div className="track-table">
          <TrackGrid fromMs={fromMs} toMs={toMs} nowMs={nowMs} />
          <SelectionOverlay
            ref={overlay}
            subjects={subjects}
            selectedId={selectedId}
            selection={selection}
            fromMs={fromMs}
            toMs={toMs}
            count={count}
            timelineStartMs={timelineStartMs}
            nowMs={nowMs}
            onCommit={commitRange}
            selectionGeneration={selectionGeneration.current}
          />
          <div
            className="track-spacer"
            aria-hidden="true"
            style={{ height: start * SUBJECT_ROW_HEIGHT }}
          />
          {rows.map((subject, index) => {
            const visible = start + index >= visibleStart && start + index < visibleEnd;
            const track = visibleTracks?.get(subject.id);
            return (
              <TrackRow
                key={subject.id}
                subject={subject}
                data={track?.data}
                scrolling={scrolling}
                failed={track?.failed ?? false}
                selected={subject.id === selectedId}
                selecting={subject.id === selectingId}
                coverRevision={coverRevision}
                presentation={presentation}
                revealDelayMs={
                  visible && !scrolling ? (start + index - visibleStart) * revealStepMs : 0
                }
                widthPx={rulerWidth}
                priority={visible ? 'visible' : 'prefetch'}
                fromMs={fromMs}
                toMs={toMs}
                onChoose={chooseRow}
                onRecordingChange={recordRow}
              />
            );
          })}
          <div
            className="track-spacer"
            aria-hidden="true"
            style={{ height: Math.max(0, count - end) * SUBJECT_ROW_HEIGHT }}
          />
          {!subjects.length && <div className="track-empty">{tr('没有匹配的主播')}</div>}
        </div>
      </div>
    </section>
  );
}
