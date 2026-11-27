const VIDEO_ASPECT_RATIO = 16 / 9;
export const MONITOR_GAP = 3;

interface MonitorGrid {
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
}

export function monitorGrid(count: number, width: number, height: number): MonitorGrid | null {
  if (count < 1 || width <= 0 || height <= 0) return null;
  let best: MonitorGrid | null = null;
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns);
    const availableWidth = (width - (columns - 1) * MONITOR_GAP) / columns;
    const availableHeight = (height - (rows - 1) * MONITOR_GAP) / rows;
    const tileWidth = Math.floor(Math.min(availableWidth, availableHeight * VIDEO_ASPECT_RATIO));
    if (tileWidth <= 0) continue;
    // Every tile has the same aspect ratio, so the widest fit maximizes the video area.
    if (
      !best ||
      tileWidth > best.tileWidth ||
      (tileWidth === best.tileWidth && columns * rows < best.columns * best.rows)
    )
      best = { columns, rows, tileWidth, tileHeight: tileWidth / VIDEO_ASPECT_RATIO };
  }
  return best;
}
