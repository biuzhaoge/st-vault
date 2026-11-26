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
import { useTrackPresentation } from './use-track-presentation';
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
import { DirectoryRowNumber, RecordingMode } from '../directory/RecordingMode';
import { useSyncClock } from '../../shared/lib/sync';
import { TimeRangeControl } from './TimeRangeControl';
import { indicateRow, panTimeline, joinTimelinePan } from '../../design/motion';
import { TimelineBands, TimelineRails, type TrackData } from './TimelineBands';
import { snapCoverageRange } from './selection-range';
import { calendarDivisions } from './ruler';
import { TrackGestureSession, type TrackGesture } from './track-gesture';
import { useLayoutMotion } from '../../design/use-layout-motion';
import { TimelineHoverPreview, type TimelineHoverHandle } from './TimelineHoverPreview';
import { hoverMediaTime } from './hover-preview';
import { fullCalendar, type ArchiveCalendar, type TimelineScale } from './archive-calendar';

import type { RowAnchor } from '../player/row-anchor';
export type { RowAnchor } from '../player/row-anchor';
const PAN_LAYERS =
  '.track-lane > .timeline-scene, .timeline-grid > .timeline-scene, .time-ruler-row .timeline-ruler > .timeline-scene, .selection-timeline > .timeline-scene';
