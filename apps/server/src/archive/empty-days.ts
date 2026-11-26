import type { MediaTimeRange } from '@st-vault/api-schema';
import type { SqlDatabase } from '../database/sql.js';
import type { EventStore } from './events-store.js';

type SegmentSource = 'segments' | 'visible_segments';

const noFootage = (source: SegmentSource): string => `NOT EXISTS (
    SELECT 1 FROM ${source} s WHERE s.deleted=0
    AND s.start>=r.lo-60000 AND s.start<r.hi AND s."end">r.lo AND s."end">s.start
  ) AND NOT EXISTS (
    SELECT 1 FROM ${source} s WHERE s.deleted=0
    AND s.start<r.lo-60000 AND s."end">r.lo AND s."end"-s.start>60000
  )`;

/** Resolve the first real instant of each civil date, including midnight transitions. */
export async function readEmptyDays(
  db: SqlDatabase,
  zone: string,
  origin: number,
  now: number,
  source: SegmentSource = 'segments',
): Promise<MediaTimeRange[]> {
  // Intl offset IDs follow ISO signs. In PostgreSQL a text zone's offset follows POSIX signs.
  const postgresZone = /^[+-]\d{2}:\d{2}$/.test(zone)
    ? `UTC${zone.startsWith('+') ? '-' : '+'}${zone.slice(1)}`
    : zone;
  const rows = await db
    .prepare(
      `
      WITH RECURSIVE inputs AS (SELECT ?::text zone, ?::double precision origin, ?::double precision now_ms),
    limits AS (
      SELECT zone,
        date_trunc('day',timezone(zone,to_timestamp(origin/1000))) AS first_day,
        date_trunc('day',timezone(zone,to_timestamp(now_ms/1000))) AS today
      FROM inputs
    ),
      nominal AS (
        SELECT l.zone,d.midnight,timezone(l.zone,d.midnight) AS guess
      FROM limits l
        CROSS JOIN LATERAL generate_series(l.first_day,l.today,interval '1 day') d(midnight)
      ),
      candidates AS (
        SELECT n.*, timezone('UTC',n.midnight- (
          timezone(n.zone,n.guess-interval '26 hours')-timezone('UTC',n.guess-interval '26 hours')
        )) AS earlier
        FROM nominal n
      ),
      seeds AS (
        -- PostgreSQL picks the later occurrence of an ambiguous midnight.
        SELECT c.zone,c.midnight,(extract(epoch FROM CASE
          WHEN timezone(c.zone,c.earlier)=c.midnight THEN LEAST(c.earlier,c.guess)
          ELSE c.guess END)*1000)::bigint AS hi,
          timezone(c.zone,c.guess)<>c.midnight AS missing
        FROM candidates c
      ),
      starts(zone,midnight,lo,hi) AS (
        -- A forward jump can skip midnight or a whole date. Search only those boundaries.
        SELECT zone,midnight,CASE WHEN missing THEN hi-26*3600000 ELSE hi END,hi FROM seeds
        UNION ALL
        SELECT s.zone,s.midnight,
          CASE WHEN c.before_date THEN m.instant ELSE s.lo END,
          CASE WHEN c.before_date THEN s.hi ELSE m.instant END
        FROM starts s
        CROSS JOIN LATERAL (SELECT (s.lo+s.hi)/2 AS instant) m
        CROSS JOIN LATERAL (SELECT timezone(s.zone,to_timestamp(m.instant/1000.0))<s.midnight AS before_date) c
        WHERE s.hi-s.lo>1
      ),
      days AS (
        SELECT hi AS lo,lead(hi) OVER (ORDER BY midnight) AS hi FROM starts WHERE hi-lo<=1
    )
      SELECT r.lo AS "fromMs",r.hi AS "toMs" FROM days r WHERE r.hi>r.lo AND ${noFootage(source)}
    ORDER BY r.lo
  `,
    )
    .all<MediaTimeRange>(postgresZone, origin, now);
  const ranges: MediaTimeRange[] = [];
  for (const day of rows) {
    const previous = ranges.at(-1);
    if (previous?.toMs === day.fromMs) previous.toMs = day.toMs;
    else ranges.push(day);
  }
  return ranges;
}

const batchSize = 256;

/** Run with the archive writer's transaction. Revalidate presence before changing any history. */
export async function pruneEmptyHistory(
  db: SqlDatabase,
  events: EventStore,
  { fromMs, toMs }: MediaTimeRange,
): Promise<boolean> {
  const state = await db
    .prepare(`SELECT ${noFootage('segments')} AS empty FROM (SELECT ?::bigint lo,?::bigint hi) r`)
    .get<{ empty: boolean }>(fromMs, toMs);
  if (!state?.empty) return false;
  // Split intervals at both edges and move an extending status head to the retained tail.
  const status = await db
    .prepare(
      `
    WITH bounds AS (SELECT ?::bigint lo,?::bigint hi),
    affected AS MATERIALIZED (
      SELECT s.* FROM status_intervals s CROSS JOIN bounds b
      WHERE s."end">s.start AND s."end">b.lo AND s.start<b.hi
      ORDER BY s."end",s.start,s.subject LIMIT ${batchSize}
    ),
    left_piece AS (
      UPDATE status_intervals s SET "end"=b.lo FROM affected a CROSS JOIN bounds b
      WHERE s.subject=a.subject AND s.start=a.start AND a.start<b.lo
    ),
    inside AS (
      DELETE FROM status_intervals s USING affected a,bounds b
      WHERE s.subject=a.subject AND s.start=a.start AND a.start>=b.lo
    ),
    tail AS (
      INSERT INTO status_intervals(subject,start,"end",status)
      SELECT a.subject,b.hi,a."end",a.status FROM affected a CROSS JOIN bounds b WHERE a."end">b.hi
    ),
    heads AS (
      UPDATE status_heads h SET
        start=CASE WHEN a."end">b.hi THEN b.hi ELSE h.start END,
        active=CASE WHEN a."end">b.hi THEN h.active ELSE 0 END
      FROM affected a CROSS JOIN bounds b WHERE h.subject=a.subject AND h.start=a.start
    )
    SELECT count(*) AS count FROM affected
  `,
    )
    .get<{ count: number }>(fromMs, toMs);
  const minutes = await db
    .prepare(
      `
    DELETE FROM coverage_minutes WHERE (subject,minute) IN (
      SELECT subject,minute FROM coverage_minutes
      WHERE minute>=? AND minute<=? ORDER BY minute,subject LIMIT ${batchSize}
    )
  `,
    )
    .run(fromMs, toMs - 60000);
  const moreEvents = await events.pruneWindow(fromMs, toMs, batchSize);
  return moreEvents || status?.count === batchSize || Number(minutes.changes) === batchSize;
}
