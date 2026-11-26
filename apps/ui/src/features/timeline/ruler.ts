import { civilTime, fromCivilTime, slotTime } from '../../shared/lib/time';
import { dayKey, dayLabel, clockLabel } from '../../shared/lib/date-label';
import { tr } from '../../shared/lib/i18n';
import { fullCalendar } from './archive-calendar';
const MINUTE = 60000,
  HOUR = 60 * MINUTE,
  DAY = 24 * HOUR;
export interface RulerTick {
  atMs: number;
  label: string;
  position: number;
}
export function calendarDivisions(
  from: number,
  to: number,
  overscan = 0,
  scale = fullCalendar.scale(from, to),
): { atMs: number; position: number; level: 'day' | 'half-day' | 'hour' }[] {
  if (!(scale.duration > 0) || !Number.isFinite(scale.duration)) return [];
  const result: ReturnType<typeof calendarDivisions> = [];
  let atMs = from - overscan;
  // Actual-time traversal retains repeated DST hours; local rounding also
  // handles half-hour transitions without drawing a false whole-hour tick.
  for (let attempts = 0; atMs <= to + overscan && attempts < 1000; attempts++) {
    atMs = scale.nextVisible(atMs);
    if (atMs > to + overscan) break;
    const local = civilTime(atMs);
    const remainder = ((local % HOUR) + HOUR) % HOUR;
    if (remainder) {
      atMs += HOUR - remainder;
      continue;
    }
    const hour = ((local % DAY) + DAY) % DAY;
    result.push({
      atMs,
      position: scale.position(atMs),
      level: hour === 0 ? 'day' : hour === 12 * HOUR ? 'half-day' : 'hour',
    });
    atMs += HOUR;
  }
  return result;
}
/** Date captions occupy the center of each visible day or half day. */
export function rulerDays(
  from: number,
  to: number,
  overscan = 0,
  scale = fullCalendar.scale(from, to),
): { atMs: number; position: number; width: number; half: 'am' | 'pm' | null }[] {
  if (!(scale.duration > 0) || !Number.isFinite(scale.duration)) return [];
  const result: ReturnType<typeof rulerDays> = [];
  const first = Math.floor(civilTime(from - overscan) / DAY);
  for (let day = first, attempts = 0; attempts < 100; day++, attempts++) {
    const atMs = slotTime(day * 2),
      noon = slotTime(day * 2 + 1),
      end = slotTime((day + 1) * 2);
    if (atMs >= to + overscan) break;
    const next = scale.nextVisible(atMs);
    if (next > atMs) {
      day = Math.max(day, Math.floor(civilTime(next) / DAY) - 1);
      continue;
    }
    const visibleFrom = atMs < to && end > from ? Math.max(atMs, from) : atMs;
    const visibleTo = atMs < to && end > from ? Math.min(end, to) : end;
    const left = scale.position(visibleFrom),
      right = scale.position(visibleTo);
    if (right <= left) continue;
    result.push({
      atMs,
      half:
        visibleFrom === atMs && visibleTo === noon
          ? 'am'
          : visibleFrom === noon && visibleTo === end
            ? 'pm'
            : null,
      position: (left + right) / 2,
      width: right - left,
    });
  }
  return result;
}

const hourText = (label: string): string => label.slice(label.lastIndexOf(' ') + 1);
const hourLabelWidth = (label: string): number => label.length * 7 + 4;

