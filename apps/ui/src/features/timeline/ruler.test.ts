import { expect, it } from 'vitest';
import { rulerTicks, calendarDivisions, rulerDays, rulerLabels } from './ruler';
it('identifies only visible Shanghai half days, preserving complete days and overscan', () => {
  const day = Date.UTC(2026, 10, 4, 16),
    duration = 86400000;
  expect(rulerDays(day + duration / 2, day + 2.5 * duration).map((value) => value.half)).toEqual([
    'pm',
    null,
    'am',
  ]);
  expect(rulerDays(day, day + duration / 2)[0].half).toBe('am');
  expect(rulerDays(day, day + duration, duration).every((value) => value.half === null)).toBe(true);
  expect(rulerDays(day + duration / 12, day + (duration * 7) / 12)[0].half).toBeNull();
});
it('keeps day, half-day and hour divisions independent of sparse text ticks', () => {
  const day = Date.UTC(2026, 10, 4, 16),
    hour = 3600000;
  const lines = calendarDivisions(day, day + 7 * 24 * hour);
  expect(lines.find((line) => line.atMs === day)?.level).toBe('day');
  expect(lines.find((line) => line.atMs === day + 12 * hour)?.level).toBe('half-day');
  expect(lines.find((line) => line.atMs === day + hour)?.level).toBe('hour');
  expect(lines).toHaveLength(169);
});
it('centers each date in its own visible day without shifting time boundaries', () => {
  const day = Date.UTC(2026, 10, 4, 16),
    duration = 86400000;
  expect(rulerDays(day, day + 2 * duration).map((value) => value.position)).toEqual([0.25, 0.75]);
  expect(
    rulerDays(day + 23 * 3600000, day + duration + 3600000).map((value) => value.position),
  ).toEqual([0.25, 0.75]);
  expect(calendarDivisions(day, day + duration, duration).some((value) => value.position < 0)).toBe(
    true,
  );
});
it('uses compact time within a Shanghai day and dates across midnight even for a short span', () => {
  const from = Date.UTC(2026, 10, 3, 2);
  expect(
    rulerTicks(from, from + 3600000, 800).every((tick) => /^\d\d:\d\d$/.test(tick.label)),
  ).toBe(true);
  const midnight = Date.UTC(2026, 10, 3, 16);
  expect(
    rulerTicks(midnight - 1800000, midnight + 1800000, 800).every((tick) =>
      /^11-0[34] \d\d:\d\d$/.test(tick.label),
    ),
  ).toBe(true);
});
it('aligns calendar dates and keeps labels apart across narrow and wide windows', () => {
  for (const width of [120, 320, 800, 1800])
    for (const span of [3600000, 12 * 3600000, 3 * 86400000, 7 * 86400000]) {
      const from = Date.UTC(2026, 9, 31),
        ticks = rulerTicks(from, from + span, width);
      expect(ticks.length).toBeGreaterThan(0);
      for (let i = 0; i < ticks.length; i++) {
        expect(ticks[i].atMs).toBeGreaterThanOrEqual(from);
        expect(ticks[i].atMs).toBeLessThanOrEqual(from + span);
        if (i)
          expect((ticks[i].position - ticks[i - 1].position) * width).toBeGreaterThan(
            ticks[i].label.length * 6,
          );
      }
      if (span >= 3 * 86400000)
        expect(ticks.every((tick) => /^\d\d-\d\d$/.test(tick.label))).toBe(true);
    }
});
it('supports calendar months without changing the product range limit', () => {
  const ticks = rulerTicks(Date.UTC(2026, 0, 1), Date.UTC(2026, 6, 1), 800);
  expect(ticks.every((tick) => /^2026-\d\d$/.test(tick.label))).toBe(true);
});
it('shows distinct second labels for minute windows and dates across midnight', () => {
  const from = Date.UTC(2026, 10, 3, 2),
    ticks = rulerTicks(from, from + 60000, 800);
  expect(ticks.length).toBeGreaterThan(2);
  expect(new Set(ticks.map((tick) => tick.label)).size).toBe(ticks.length);
  expect(ticks.every((tick) => /^\d\d:\d\d:\d\d$/.test(tick.label))).toBe(true);
  const midnight = Date.UTC(2026, 10, 3, 16);
  expect(
    rulerTicks(midnight - 30000, midnight + 30000, 800).every((tick) =>
      /^11-0[34] \d\d:\d\d:\d\d$/.test(tick.label),
    ),
  ).toBe(true);
});
it('reserves the left caption without moving ticks or their underlying time coordinates', () => {
  const from = Date.UTC(2026, 10, 4, 16),
    width = 440,
    inset = 76;
  for (const days of [1, 2, 3, 7]) {
    const all = rulerTicks(from, from + days * 86400000, width),
      shown = rulerTicks(from, from + days * 86400000, width, inset);
    expect(shown.length).toBeGreaterThan(0);
    for (const tick of shown) {
      expect(all).toContainEqual(tick);
      expect(tick.position * width).toBeGreaterThan(inset);
      expect(tick.position).toBe((tick.atMs - from) / (days * 86400000));
    }
  }
});

it('keeps adjacent-day ticks available for a clipped horizontal pan', () => {
  const from = Date.UTC(2026, 10, 4, 16),
    day = 86400000;
  const ticks = rulerTicks(from, from + day, 800, 0, day);
  expect(ticks.some((tick) => tick.position < 0)).toBe(true);
  expect(ticks.some((tick) => tick.position > 1)).toBe(true);
  expect(ticks.length).toBeLessThan(100);
});

it('omits colliding hour labels while retaining their time coordinates and divisions', () => {
  const from = Date.UTC(2026, 10, 4, 16);
  const to = from + 86400000;
  const ticks = calendarDivisions(from, to).map((tick) => ({ ...tick, label: '12:00' }));
  const { dates, hours } = rulerLabels(from, to, 640, from, ticks);
  expect(dates[0].position).toBe(0.5);
  expect(hours.some((tick) => tick.position === 0.5)).toBe(false);
  expect(hours.find((tick) => tick.atMs === from + 2 * 3600000)?.position).toBe(2 / 24);
  expect(ticks.find((tick) => tick.position === 0.5)?.level).toBe('half-day');
});

it('shortens narrow calendar dates and preserves complete titles including half days', () => {
  const from = Date.UTC(2025, 10, 4, 16) + 12 * 3600000,
    to = from + 7 * 86400000;
  const dates = rulerLabels(from, to, 686, to + 10 * 86400000, []).dates;
  expect(dates).toHaveLength(8);
  expect(dates[0]).toMatchObject({ label: '11-05', title: '2025-11-05 下午', halfLabel: '下午' });
  expect(dates.at(-1)).toMatchObject({
    label: '11-12',
    title: '2025-11-12 上午',
    halfLabel: '上午',
  });
});
