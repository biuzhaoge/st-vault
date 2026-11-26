import type { MediaTimeRange } from '@st-vault/api-schema';
import type { ArchivePort } from '../ports.js';

export const WORKBENCH_WINDOW_MS = 8 * 86400000;
export const MEDIA_WINDOW_MS = 9 * 86400000;
export const EMPTY_DAY_SETTLE_MS = 60000;
export type CalendarArchive = Pick<ArchivePort, 'emptyRecordingDays'>;

class ArchiveWindowError extends Error {
  readonly statusCode = 400;
  constructor() {
    super('INVALID_TIME_WINDOW');
  }
}

/** A longer UTC window needs server-side proof that it has a bounded amount of visible time. */
export async function archiveWindows(
  archive: CalendarArchive,
  from: number,
  to: number,
  limit = MEDIA_WINDOW_MS,
): Promise<MediaTimeRange[]> {
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(to) || to <= from)
    throw new ArchiveWindowError();
  if (to - from <= limit) return [{ fromMs: from, toMs: to }];
  const gaps = (await archive.emptyRecordingDays?.()) ?? [];
  const retained: MediaTimeRange[] = [];
  let start = from;
  for (const { fromMs, toMs } of gaps) {
    if (toMs <= start) continue;
    if (fromMs >= to) break;
    if (fromMs > start) retained.push({ fromMs: start, toMs: fromMs });
    start = toMs;
  }
  if (start < to) retained.push({ fromMs: start, toMs: to });
  if (retained.reduce((sum, span) => sum + span.toMs - span.fromMs, 0) > limit)
    throw new ArchiveWindowError();
  return retained;
}
