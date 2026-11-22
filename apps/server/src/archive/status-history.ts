import type { PublicStatus, StatusHistoryResponse } from '@st-vault/api-schema';
import type { SqlDatabase } from '../database/sql.js';

const pageSize = 128;

export const firstStatusPageSql = `SELECT start,"end",status FROM status_intervals
  WHERE subject=? AND start>=(
    SELECT start FROM status_intervals WHERE subject=? AND "end">? ORDER BY "end",start LIMIT 1
  ) AND start<? ORDER BY start LIMIT ${pageSize}`;

interface StatusInterval {
  start: number;
  end: number;
  status: PublicStatus;
}

/** Run inside the worker's repeatable-read transaction so pages share a snapshot. */
export async function readStatusHistory(
  db: Pick<SqlDatabase, 'prepare'>,
  subjectId: string,
  fromMs: number,
  toMs: number,
  count: number,
): Promise<StatusHistoryResponse> {
  if (!(await db.prepare('SELECT 1 FROM subjects WHERE id=?').get(subjectId)))
    throw new Error('SUBJECT_NOT_FOUND');
  const duration = toMs - fromMs;
  const buckets = Array.from({ length: count }, (_, index) => {
    const from = fromMs + Math.floor((duration * index) / count),
      to = fromMs + Math.floor((duration * (index + 1)) / count);
    return {
      fromMs: from,
      toMs: to,
      durationsMs: { PUBLIC: 0, PRIVATE: 0, OFFLINE: 0, UNKNOWN: to - from },
    };
  });
  const before = Math.min(toMs, Date.now());
  const nextPage = db.prepare(
    `SELECT start,"end",status FROM status_intervals
     WHERE subject=? AND start>? AND start<? ORDER BY start LIMIT ${pageSize}`,
  );
  // The end index finds a carry-in interval that started before the window.
  let rows = await db
    .prepare(firstStatusPageSql)
    .all<StatusInterval>(subjectId, subjectId, fromMs, before);
  for (;;) {
    for (const row of rows) {
      if (row.status === 'UNKNOWN') continue;
      const start = Math.max(fromMs, row.start),
        end = Math.min(before, row.end);
      if (end <= start) continue;
      let index = Math.max(
        0,
        Math.min(count - 1, Math.floor(((start - fromMs) * count) / duration)),
      );
      while (index < count && buckets[index].fromMs < end) {
        const bucket = buckets[index++];
        const overlap = Math.max(0, Math.min(end, bucket.toMs) - Math.max(start, bucket.fromMs));
        bucket.durationsMs[row.status] += overlap;
        bucket.durationsMs.UNKNOWN -= overlap;
      }
    }
    if (rows.length < pageSize) break;
    rows = await nextPage.all<StatusInterval>(subjectId, rows[pageSize - 1].start, before);
  }
  return { subjectId, fromMs, toMs, buckets };
}
