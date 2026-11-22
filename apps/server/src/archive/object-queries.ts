// The request owns the outer loop. Do not let batch cardinality turn a handful
// of primary-key probes into a scan of every live object via object_verify.
export const hasMediaSql = `WITH requested AS MATERIALIZED (
  SELECT DISTINCT value AS id FROM json_array_elements_text(?::json)
) SELECT COUNT(*) AS count FROM requested r
  JOIN objects o ON o.id=r.id
  WHERE o.deleted=0 AND
  (o.kind='init' OR EXISTS(SELECT 1 FROM visible_segments s WHERE s.id=o.id AND s.deleted=0))`;
export const liveObjectsSql =
  'SELECT * FROM objects WHERE deleted=0 AND id>? ORDER BY id LIMIT 128';
export const liveObjectsIndexSql = 'CREATE INDEX IF NOT EXISTS object_live ON objects(deleted,id)';

const longSpan = '"end"-start>60000';
export const longSegmentIndexSql = `CREATE INDEX IF NOT EXISTS segment_long_overlap
  ON segments(subject,"end",start) WHERE deleted=0 AND ${longSpan}`;

/** Preserve overlap with rare long fragments without a day-wide scan for normal HLS. */
export function overlappingSegmentsSql(source: 'segments' | 'visible_segments'): string {
  return `WITH bounds AS (SELECT ?::text subject,?::double precision lo,?::double precision hi)
    SELECT s.start,s."end",s.id FROM bounds b JOIN ${source} s ON s.subject=b.subject
    WHERE s.deleted=0 AND s.start>=b.lo-60000 AND s.start<b.hi AND s."end">b.lo
    UNION ALL
    SELECT s.start,s."end",s.id FROM bounds b JOIN ${source} s ON s.subject=b.subject
    WHERE s.deleted=0 AND s.start<b.lo-60000 AND s."end">b.lo AND ${longSpan}`;
}
