import type { SqlDatabase } from '../database/sql.js';

/** Units own deletion identity; surviving members only establish media existence. */
export async function initializeUnitVisibility(
  db: SqlDatabase,
  deletionIntents = false,
): Promise<void> {
  await db.exec(`CREATE OR REPLACE VIEW visible_recording_units AS
    SELECT u.* FROM recording_units u WHERE u.deleted=0
    ${deletionIntents ? 'AND (SELECT 1 FROM deletion_intent_units x WHERE x.unit=u.id LIMIT 1) IS NULL' : ''}
    AND (SELECT 1 FROM unit_segments m JOIN segments s ON s.id=m.segment
      WHERE m.unit=u.id AND s.deleted=0 LIMIT 1) IS NOT NULL`);
}

/** Scalar probes keep the candidate's index seek ahead of deletion membership
 * checks. An anti-join can otherwise expand the entire active intent view even
 * when a media read asks for exactly one fragment.
 */
export async function initializeDeletionVisibility(db: SqlDatabase): Promise<void> {
  await db.exec(`
    CREATE INDEX IF NOT EXISTS deletion_unit_membership ON deletion_units(unit,job);
    CREATE INDEX IF NOT EXISTS deletion_subject_active ON media_deletions(subject)
      WHERE state IN ('preparing','queued','running','retry');
    CREATE OR REPLACE VIEW visible_segments AS SELECT s.* FROM segments s WHERE
      (SELECT 1 FROM deletion_items i JOIN media_deletions d ON d.id=i.job
        WHERE i.segment=s.id AND d.state IN ('queued','running','retry') LIMIT 1) IS NULL
      AND (SELECT 1 FROM unit_segments m JOIN recording_units u ON u.id=m.unit
        WHERE m.segment=s.id AND (
          u.deleted=1 OR (SELECT 1 FROM deletion_intent_units x WHERE x.unit=m.unit LIMIT 1) IS NOT NULL
        ) LIMIT 1) IS NULL;
  `);
  await initializeUnitVisibility(db, true);
}
