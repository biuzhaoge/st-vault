import { DAY_MS, calendarSlot, slotTime, dayStart, type ViewWindow } from '../../shared/lib/time';
import { fullCalendar, type ArchiveCalendar } from './archive-calendar';
export { DAY_MS, dayStart, type ViewWindow } from '../../shared/lib/time';
export const VIEW_STEP_MS = DAY_MS / 2;
export const DEFAULT_RANGE_MS = DAY_MS;
export const MAX_RANGE_MS = 7 * DAY_MS;
export const RANGE_STOPS = Array.from({ length: 14 }, (_, index) => (index + 1) * VIEW_STEP_MS);
const MAX_VIEW_POSITION_MS = 8640000000000000 - DAY_MS - MAX_RANGE_MS;
/** Round ordinary aggregation queries, retaining exact endpoints at the API cap. */
export function aggregateWindow(window: ViewWindow, step: number, start = 0): ViewWindow {
  const fromMs = Math.max(start, Math.floor(window.fromMs / step) * step),
    toMs = Math.ceil(window.toMs / step) * step;
  return toMs - fromMs > MAX_RANGE_MS
    ? { fromMs: Math.max(start, window.fromMs), toMs: window.toMs }
    : { fromMs, toMs };
}
/** Whole-minute buckets let long directory queries aggregate indexed summaries. */
export function directoryBucketCount({ fromMs, toMs }: ViewWindow, width: number): number {
  const target = Math.max(60, Math.min(720, Math.round(width)));
  const minutes = (toMs - fromMs) / 60000;
  if (minutes < 1440 || fromMs % 60000 || !Number.isInteger(minutes)) return target;
  for (let count = target; count >= target / 2; count--) if (minutes % count === 0) return count;
  return target;
}
export function snapSpan(duration: number): number {
  return RANGE_STOPS.includes(duration) ? duration : DEFAULT_RANGE_MS;
}
/** Leave room for a full week and timezone transitions inside JavaScript's Date limit. */
export function isValidViewPosition(atMs: unknown): atMs is number {
  return (
    typeof atMs === 'number' &&
    Number.isSafeInteger(atMs) &&
    atMs >= 0 &&
    atMs <= MAX_VIEW_POSITION_MS
  );
}
function calendarEndSlot(nowMs: number): number {
  return (Math.floor(calendarSlot(nowMs) / 2) + 1) * 2;
}
/** The next local midnight, including on short or long DST days. */
export function calendarEnd(nowMs: number): number {
  return slotTime(calendarEndSlot(nowMs));
}
/** Half-day slots, bounded by initialization day and the end of today. */
export function calendarWindow(
  fromMs: number,
  durationMs: number,
  timelineStartMs = 0,
  nowMs = Date.now(),
  calendar = fullCalendar,
): ViewWindow {
  const safeFrom = isValidViewPosition(fromMs) ? fromMs : nowMs;
  const last = calendarEndSlot(nowMs);
  const end = calendar.slot(last);
  const first = Math.min(calendar.slot(calendarSlot(dayStart(timelineStartMs))), end - 2);
  const slots = Math.min(snapSpan(durationMs) / VIEW_STEP_MS, end - first);
  const target = Math.max(first, Math.min(calendar.slot(calendarSlot(safeFrom)), end - 1));
  const start = Math.min(target, end - slots);
  return {
    fromMs: slotTime(calendar.restoreSlot(start, 'later')),
    toMs: slotTime(calendar.restoreSlot(start + slots, 'earlier')),
  };
}
export function restoreViewWindow(
  viewToMs: number | null | undefined,
  durationMs: number,
  nowMs: number,
  timelineStartMs: number,
  calendar = fullCalendar,
): ViewWindow {
  const duration = snapSpan(durationMs);
  return calendarWindow(
    isValidViewPosition(viewToMs)
      ? slotTime(
          calendar.restoreSlot(
            calendar.slot(calendarSlot(viewToMs)) - duration / VIEW_STEP_MS,
            'later',
          ),
        )
      : nowMs,
    duration,
    timelineStartMs,
    nowMs,
    calendar,
  );
}
export function moveWindow(
  window: ViewWindow,
  direction: number,
  timelineStartMs = 0,
  nowMs = Date.now(),
  spanMs?: number,
  calendar: ArchiveCalendar = fullCalendar,
): ViewWindow {
  if (!Number.isFinite(direction)) return window;
  return calendarWindow(
    slotTime(
      calendar.restoreSlot(
        calendar.slot(calendarSlot(window.fromMs)) + Math.round(direction),
        'later',
      ),
    ),
    spanMs ?? calendar.visibleSpan(window.fromMs, window.toMs),
    timelineStartMs,
    nowMs,
    calendar,
  );
}

/** Resize one edge in half-day slots without moving its opposite. Delta is in days. */
export function resizeCalendarWindow(
  window: ViewWindow,
  edge: 'from' | 'to',
  deltaDays: number,
  timelineStartMs: number,
  nowMs = Date.now(),
  calendar = fullCalendar,
): ViewWindow {
  if (!Number.isFinite(deltaDays)) return window;
  const delta = Math.round(deltaDays * 2);
  const first = calendar.slot(calendarSlot(dayStart(timelineStartMs))),
    last = calendar.slot(calendarEndSlot(nowMs));
  const from = calendar.slot(calendarSlot(window.fromMs)),
    to = calendar.slot(calendarSlot(window.toMs));
  const maximum = MAX_RANGE_MS / VIEW_STEP_MS;
  return edge === 'from'
    ? {
        fromMs: slotTime(
          calendar.restoreSlot(
            Math.max(first, to - maximum, Math.min(to - 1, from + delta)),
            'later',
          ),
        ),
        toMs: window.toMs,
      }
    : {
        fromMs: window.fromMs,
        toMs: slotTime(
          calendar.restoreSlot(
            Math.min(last, from + maximum, Math.max(from + 1, to + delta)),
            'earlier',
          ),
        ),
      };
}

export function viewPanRatio(previous: ViewWindow, next: ViewWindow): number {
  const duration = next.toMs - next.fromMs,
    delta = next.fromMs - previous.fromMs;
  // Only adjacent-day navigation has an overscanned continuation to animate.
  return duration > 0 && duration === previous.toMs - previous.fromMs && Math.abs(delta) <= DAY_MS
    ? delta / duration
    : 0;
}