const SCROLL_SETTLE_MS = 120;
const TrackGrid = memo(function TrackGrid({
  fromMs,
  toMs,
  nowMs,
  scale,
}: ViewWindow & { nowMs: number; scale: TimelineScale }) {
  const divisions = useMemo(
    () =>
      calendarDivisions(fromMs, toMs, DAY_MS, scale).map((tick) => (
        <i
          key={tick.atMs}
          className={`division-${tick.level}`}
          data-window-edge={tick.position === 0 ? 'start' : tick.position === 1 ? 'end' : undefined}
          style={{ left: `${tick.position * 100}%` }}
        />
      )),
    [fromMs, toMs, scale],
  );
  return (
    <div className="timeline-grid-anchor" aria-hidden="true">
      <div className="timeline-grid">
        <div className="timeline-scene">
          {scale.duration > 0 && nowMs >= fromMs - DAY_MS && nowMs < toMs + DAY_MS && (
            <div
              className="live-now-line"
              style={{ left: `${100 * scale.position(nowMs)}%` }}
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
  keyboardOrigin?: HTMLElement;
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
    scale: TimelineScale;
    selectionGeneration: number;
    onCommit: (subject: Subject, range: ViewWindow) => void;
    onDraft: (draft: SelectionDraft | null) => void;
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
    scale,
    selectionGeneration,
    onCommit,
    onDraft,
  },
  ref,
) {
  const [draft, setDraft] = useState<SelectionDraft | null>(null);
  useImperativeHandle(ref, () => ({ update: setDraft }), []);
  const shownSelection = draft?.range ?? selection,
    shownId = draft?.id ?? selectedId;
  const selectionLeft = 100 * scale.position(shownSelection.fromMs),
    selectionRight = 100 * scale.position(shownSelection.toMs);
  const selectedIndex = subjects.findIndex((subject) => subject.id === (shownId ?? selectedId));
  const selectionVisible =
    shownId !== null &&
    selectedIndex >= 0 &&
    selectedIndex < count &&
    selectionRight > selectionLeft &&
    shownSelection.toMs > fromMs - DAY_MS &&
    shownSelection.fromMs < toMs + DAY_MS;
  const selectionInView = selectionVisible && selectionRight > 0 && selectionLeft < 100;
  const limits = draft?.keyboardOrigin
    ? { fromMs: Math.max(fromMs, timelineStartMs), toMs: Math.min(toMs, nowMs) }
    : { fromMs: timelineStartMs, toMs: nowMs };
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
            onBlur={(event) => {
              if (draft?.keyboardOrigin && !event.currentTarget.contains(event.relatedTarget))
                onDraft(null);
            }}
            style={{
              top: Math.max(0, Math.min(count - 1, selectedIndex)) * SUBJECT_ROW_HEIGHT,
              height: SUBJECT_ROW_HEIGHT,
              opacity: selectionVisible ? 1 : 0,
              left: `${selectionLeft}%`,
              width: `${Math.max(0, selectionRight - selectionLeft)}%`,
            }}
          >
            {(!draft || draft.keyboardOrigin) &&
              selectionVisible &&
              (['from', 'to'] as const).map((edge) => (
                <button
                  key={edge}
                  className={`selection-edge ${edge}`}
                  data-edge={edge}
                  role="slider"
                  tabIndex={selectionInView ? 0 : -1}
                  aria-label={edge === 'from' ? tr('选区起点') : tr('选区终点')}
                  aria-valuemin={edge === 'from' ? limits.fromMs : shownSelection.fromMs + 1}
                  aria-valuemax={edge === 'from' ? shownSelection.toMs - 1 : limits.toMs}
                  aria-valuenow={edge === 'from' ? shownSelection.fromMs : shownSelection.toMs}
                  aria-valuetext={formatDateTime(
                    edge === 'from' ? shownSelection.fromMs : shownSelection.toMs,
                  )}
                  onKeyDown={(event) => {
                    if (event.altKey || event.ctrlKey || event.metaKey) return;
                    const subject = subjects[selectedIndex];
                    if (draft?.keyboardOrigin && ['Escape', 'Enter'].includes(event.key)) {
                      event.preventDefault();
                      event.stopPropagation();
                      if (event.repeat) return;
                      onDraft(null);
                      const origin = draft.keyboardOrigin.isConnected
                        ? draft.keyboardOrigin
                        : event.currentTarget.closest<HTMLElement>('.track-table-scroll');
                      origin?.focus({ preventScroll: true });
                      if (event.key === 'Enter') onCommit(subject, shownSelection);
                      return;
                    }
                    const isStart = edge === 'from';
                    const value = isStart ? shownSelection.fromMs : shownSelection.toMs;
                    const min = isStart ? limits.fromMs : shownSelection.fromMs + 1;
                    const max = isStart ? shownSelection.toMs - 1 : limits.toMs;
                    const step = event.shiftKey ? 60000 : 1000;
                    const keys: Record<string, number> = {
                      ArrowLeft: value - step,
                      ArrowRight: value + step,
                      ArrowDown: value - step,
                      ArrowUp: value + step,
                      Home: min,
                      End: max,
                      PageDown: value - 3600000,
                      PageUp: value + 3600000,
                    };
                    if (!Object.hasOwn(keys, event.key)) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const target = keys[event.key];
                    const shifted =
                      event.key === 'Home' || event.key === 'End'
                        ? scale.restore(scale.coordinate(target), isStart ? 'later' : 'earlier')
                        : scale.shift(value, target - value);
                    const next = Math.max(min, Math.min(max, shifted));
                    if (next === value) return;
                    const range = { ...shownSelection, [isStart ? 'fromMs' : 'toMs']: next };
                    if (draft?.keyboardOrigin) onDraft({ ...draft, range });
                    else onCommit(subject, range);
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
const TrackRow = memo(function TrackRow({
  subject,
  rowNumber,
  data,
  trackState,
  selected,
  selecting,
  coverRevision,
  presentationView,
  revealDelayMs,
  priority,
  widthPx,
  fromMs,
  toMs,
  scale,
  onChoose,
  onRecordingChange,
}: {
  subject: Subject;
  rowNumber: number;
  data: TrackData | undefined;
  trackState: 'ready' | 'idle' | 'failed' | 'loading';
  selected: boolean;
  selecting: boolean;
  coverRevision: number;
  presentationView: string;
  revealDelayMs: number;
  priority: 'visible' | 'prefetch';
  widthPx: number;
  fromMs: number;
  toMs: number;
  scale: TimelineScale;
  onChoose: (subject: Subject, utc?: number) => void;
  onRecordingChange: (subject: Subject, record: boolean) => Promise<void>;
}) {
  useTranslation();
  return (
    <div
      className={`track-row${selected ? ' selected' : ''}${selecting ? ' is-selecting' : ''}`}
      data-subject-id={subject.id}
    >
      <div className={`track-label status-cell-${displayStatus(subject).toLowerCase()}`}>
        <div className="directory-row-index">
          {subject.archived ? (
            <DirectoryRowNumber number={rowNumber} />
          ) : (
            <RecordingMode
              rowNumber={rowNumber}
              value={subject.autoRecord}
              captureState={subject.captureState}
              providerStatus={subject.providerStatus}
              label={tr('{{v0}} 是否录制', { v0: subject.handle })}
              onChange={(record) => onRecordingChange(subject, record)}
            />
          )}
        </div>
        <div className="track-cover-cell">
          <button
            className="subject-preview"
            onClick={(event) => {
              if (event.detail === 0) onChoose(subject);
            }}
            aria-label={subject.handle}
            aria-current={selected ? 'true' : undefined}
            title={`${subject.handle} · ${subject.id}`}
          >
            <CoverImage
              id={subject.id}
              revision={coverRevision}
              status={displayStatus(subject)}
              priority={priority}
            >
              <strong className="subject-name">{subject.handle}</strong>
            </CoverImage>
          </button>
        </div>
      </div>
      <div
        aria-busy={priority === 'visible' && (trackState === 'idle' || trackState === 'loading')}
        className="track-lane"
        data-track-state={trackState}
        style={
          data ? ({ '--track-reveal-delay': `${revealDelayMs}ms` } as CSSProperties) : undefined
        }
        role="group"
        tabIndex={0}
        aria-keyshortcuts="Enter"
        aria-label={tr('{{v0}} 录制时间线', { v0: subject.handle })}
        data-from={fromMs}
        data-to={toMs}
      >
        <div className="timeline-scene">
          {/* Only the opacity layer restarts on view changes. The scene keeps its pan clock. */}
          {data ? (
            <TimelineBands
              key={presentationView}
              widthPx={widthPx}
              overscanMs={DAY_MS}
              data={data}
              fromMs={fromMs}
              toMs={toMs}
              scale={scale}
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
  calendar = fullCalendar,
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
  calendar?: ArchiveCalendar;
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
  const scale = useMemo(() => calendar.scale(fromMs, toMs), [calendar, fromMs, toMs]);
  const [viewport, setViewport] = useState({ top: 0, height: 500 });
  const [scrolling, setScrolling] = useState(false);
  const scrollPace = useRef({ active: false, settle: undefined as number | undefined });
  const mountedRows = useRef({ start: 0, end: 0 });
  // Native scrolling owns pixels; React only needs changes to the visible row set.
  const nativeViewport = useRef(viewport);
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
  const previousView = useRef({ fromMs, toMs, calendar });
  const animations = useRef<Animation[]>([]);
  const headerViewport = useRef<HTMLDivElement | null>(null);
  const scrollDirection = useRef(1);
  useLayoutEffect(() => {
    const old = previousView.current;
    const lo = Math.min(old.fromMs, fromMs),
      hi = Math.max(old.toMs, toMs);
    const ratio =
      old.calendar === calendar && calendar.scale(lo, hi).duration === hi - lo
        ? viewPanRatio(old, { fromMs, toMs })
        : 0;
    previousView.current = { fromMs, toMs, calendar };
    const nodes = Array.from(board.current?.querySelectorAll<HTMLElement>(PAN_LAYERS) ?? []);
    const width = board.current?.querySelector('.track-lane')?.clientWidth ?? rulerWidth;
    animations.current = panTimeline(nodes, ratio * width, animations.current);
  }, [fromMs, toMs, calendar]);
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
    if (restoringPosition) restoredPosition.current = true;
    // The compositor can already have scrolled ahead of the latest scroll event.
    // Only explicit restoration/reordering may write a pixel offset back to it.
    const nativeTop = scroller.current?.scrollTop ?? rowTop;
    const topSubject = subjects[Math.floor(nativeTop / SUBJECT_ROW_HEIGHT)];
    if (topSubject)
      onPosition?.({
        id: topSubject.id,
        offset: Math.round(nativeTop % SUBJECT_ROW_HEIGHT),
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
  const trackPlan = {
    visible: visibleIds,
    fromMs: queryFrom,
    toMs: queryTo,
    buckets,
    paused: scrolling,
  };
  const trackData = useTrackData(trackPlan);
  const presentationView = `${filterKey}:${fromMs}:${toMs}`;
  const presentation = useTrackPresentation(trackData, presentationView, trackPlan);
  useSyncClock(() => {
    if (!scrollPace.current.active) setCoverRevision((n) => n + 1);
  });
  const rows = subjects.slice(start, end);
  const targetAt = (element: HTMLElement, clientX: number): number => {
    const box = element.getBoundingClientRect();
    return Math.round(
      scale.at(Math.max(0, Math.min(1, (clientX - box.left) / Math.max(1, box.width)))),
    );
  };
  const cancelGesture = (keepDraft = false): void => {
    window.cancelAnimationFrame(selectionFrame.current ?? 0);
    selectionFrame.current = undefined;
    pendingUpdate.current = null;
    const selecting = gesture.current?.selecting;
    gesture.current?.cancel();
    gesture.current = null;
    setDrag(null);
    if (selecting && !keepDraft) setDraft(null);
  };
  useLayoutEffect(() => {
    cancelGesture(true);
    commitRequest.current?.abort();
    commitRequest.current = null;
    setDraft(null);
  }, [selectedId]);
  useLayoutEffect(() => {
    if (draft.current?.keyboardOrigin) setDraft(null);
  }, [fromMs, toMs, filterKey]);
  useLayoutEffect(() => {
    if (gesture.current) cancelGesture();
    hoverPreview.current?.show(null);
  }, [calendar]);
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
      subjectId: selectedId,
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
            calendar={calendar}
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
          const currentSelection = draft.current?.keyboardOrigin ? draft.current.range : selection;
          const nativeScroll = event.pointerType === 'touch' || event.pointerType === 'pen';
          if (!nativeScroll) {
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
          }
          const edge = target.closest<HTMLElement>('[data-edge]')?.dataset.edge ?? null;
          const at =
            edge === 'from'
              ? currentSelection.fromMs
              : edge === 'to'
                ? currentSelection.toMs
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
            nativeScroll,
            window: currentWindow,
            scale,
            selection: currentSelection,
            edge,
            timelineStartMs,
          });
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const current = gesture.current;
          if (!current) {
            if (event.pointerType === 'touch') return;
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
              coverage &&
              scale.duration > 0
                ? hoverMediaTime(
                    coverage.buckets,
                    targetAt(ruler, event.clientX),
                    scale.duration / ruler.getBoundingClientRect().width,
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
          if (motion.kind === 'idle') return;
          if (!previousMode) setDrag(motion.kind);
          if (motion.kind === 'scroll') {
            event.currentTarget.scrollTop = motion.top;
            return;
          }
          if (!previousMode) commitRequest.current?.abort();
          // Track the pointer throughout the drag; snap or discard only on release.
          pendingUpdate.current = () => {
            const range = motion.range;
            setDraft(range ? { id: current.id, range } : null);
          };
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
          else if (result.kind === 'choose' && subject) {
            commitRequest.current?.abort();
            setDraft(null);
            onChoose(subject);
          }
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => cancelGesture()}
        onPointerLeave={() => hoverPreview.current?.show(null)}
        onLostPointerCapture={() => {
          if (gesture.current) cancelGesture();
        }}
        onAuxClick={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            !event.repeat &&
            !event.altKey &&
            !event.ctrlKey &&
            !event.metaKey
          ) {
            const lane = event.target as HTMLElement;
            if (!lane.matches('.track-lane')) return;
            const id = lane.closest<HTMLElement>('[data-subject-id]')?.dataset.subjectId;
            const range = {
              fromMs: Math.max(fromMs, timelineStartMs),
              toMs: Math.min(toMs, nowMs),
            };
            if (!id || range.fromMs >= range.toMs) return;
            event.preventDefault();
            event.stopPropagation();
            cancelGesture();
            commitRequest.current?.abort();
            hoverPreview.current?.show(null);
            flushSync(() => setDraft({ id, range, keyboardOrigin: lane }));
            event.currentTarget
              .querySelector<HTMLElement>('.selection-edge.from')
              ?.focus({ preventScroll: true });
          }
          if (event.key === 'Escape') {
            commitRequest.current?.abort();
            cancelGesture(true);
            setDraft(null);
          }
        }}
        onScroll={(event) => {
          hoverPreview.current?.show(null);
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
              setScrolling(false);
            }, SCROLL_SETTLE_MS);
          }
          const topSubject =
            subjects[Math.floor(event.currentTarget.scrollTop / SUBJECT_ROW_HEIGHT)];
          if (topSubject)
            onPosition?.({
              id: topSubject.id,
              offset: Math.round(event.currentTarget.scrollTop % SUBJECT_ROW_HEIGHT),
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
          <TrackGrid fromMs={fromMs} toMs={toMs} nowMs={nowMs} scale={scale} />
          <SelectionOverlay
            ref={overlay}
            subjects={subjects}
            selectedId={selectedId}
            selection={selection}
            fromMs={fromMs}
            toMs={toMs}
            scale={scale}
            count={count}
            timelineStartMs={timelineStartMs}
            nowMs={nowMs}
            onCommit={commitRange}
            onDraft={setDraft}
            selectionGeneration={selectionGeneration.current}
          />
          <div
            className="track-spacer"
            aria-hidden="true"
            style={{ height: start * SUBJECT_ROW_HEIGHT }}
          />
          {rows.map((subject, index) => {
            const rowIndex = start + index;
            const visible = rowIndex >= visibleStart && rowIndex < visibleEnd;
            const track = presentation.rows.get(subject.id);
            return (
              <TrackRow
                key={subject.id}
                subject={subject}
                rowNumber={rowIndex + 1}
                data={track?.data}
                trackState={
                  track
                    ? 'ready'
                    : !visible || scrolling
                      ? 'idle'
                      : presentation.failures.has(subject.id)
                        ? 'failed'
                        : 'loading'
                }
                selected={subject.id === selectedId}
                selecting={subject.id === selectingId}
                coverRevision={coverRevision}
                presentationView={presentationView}
                revealDelayMs={track?.delayMs ?? 0}
                widthPx={rulerWidth}
                priority={visible ? 'visible' : 'prefetch'}
                fromMs={fromMs}
                toMs={toMs}
                scale={scale}
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
