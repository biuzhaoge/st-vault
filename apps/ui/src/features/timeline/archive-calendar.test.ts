import { afterEach, expect, it } from 'vitest';
import { DAY_MS, dayStart, setTimeZone } from '../../shared/lib/time';
import { ArchiveCalendar } from './archive-calendar';
import { calendarWindow, moveWindow, resizeCalendarWindow } from './range-control';
import { calendarDivisions, rulerDays, rulerTicks } from './ruler';

afterEach(() => setTimeZone('Asia/Shanghai'));
const from = Date.parse('2026-04-01T00:00:00Z');

it('joins recorded dates and maps the seam to the next day for seeking', () => {
  const calendar = new ArchiveCalendar([{ fromMs: from + DAY_MS, toMs: from + 2 * DAY_MS }]);
  const axis = calendar.scale(from, from + 3 * DAY_MS);
  expect(axis.duration).toBe(2 * DAY_MS);
  expect(axis.position(from + DAY_MS)).toBe(0.5);
  expect(axis.position(from + 2 * DAY_MS)).toBe(0.5);
  expect(axis.at(0.5)).toBe(from + 2 * DAY_MS);
  expect(axis.at(0.5, 'earlier')).toBe(from + DAY_MS);
  expect(axis.at(0.75)).toBe(from + 2.5 * DAY_MS);
  expect(calendar.hidden(from + DAY_MS)).toBe(true);
  expect(calendar.hidden(from + 2 * DAY_MS)).toBe(false);
});

it('preserves visible time across a 23-hour empty date in the deployment time zone', () => {
  setTimeZone('America/New_York');
  const left = dayStart(Date.parse('2026-03-07T12:00:00Z'));
  const gap = dayStart(Date.parse('2026-03-08T12:00:00Z'));
  const right = dayStart(Date.parse('2026-03-09T12:00:00Z'));
  const end = dayStart(Date.parse('2026-03-10T12:00:00Z'));
  expect(right - gap).toBe(23 * 3600000);
  const calendar = new ArchiveCalendar([{ fromMs: gap, toMs: right }]);
  expect(calendar.scale(left, end).duration).toBe(2 * DAY_MS);
  expect(calendar.visibleSpan(left, end)).toBe(2 * DAY_MS);
  expect(calendarWindow(left, 2 * DAY_MS, left, end, calendar)).toEqual({
    fromMs: left,
    toMs: end,
  });
});

it('joins dates across a long gap while keeping a half-day step and span', () => {
  setTimeZone('UTC');
  const right = from + 401 * DAY_MS;
  const calendar = new ArchiveCalendar([{ fromMs: from + DAY_MS, toMs: right }]);
  const window = { fromMs: from, toMs: from + DAY_MS };
  const joined = { fromMs: from, toMs: right + DAY_MS };
  const next = moveWindow(window, 2, from, right, DAY_MS, calendar);
  expect(next).toEqual({ fromMs: right, toMs: right + DAY_MS });
  expect(moveWindow(next, -2, from, right, DAY_MS, calendar)).toEqual(window);
  expect(calendarWindow(from, 2 * DAY_MS, from, right, calendar)).toEqual(joined);
  expect(resizeCalendarWindow(window, 'to', 1, from, right, calendar)).toEqual(joined);
  const scale = calendar.scale(joined.fromMs, joined.toMs);
  expect(
    rulerDays(joined.fromMs, joined.toMs, 0, scale).map(({ atMs, position }) => [atMs, position]),
  ).toEqual([
    [from, 0.25],
    [right, 0.75],
  ]);
  expect(calendarDivisions(joined.fromMs, joined.toMs, 0, scale)).toContainEqual({
    atMs: right,
    position: 0.5,
    level: 'day',
  });
  expect(
    rulerTicks(joined.fromMs, joined.toMs, 1200, 0, 0, scale).some(({ atMs }) => atMs > right),
  ).toBe(true);
});
