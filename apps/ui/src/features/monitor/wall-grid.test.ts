import { describe, expect, it } from 'vitest';
import { monitorGrid, MONITOR_GAP } from './wall-grid';

describe('monitor wall grid', () => {
  it('expands and contracts with online arrivals and departures', () => {
    expect(monitorGrid(1, 1200, 650)).toMatchObject({ columns: 1, rows: 1 });
    expect(monitorGrid(2, 1200, 650)).toMatchObject({ columns: 2, rows: 1 });
    expect(monitorGrid(3, 1200, 650)).toMatchObject({ columns: 2, rows: 2 });
    expect(monitorGrid(5, 1200, 650)).toMatchObject({ columns: 3, rows: 2 });
  });

  it('changes row and column counts to fit a resized viewing area', () => {
    expect(monitorGrid(6, 1400, 520)).toMatchObject({ columns: 3, rows: 2 });
    expect(monitorGrid(6, 744, 590)).toMatchObject({ columns: 2, rows: 3 });
  });

  it('keeps all occupied tiles in view at their video aspect ratio', () => {
    const width = 743;
    const height = 541;
    const count = 47;
    const grid = monitorGrid(count, width, height)!;
    expect(grid.columns * grid.rows).toBeGreaterThanOrEqual(count);
    expect(grid.tileWidth * grid.columns + MONITOR_GAP * (grid.columns - 1)).toBeLessThanOrEqual(
      width,
    );
    expect(grid.tileHeight * grid.rows + MONITOR_GAP * (grid.rows - 1)).toBeLessThanOrEqual(height);
    expect(grid.tileWidth / grid.tileHeight).toBeCloseTo(16 / 9);
  });

  it('waits for a measurable area or a nonempty list', () => {
    expect(monitorGrid(0, 1200, 700)).toBeNull();
    expect(monitorGrid(5, 0, 700)).toBeNull();
  });
});