/** The allocated slots bound text in both languages before selecting the hour labels. */
export function rulerLabels(
  from: number,
  to: number,
  width: number,
  now: number,
  ticks: RulerTick[],
  overscan = 0,
  scale = fullCalendar.scale(from, to),
) {
  const estimate = (label: string, size: number): number =>
    [...label].reduce((sum, char) => sum + (/^[\x00-\x7F]$/.test(char) ? size * 0.65 : size), 0);
  const gap = 3;
  const dates = rulerDays(from, to, overscan, scale).flatMap((day) => {
    const available = day.width * width - gap;
    if (available < 34) return [];
    const full = dayLabel(day.atMs, now);
    const compact = dayKey(day.atMs).slice(5);
    const half = day.half ? tr(day.half === 'am' ? '上午' : '下午') : '';
    const halfWidth = half ? estimate(half, 10) + 3 : 0;
    const label =
      estimate(full, 12) + halfWidth + hourLabelWidth('00:00') + 2 * gap <= available ||
      estimate(full, 12) <= estimate(compact, 12)
        ? full
        : compact;
    return [
      {
        ...day,
        label,
        halfLabel: half,
        title: half ? `${full} ${half}` : full,
        widthPx: Math.min(available, Math.ceil(estimate(label, 12) + halfWidth)),
      },
    ];
  });
  const hours = ticks.flatMap((tick) => {
    const label = hourText(tick.label);
    const widthPx = hourLabelWidth(label);
    const fits = dates.every(
      (day) => Math.abs(tick.position - day.position) * width >= (widthPx + day.widthPx) / 2 + gap,
    );
    return fits ? [{ ...tick, label, widthPx }] : [];
  });
  return { dates, hours };
}
const date = (ms: number): string => dayKey(ms).slice(5);
const time = (ms: number, seconds = false): string => clockLabel(ms).slice(0, seconds ? 8 : 5);
/** Deployment-calendar ticks with reserved text width at both edges. */
export function rulerTicks(
  from: number,
  to: number,
  width: number,
  labelInset = 0,
  overscanMs = 0,
  scale = fullCalendar.scale(from, to),
): RulerTick[] {
  if (!(scale.duration > 0) || !Number.isFinite(width) || width < 45) return [];
  const duration = scale.duration,
    crossesDay = dayKey(from) !== dayKey(to);
  const daily = duration >= 3 * DAY,
    monthly = duration >= 90 * DAY,
    seconds = duration < 5 * MINUTE;
  const labelWidth = monthly
    ? 54
    : daily
      ? 42
      : crossesDay
        ? seconds
          ? 114
          : 92
        : seconds
          ? 60
          : 40;
  const count = Math.max(1, Math.floor(width / (labelWidth + 24)));
  const intervals = [
    1000,
    2000,
    5000,
    10000,
    15000,
    30000,
    MINUTE,
    2 * MINUTE,
    5 * MINUTE,
    10 * MINUTE,
    15 * MINUTE,
    30 * MINUTE,
    HOUR,
    2 * HOUR,
    3 * HOUR,
    6 * HOUR,
    12 * HOUR,
    DAY,
    2 * DAY,
    7 * DAY,
    14 * DAY,
  ];
  const step =
    intervals.find(
      (value) =>
        value >= duration / count && (!daily || value >= DAY) && (seconds || value >= MINUTE),
    ) ?? 30 * DAY;
  const ticks: RulerTick[] = [],
    inset = (labelWidth / 2 + 3) / width;
  const candidates: number[] = [];
  if (monthly) {
    const local = new Date(civilTime(from));
    let month = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1);
    while (fromCivilTime(month) <= to + overscanMs && candidates.length < 100) {
      candidates.push(fromCivilTime(month));
      const current = new Date(month);
      month = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1);
    }
  } else if (step >= DAY) {
    const dates = rulerDays(from, to, overscanMs, scale);
    const stride = Math.max(1, Math.round(step / DAY));
    candidates.push(
      ...dates.filter((_date, index) => index % stride === 0).map((date) => date.atMs),
    );
  } else if (step >= HOUR) {
    candidates.push(
      ...calendarDivisions(from, to, overscanMs, scale)
        .filter((tick) => (((civilTime(tick.atMs) % DAY) + DAY) % DAY) % step === 0)
        .map((tick) => tick.atMs),
    );
  } else {
    const start = from - overscanMs;
    let next = fromCivilTime(Math.ceil(civilTime(start) / step) * step);
    while (next < start) next += step;
    for (; next <= to + overscanMs && candidates.length < 100; next += step) {
      next = scale.nextVisible(next);
      if (next <= to + overscanMs) candidates.push(next);
    }
  }
  for (const next of candidates) {
    if (next < from - overscanMs || next > to + overscanMs || scale.hidden(next)) continue;
    const position = scale.position(next);
    if (
      (position >= inset + labelInset / width && position <= 1 - inset) ||
      position < 0 ||
      position > 1
    )
      ticks.push({
        atMs: next,
        label: monthly
          ? dayKey(next).slice(0, 7)
          : daily
            ? date(next)
            : crossesDay
              ? `${date(next)} ${time(next, seconds)}`
              : time(next, seconds),
        position,
      });
  }
  if (!ticks.length) {
    const atMs = Math.round(scale.at(0.5));
    ticks.push({
      atMs,
      label: daily
        ? date(atMs)
        : crossesDay
          ? `${date(atMs)} ${time(atMs, seconds)}`
          : time(atMs, seconds),
      position: 0.5,
    });
  }
  return ticks;
}
