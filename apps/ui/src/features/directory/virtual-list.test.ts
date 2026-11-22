import { describe, expect, it } from 'vitest';
import {
  SUBJECT_ROW_HEIGHT,
  virtualRows,
  reconcileRowViewport,
  revealRowViewport,
  restoreRowViewport,
} from './virtual-list';

const ids = Array.from({ length: 300 }, (_, i) => String(i));

it('restores deep list anchors before rendering, even after row reordering', () => {
  const reordered = [...ids];
  reordered.unshift(reordered.splice(210, 1)[0]);
  expect(restoreRowViewport(reordered, { id: '210', offset: 17 }, 500)).toBe(17);
  expect(restoreRowViewport(reordered, { id: '220', offset: 17 }, 500)).toBe(
    reordered.indexOf('220') * SUBJECT_ROW_HEIGHT + 17,
  );
  expect(restoreRowViewport([], { id: 'gone', offset: 17 }, 500)).toBe(0);
});

it('reveals any row by ID, including both list edges, with a bounded mounted range', () => {
  const top = revealRowViewport(ids, '210', 500)!;
  expect(top).toBe(210 * SUBJECT_ROW_HEIGHT - (500 - SUBJECT_ROW_HEIGHT) / 2);
  const mounted = virtualRows(ids.length, top, 500);
  expect(mounted.start).toBeLessThanOrEqual(210);
  expect(mounted.end).toBeGreaterThan(210);
  expect(mounted.end - mounted.start).toBeLessThan(16);
  expect(revealRowViewport(ids, '0', 500)).toBe(0);
  expect(revealRowViewport(ids, '299', 500)).toBe(300 * SUBJECT_ROW_HEIGHT - 500);
  expect(revealRowViewport(ids, 'missing', 500)).toBeNull();
});

describe('refresh scroll anchoring', () => {
  const height = 400;
  it('keeps the browsing neighborhood when the top row moves after footage deletion', () => {
    const next = ids.filter((id) => id !== '60');
    next.push('60');
    expect(reconcileRowViewport(ids, next, 60 * SUBJECT_ROW_HEIGHT + 9, height, false)).toBe(
      60 * SUBJECT_ROW_HEIGHT + 9,
    );
  });
  it('preserves the first visible subject and fractional offset after sorting', () => {
    const next = [...ids.slice(260), ...ids.slice(0, 260)];
    expect(reconcileRowViewport(ids, next, 10 * SUBJECT_ROW_HEIGHT + 17, height, false)).toBe(
      50 * SUBJECT_ROW_HEIGHT + 17,
    );
  });
  it('preserves the visible anchor when membership grows', () => {
    expect(
      reconcileRowViewport(ids, ['new', ...ids], 60 * SUBJECT_ROW_HEIGHT + 9, height, false),
    ).toBe(61 * SUBJECT_ROW_HEIGHT + 9);
  });
  it('uses the next surviving neighbor or clamps to the last complete page', () => {
    expect(
      reconcileRowViewport(
        ids,
        ids.filter((id) => id !== '60'),
        60 * SUBJECT_ROW_HEIGHT + 9,
        height,
        false,
      ),
    ).toBe(60 * SUBJECT_ROW_HEIGHT + 9);
    expect(
      reconcileRowViewport(ids, ids.slice(0, 60), 60 * SUBJECT_ROW_HEIGHT + 9, height, false),
    ).toBe(60 * SUBJECT_ROW_HEIGHT - height);
  });
  it('resets on an explicit filter change or an empty result', () => {
    expect(reconcileRowViewport(ids, ids, 1000, height, true)).toBe(0);
    expect(reconcileRowViewport(ids, [], 1000, height, false)).toBe(0);
    expect(reconcileRowViewport(ids, ['replacement'], 1000, 30, false)).toBe(0);
    expect(reconcileRowViewport(ids, [...ids], 1000, height, false)).toBe(1000);
  });
});

describe('bounded subject rendering', () => {
  it('uses a shared 72px height and mounts only the viewport plus overscan', () => {
    expect(SUBJECT_ROW_HEIGHT).toBe(72);
    expect(virtualRows(10000, 0, 500)).toEqual({ start: 0, end: 14 });
  });
  it('mounts a deep scrollbar destination with a bounded lead in the scroll direction', () => {
    const top = 1000 * SUBJECT_ROW_HEIGHT;
    const idle = virtualRows(10000, top, 500);
    expect(virtualRows(10000, top, 500, 4)).toEqual({ start: idle.start, end: idle.end + 4 });
    expect(virtualRows(10000, top, 500, -4)).toEqual({ start: idle.start - 4, end: idle.end });
    expect(idle.start).toBeGreaterThan(990);
    expect(idle.end - idle.start).toBeLessThanOrEqual(15);
  });
  it('clamps empty and shortened lists', () => {
    expect(virtualRows(0, 100000, 500)).toEqual({ start: 0, end: 0 });
    expect(virtualRows(3, 100000, 500)).toEqual({ start: 2, end: 3 });
  });
});
