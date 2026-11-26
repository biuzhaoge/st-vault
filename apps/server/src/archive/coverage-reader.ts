import type {
  CoverageBucket,
  CoverageResponse,
  MediaTimeRange,
  StatusHistoryBucket,
} from '@st-vault/api-schema';
import type { SqlDatabase } from '../database/sql.js';
import { pendingDeletionSql } from './deletion-store.js';
import {
  favoriteCoverageWindow,
  storedFavoriteUnitsSql,
  type PersonalStore,
} from './personal-store.js';
import { overlappingSegmentsSql } from './object-queries.js';
import { readStatusHistory } from './status-history.js';

export const MINUTE = 60000;
interface MinuteSummary {
  minute: number;
  count: number;
  covered_ms: number;
  start_count: number;
  end_count: number;
}

function lower(values: number[], target: number, inclusive = false): number {
  let lo = 0,
    hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (values[mid] < target || (inclusive && values[mid] === target)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
/** Minute-aligned views can keep dense histories in PostgreSQL and return only pixels.
 * A merged union covering a whole minute already supplies both exact endpoints. */
async function alignedMinuteCoverage(
  db: SqlDatabase,
  subject: string,
  from: number,
  to: number,
  width: number,
  buckets: CoverageBucket[],
): Promise<void> {
  const rows = await db
    .prepare(
      `SELECT ((minute-?::bigint)/?::bigint)::integer AS bucket,
      sum(covered_ms)::bigint AS occupied,sum(start_count)::bigint AS starts,
      sum(end_count)::bigint AS ends,
      coalesce(max(count-start_count) FILTER (WHERE minute=?),0)::bigint AS entering,
      min(CASE WHEN covered_ms=${MINUTE} THEN minute
        ELSE minute+(spans::json->0->>0)::double precision END) FILTER (WHERE covered_ms>0) AS first,
      max(CASE WHEN covered_ms=${MINUTE} THEN minute+${MINUTE}
        ELSE minute+(spans::json->-1->>1)::double precision END) FILTER (WHERE covered_ms>0) AS last
    FROM coverage_minutes WHERE subject=? AND minute>=? AND minute<? GROUP BY 1 ORDER BY 1`,
    )
    .all<{
      bucket: number;
      occupied: number;
      starts: number;
      ends: number;
      entering: number;
      first: number | null;
      last: number | null;
    }>(from, width, from, subject, from, to);
  let cursor = 0;
  let active = rows[0]?.bucket === 0 ? rows[0].entering : 0;
  for (const [index, bucket] of buckets.entries()) {
    const row = rows[cursor];
    bucket.segmentCount = active;
    if (row?.bucket !== index) continue;
    cursor++;
    bucket.coveredMs = row.occupied;
    bucket.segmentCount += row.starts;
    if (row.first !== null) bucket.mediaFromMs = row.first;
    if (row.last !== null) bucket.mediaToMs = row.last;
    active += row.starts - row.ends;
  }
}
async function coverage(
  db: SqlDatabase,
  pendingDeletion: boolean,
  id: string,
  from: number,
  to: number,
  count: number,
  state: { unlocated: number; revision: number },
): Promise<CoverageResponse> {
  const buckets: CoverageBucket[] = Array.from({ length: count }, (_, i) => ({
    fromMs: from + Math.floor(((to - from) * i) / count),
    toMs: from + Math.floor(((to - from) * (i + 1)) / count),
    coveredMs: 0,
    segmentCount: 0,
  }));
  const result = (): CoverageResponse => ({
    subjectId: id,
    fromMs: from,
    toMs: to,
    buckets,
    unlocatedCount: state.unlocated,
    revision: state.revision,
  });
  const occupy = (bucket: CoverageBucket, lo: number, hi: number): void => {
    if (hi <= lo) return;
    bucket.coveredMs += hi - lo;
    bucket.mediaFromMs = Math.min(bucket.mediaFromMs ?? Infinity, lo);
    bucket.mediaToMs = Math.max(bucket.mediaToMs ?? -Infinity, hi);
  };
  if (pendingDeletion) {
    // Pending deletion is already absent from the logical archive. Stream the
    // remaining indexed spans until physical GC catches up; never load all IDs.
    let start = -1,
      end = -1;
    const add = (lo: number, hi: number): void => {
      const first = Math.max(
        0,
        Math.min(count - 1, Math.floor(((lo - from) * count) / (to - from))),
      );
      for (let b = first; b < count && buckets[b].fromMs < hi; b++)
        occupy(buckets[b], Math.max(lo, buckets[b].fromMs), Math.min(hi, buckets[b].toMs));
    };
    for await (const raw of db
      .prepare(`${overlappingSegmentsSql('visible_segments')} ORDER BY start,id`)
      .iterate(id, from, to)) {
      const row = raw as {
        start: number;
        end: number;
      };
      const lo = Math.max(from, row.start),
        hi = Math.min(to, row.end);
      const first = Math.max(
        0,
        Math.min(count - 1, Math.floor(((lo - from) * count) / (to - from))),
      );
      for (let b = first; b < count && buckets[b].fromMs < hi; b++) buckets[b].segmentCount++;
      if (start < 0) {
        start = lo;
        end = hi;
      } else if (lo <= end) end = Math.max(end, hi);
      else {
        add(start, end);
        start = lo;
        end = hi;
      }
    }
    if (start >= 0) add(start, end);
    return result();
  }
  const width = (to - from) / count;
  if (from % MINUTE === 0 && width >= 2 * MINUTE && width % MINUTE === 0) {
    await alignedMinuteCoverage(db, id, from, to, width, buckets);
    return result();
  }
  const startCounts = new Array<number>(count).fill(0),
    endCounts = new Array<number>(count).fill(0);
  const boundaryMinutes = new Set<number>();
  for (const boundary of [from, ...buckets.map((bucket) => bucket.toMs)]) {
    if (boundary % MINUTE) boundaryMinutes.add(Math.floor(boundary / MINUTE) * MINUTE);
  }
  let active = 0;
  const rows = await db
    .prepare(
      `SELECT m.minute,count,covered_ms,start_count,end_count,
      (spans::json->0->>0)::double precision AS first,(spans::json->-1->>1)::double precision AS last,
      CASE WHEN edge.value IS NOT NULL THEN spans END AS spans,
      CASE WHEN edge.value IS NOT NULL THEN starts END AS starts,
      CASE WHEN edge.value IS NOT NULL THEN ends END AS ends
      FROM coverage_minutes m LEFT JOIN jsonb_array_elements_text(?::jsonb) AS edge(value)
        ON m.minute=edge.value::bigint
      WHERE m.subject=? AND m.minute>=? AND m.minute<? ORDER BY m.minute`,
    )
    .all<
      MinuteSummary & {
        first: number;
        last: number;
        spans: string | null;
        starts: string | null;
        ends: string | null;
      }
    >(JSON.stringify([...boundaryMinutes]), id, Math.floor(from / MINUTE) * MINUTE, to);
  let bucketIndex = 0;
  for (const row of rows) {
    while (bucketIndex < count && buckets[bucketIndex].toMs <= row.minute) bucketIndex++;
    if (row.minute === from) active = row.count - row.start_count;
    if (
      bucketIndex < count &&
      buckets[bucketIndex].fromMs <= row.minute &&
      buckets[bucketIndex].toMs >= row.minute + MINUTE
    ) {
      buckets[bucketIndex].coveredMs += row.covered_ms;
      if (row.covered_ms > 0) {
        const bucket = buckets[bucketIndex];
        bucket.mediaFromMs = Math.min(bucket.mediaFromMs ?? Infinity, row.minute + row.first);
        bucket.mediaToMs = Math.max(bucket.mediaToMs ?? -Infinity, row.minute + row.last);
      }
      startCounts[bucketIndex] += row.start_count;
      endCounts[bucketIndex] += row.end_count;
      continue;
    }
    if (row.spans === null || row.starts === null || row.ends === null)
      throw new Error('COVERAGE_INDEX_INCONSISTENT');
    const spans = JSON.parse(row.spans) as number[][],
      starts = JSON.parse(row.starts) as number[],
      ends = JSON.parse(row.ends) as number[];
    if (row.minute < from && row.minute + MINUTE > from)
      active =
        row.count -
        (starts.length - lower(starts, from - row.minute)) -
        lower(ends, from - row.minute, true);
    for (let b = bucketIndex; b < count && buckets[b].fromMs < row.minute + MINUTE; b++) {
      const lo = Math.max(from, buckets[b].fromMs) - row.minute,
        hi = Math.min(to, buckets[b].toMs) - row.minute;
      for (const [s, e] of spans)
        occupy(buckets[b], row.minute + Math.max(s, lo), row.minute + Math.min(e, hi));
      startCounts[b] += lower(starts, hi) - lower(starts, lo);
      endCounts[b] += lower(ends, hi, true) - lower(ends, lo, true);
    }
  }
  for (let b = 0; b < count; b++) {
    buckets[b].segmentCount = active + startCounts[b];
    active += startCounts[b] - endCounts[b];
  }
  return result();
}

export function createCoverageReader(
  db: SqlDatabase,
  personalStore: PersonalStore,
  snapshotLayoutVersion: (id: string) => Promise<string>,
) {
  return async ({
    id,
    from,
    to,
    buckets,
    includeProtection,
  }: {
    id: string;
    from: number;
    to: number;
    buckets: number;
    includeProtection?: boolean;
  }): Promise<CoverageResponse> => {
    // These are negative proofs in this row's MVCC snapshot. A pending like can
    // supply the first favorite before the materializer has written unit_favorites.
    const state = await db
      .prepare(
        `SELECT s.unlocated,COALESCE((SELECT revision FROM counters WHERE id=1),0) AS revision,
      ${pendingDeletionSql} AS pending,
      EXISTS(SELECT 1 FROM unit_seen_ranges WHERE subject=s.id) AS seen,
      (EXISTS(${storedFavoriteUnitsSql})
       OR EXISTS(SELECT 1 FROM favorite_commands
        WHERE subject=s.id AND state='pending' AND liked=1)) AS favorites
      FROM subjects s WHERE s.id=?`,
      )
      .get<{
        unlocated: number;
        revision: number;
        pending: boolean;
        seen: boolean;
        favorites: boolean;
      }>(id, id, ...favoriteCoverageWindow(id, from, to), id);
    if (!state) throw Error('SUBJECT_NOT_FOUND');
    const result = await coverage(db, state.pending, id, from, to, buckets, state);
    const occupied = result.buckets.some((bucket) => bucket.coveredMs > 0);
    const viewing =
      occupied && state.seen
        ? await personalStore.seenCoverage(id, from, to, buckets)
        : { seenSpans: [] };
    const favorites =
      occupied && state.favorites
        ? await personalStore.favoriteCoverage(id, from, to, buckets)
        : [];
    return {
      ...result,
      ...viewing,
      ...(favorites.length ? { favoriteSpans: favorites } : {}),
      ...(includeProtection
        ? {
            protectedSpans: await personalStore.protectedCoverage(
              id,
              from,
              to,
              buckets,
              await snapshotLayoutVersion(id),
            ),
          }
        : {}),
    };
  };
}

/** Keep sampling density on the visible spans and publish every slice from one archive snapshot. */
export async function readWorkbenchHistory(
  db: SqlDatabase,
  readCoverage: ReturnType<typeof createCoverageReader>,
  input: Parameters<typeof readCoverage>[0],
  ranges?: MediaTimeRange[],
) {
  const { id: subjectId, from: fromMs, to: toMs, buckets } = input;
  if (!ranges)
    return {
      coverage: await readCoverage(input),
      status: await readStatusHistory(db, subjectId, fromMs, toMs, buckets),
    };
  const total = ranges.reduce((sum, span) => sum + span.toMs - span.fromMs, 0);
  const slices: CoverageResponse[] = [],
    status: StatusHistoryBucket[] = [];
  for (const { fromMs: from, toMs: to } of ranges) {
    const span = to - from;
    const count = Math.min(span, Math.max(1, Math.round((buckets * span) / total)));
    slices.push(await readCoverage({ ...input, from, to, buckets: count }));
    status.push(...(await readStatusHistory(db, subjectId, from, to, count)).buckets);
  }
  const { revision, unlocatedCount } =
    slices[0] ?? (await readCoverage({ ...input, to: fromMs + 1, buckets: 1 }));
  const coverage: CoverageResponse = {
    subjectId,
    fromMs,
    toMs,
    revision,
    unlocatedCount,
    buckets: slices.flatMap((slice) => slice.buckets),
    seenSpans: slices.flatMap((slice) => slice.seenSpans ?? []),
    favoriteSpans: slices.flatMap((slice) => slice.favoriteSpans ?? []),
  };
  if (input.includeProtection)
    coverage.protectedSpans = slices.flatMap((slice) => slice.protectedSpans ?? []);
  if (slices.some((slice) => slice.unreadSpans)) {
    coverage.unreadSpans = slices.flatMap(
      (slice) =>
        slice.unreadSpans ??
        slice.buckets
          .filter((bucket) => bucket.coveredMs > 0)
          .map((bucket) => ({
            fromMs: bucket.mediaFromMs ?? bucket.fromMs,
            toMs: bucket.mediaToMs ?? bucket.toMs,
          })),
    );
  }
  return { coverage, status: { subjectId, fromMs, toMs, buckets: status } };
}
