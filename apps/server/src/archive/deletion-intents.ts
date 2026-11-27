import type { SqlDatabase } from '../database/sql.js';
import type {
  MediaDeletionJob,
  MediaDeletionQueue,
  MediaDeletionTarget,
} from '@st-vault/api-schema';
import { deletionItemStates, type DeletionStore } from './deletion-store.js';
import type { MediaSelectionStore } from './media-selection-store.js';
import { initializeDeletionVisibility } from './unit-visibility.js';
type IntentTarget = MediaDeletionTarget & { protectedFavorites?: Record<string, true> };
interface Intent {
  job: string;
  subject: string;
  payload: string;
  cutoff: number;
  personal: number;
  phase: 'units' | 'extras' | 'plan' | 'delete';
  cursor_start: number;
  cursor_id: string;
  scanned: number;
  selected: number;
  from_ms: number;
  to_ms: number;
  revision: number;
}
type IntentProgress = Pick<
  Intent,
  'job' | 'phase' | 'scanned' | 'selected' | 'from_ms' | 'to_ms' | 'revision'
>;
const receiptKey = (id: string): string => 'deletion.receipt.' + id;
function terminalReceipt(id: string, job: MediaDeletionJob | null): MediaDeletionJob {
  if (job?.id !== id || (job.state !== 'failed' && job.state !== 'completed'))
    throw Error('INVALID_DELETION_RECEIPT');
  return job;
}
function withIntentProgress(job: MediaDeletionJob, intent?: IntentProgress): MediaDeletionJob {
  if (!intent) return job;
  return {
    ...job,
    fromMs: job.fromMs ?? intent.from_ms,
    toMs: job.toMs ?? intent.to_ms,
    phase: intent.phase,
    scannedUnits: intent.scanned,
    selectedUnits: intent.selected,
    deletionRevision: intent.revision,
  };
}
// One predicate owns both immediate visibility and later materialization. During
// preparation, no enumerated deletion_items are needed to retire the footage.
const matches = `u.created_revision<=i.cutoff AND (
  ((i.payload::jsonb #>> '{kind}')='units' AND u.id IN(SELECT value FROM json_array_elements_text(coalesce(i.payload::json #> '{unitIds}','[]'::json)) AS j(value)))
  OR ((i.payload::jsonb #>> '{kind}')='selection' AND EXISTS(SELECT 1 FROM selection_units x
    WHERE x.selection=(i.payload::jsonb #>> '{selectionId}') AND x.unit=u.id))
  OR ((i.payload::jsonb #>> '{kind}')='range' AND (
    (u.start<i.to_ms AND u."end">i.from_ms AND ((i.payload::jsonb #>> '{mode}')='all'
      OR (NOT EXISTS(SELECT 1 FROM unit_favorite_facts f WHERE f.unit=u.id)
        AND NOT COALESCE(jsonb_exists(i.payload::jsonb->'protectedFavorites',u.id),false))))
    OR EXISTS(SELECT 1 FROM selection_units x WHERE x.selection=(i.payload::jsonb #>> '{baseSelectionId}') AND x.unit=u.id)))
  OR u.id IN(SELECT value FROM json_array_elements_text(coalesce(i.payload::json #> '{patch,includeUnitIds}','[]'::json)) AS j(value)))
  AND u.id NOT IN(SELECT value FROM json_array_elements_text(coalesce(i.payload::json #> '{patch,excludeUnitIds}','[]'::json)) AS j(value))`;
/** Small durable admission followed by bounded continuations. */
export class DeletionIntents {
  private readonly db: SqlDatabase;
  private readonly jobs: DeletionStore;
  private readonly selections: MediaSelectionStore;
  private readonly revision: () => Promise<number>;
  private readonly personal: () => Promise<number>;
  constructor(
    db: SqlDatabase,
    jobs: DeletionStore,
    selections: MediaSelectionStore,
    revision: () => Promise<number>,
    personal: () => Promise<number>,
  ) {
    this.db = db;
    this.jobs = jobs;
    this.selections = selections;
    this.revision = revision;
    this.personal = personal;
  }
  async initialize(): Promise<void> {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS deletion_intents(
      job TEXT PRIMARY KEY REFERENCES media_deletions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
      subject TEXT NOT NULL REFERENCES subjects(id) DEFERRABLE INITIALLY DEFERRED,payload TEXT NOT NULL,cutoff BIGINT NOT NULL,
      personal BIGINT NOT NULL,phase TEXT NOT NULL,cursor_start BIGINT NOT NULL DEFAULT -1,
      cursor_id TEXT NOT NULL DEFAULT '',scanned BIGINT NOT NULL DEFAULT 0,selected BIGINT NOT NULL DEFAULT 0,
      from_ms BIGINT NOT NULL,to_ms BIGINT NOT NULL,revision BIGINT NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS deletion_intents_subject ON deletion_intents(subject,phase);
      CREATE OR REPLACE VIEW deletion_intent_units AS
      SELECT u.id AS unit,i.job FROM recording_units u JOIN deletion_intents i ON i.subject=u.subject
      JOIN media_deletions d ON d.id=i.job WHERE d.state IN ('waiting','preparing') AND u.deleted=0 AND
      (CASE WHEN i.phase='plan' THEN EXISTS(SELECT 1 FROM deletion_units x WHERE x.job=i.job AND x.unit=u.id)
      ELSE (${matches}) END)
      UNION ALL SELECT x.unit,x.job FROM deletion_units x JOIN media_deletions d ON d.id=x.job
      WHERE d.state IN (${deletionItemStates});`);
    await initializeDeletionVisibility(this.db);
  }
  async admit(
    subject: string,
    id: string,
    target: MediaDeletionTarget,
    publish?: () => Promise<number>,
  ): Promise<MediaDeletionJob> {
    const payload = JSON.stringify(target);
    // Compact terminal receipts live in the existing portable key/value table. Its
    // schema is already present in historical checkpoints and journal headers.
    const receipt = await this.db
      .prepare(
        `SELECT value::jsonb->'job' AS job,
        value::jsonb->>'target'=encode(sha256(convert_to((?::jsonb)::text,'UTF8')),'hex') AS same
        FROM settings WHERE key=?`,
      )
      .get<{ job: MediaDeletionJob; same: boolean }>(payload, receiptKey(id));
    if (receipt) {
      const job = terminalReceipt(id, receipt.job);
      if (job.subjectId !== subject || !receipt.same) throw Error('COMMAND_ID_CONFLICT');
      return job;
    }
    const prior = await this.db
      .prepare(
        "SELECT subject,(payload::jsonb-'protectedFavorites')=?::jsonb AS same FROM deletion_intents WHERE job=?",
      )
      .get<{
        subject: string;
        same: boolean;
      }>(payload, id);
    if (prior) {
      if (prior.subject !== subject || !prior.same) throw Error('COMMAND_ID_CONFLICT');
      return await this.get(id);
    }
    if (await this.db.prepare('SELECT 1 FROM media_deletions WHERE id=?').get(id))
      throw Error('COMMAND_ID_CONFLICT');
    const base =
      target.kind === 'selection'
        ? target.selectionId
        : target.kind === 'range'
          ? target.baseSelectionId
          : undefined;
    if (base) await this.selections.summary(subject, base);
    const cutoff = await this.revision();
    const stored =
      target.kind === 'range' && target.mode === 'unliked'
        ? JSON.stringify({ ...target, protectedFavorites: {} })
        : payload;
    await this.jobs.begin(subject, [], cutoff, [], id);
    await this.db
      .prepare(
        `INSERT INTO deletion_intents(job,subject,payload,cutoff,personal,phase,from_ms,to_ms)
      VALUES(?,?,?,?,?,'units',?,?)`,
      )
      .run(id, subject, stored, cutoff, await this.personal(), target.fromMs, target.toMs);
    if (base) await this.selections.pin(base, id);
    const state = await this.jobs.admissionState('preparing');
    await this.db
      .prepare('UPDATE media_deletions SET state=?,updated=? WHERE id=?')
      .run(state, Date.now(), id);
    await this.db.prepare('DELETE FROM deletion_growth WHERE job=?').run(id);
    // Seal only the selected open unit. Future recording belongs to a successor
    // and cannot enter this already-confirmed command, even after a long restart.
    await this.db
      .prepare(
        `UPDATE recording_units SET closed=1 WHERE subject=? AND closed=0 AND EXISTS(
      SELECT 1 FROM deletion_intent_units x WHERE x.unit=recording_units.id AND x.job=?)`,
      )
      .run(subject, id);
    if (publish)
      await this.db
        .prepare('UPDATE deletion_intents SET revision=? WHERE job=?')
        .run(await publish(), id);
    return await this.get(id);
  }
  async cleanup(subject?: string): Promise<boolean> {
    return this.jobs.cleanup(async (id) => {
      const key = receiptKey(id);
      const intent = await this.db
        .prepare(
          `SELECT
          encode(sha256(convert_to((payload::jsonb-'protectedFavorites')::text,'UTF8')),'hex') AS target
          FROM deletion_intents WHERE job=? AND NOT EXISTS(SELECT 1 FROM settings WHERE key=?)`,
        )
        .get<{ target: string }>(id, key);
      if (!intent) return;
      const job = await this.get(id);
      await this.db
        .prepare('INSERT INTO settings(key,value) VALUES(?,?)')
        .run(key, JSON.stringify({ target: intent.target, job }));
    }, subject);
  }
  /** Hidden units cannot be newly liked. Preserve only those exclusions which
   * an accepted unlike would otherwise remove, without scanning the delete
   * range at confirmation or waiting for the favorite projection to catch up. */
  async preserveFavorites(subject: string, selection: string): Promise<void> {
    await this.db
      .prepare(
        `WITH removed AS (
        SELECT i.job,jsonb_object_agg(u.id,true) AS members
        FROM deletion_intents i JOIN media_deletions d ON d.id=i.job
        JOIN selection_units x ON x.selection=?
        JOIN recording_units u ON u.id=x.unit AND u.subject=i.subject
        WHERE i.subject=? AND d.state IN ('waiting','preparing') AND i.phase IN ('units','extras')
        AND jsonb_exists(i.payload::jsonb,'protectedFavorites')
        AND u.deleted=0 AND u.created_revision<=i.cutoff AND u.start<i.to_ms AND u."end">i.from_ms
        AND EXISTS(SELECT 1 FROM unit_favorite_facts f WHERE f.unit=u.id)
        GROUP BY i.job
      )
      UPDATE deletion_intents i SET payload=jsonb_set(i.payload::jsonb,'{protectedFavorites}',
        (i.payload::jsonb->'protectedFavorites')||removed.members)::text
      FROM removed WHERE removed.job=i.job`,
      )
      .run(selection, subject);
  }
  async get(id: string): Promise<MediaDeletionJob> {
    return this.progress(await this.jobs.get(id));
  }
  async lookup(id: string): Promise<MediaDeletionJob | null> {
    const receipt = await this.db
      .prepare("SELECT value::jsonb->'job' AS job FROM settings WHERE key=?")
      .get<{ job: MediaDeletionJob }>(receiptKey(id));
    if (receipt) return terminalReceipt(id, receipt.job);
    const job = await this.jobs.find(id);
    if (!job || String(job.state) === 'planned') return null;
    const result = await this.progress(job);
    return String(result.state) === 'discarding' ? null : result;
  }
  private async progress(job: MediaDeletionJob): Promise<MediaDeletionJob> {
    const intent = await this.db
      .prepare(
        'SELECT job,phase,scanned,selected,from_ms,to_ms,revision FROM deletion_intents WHERE job=?',
      )
      .get<IntentProgress>(job.id);
    // The previous release may have begun paged cleanup before upgrading. Only
    // terminal accepted intents enter discarding; failures carry their error.
    if (intent && String(job.state) === 'discarding')
      job.state = job.error ? 'failed' : 'completed';
    return withIntentProgress(job, intent);
  }
  async list(): Promise<MediaDeletionQueue> {
    const inventory = await this.jobs.list();
    const { jobs } = inventory;
    if (jobs.length === 0) return inventory;
    const rows = await this.db
      .prepare(
        'SELECT job,phase,scanned,selected,from_ms,to_ms,revision FROM deletion_intents WHERE job IN (SELECT value FROM json_array_elements_text(?::json))',
      )
      .all<IntentProgress>(JSON.stringify(jobs.map((job) => job.id)));
    const byId = new Map(rows.map((row) => [row.job, row]));
    return { ...inventory, jobs: jobs.map((job) => withIntentProgress(job, byId.get(job.id))) };
  }
  private async unpin(intent: Intent): Promise<void> {
    const target = JSON.parse(intent.payload) as MediaDeletionTarget;
    const base =
      target.kind === 'selection'
        ? target.selectionId
        : target.kind === 'range'
          ? target.baseSelectionId
          : undefined;
    if (base) await this.selections.unpin(base, intent.job);
  }
  async step(jobId?: string): Promise<MediaDeletionJob | null> {
    const i = await this.db
      .prepare(
        `SELECT i.* FROM deletion_intents i JOIN media_deletions d ON d.id=i.job
      WHERE d.state='preparing' AND d.retry_at<=? AND (?::text IS NULL OR i.job=?) ORDER BY d.updated,d.id LIMIT 1 FOR UPDATE OF d,i SKIP LOCKED`,
      )
      .get<Intent>(Date.now(), jobId ?? null, jobId ?? null);
    if (!i) return null;
    const target = JSON.parse(i.payload) as IntentTarget;
    // Commands admitted before exclusion tracking still need the old safety
    // boundary. Their original favorite set cannot be reconstructed.
    if (
      i.phase !== 'plan' &&
      target.kind === 'range' &&
      target.mode === 'unliked' &&
      !target.protectedFavorites &&
      i.personal !== (await this.personal())
    ) {
      await this.db
        .prepare(
          "UPDATE media_deletions SET state='failed',error='media_selection_stale',updated=? WHERE id=?",
        )
        .run(Date.now(), i.job);
      await this.unpin(i);
      await this.jobs.promoteWaiting();
      return await this.get(i.job);
    }
    if (i.phase === 'plan') {
      if (!(await this.jobs.build(i.job))) {
        await this.db
          .prepare(
            "UPDATE media_deletions SET state=CASE WHEN total=processed THEN 'completed' ELSE 'queued' END,updated=? WHERE id=?",
          )
          .run(Date.now(), i.job);
        await this.db.prepare("UPDATE deletion_intents SET phase='delete' WHERE job=?").run(i.job);
        await this.unpin(i);
      }
    } else {
      const range = i.phase === 'units' && target.kind === 'range';
      const next =
        range && (target.baseSelectionId || target.patch?.includeUnitIds?.length)
          ? 'extras'
          : 'plan';
      const candidates = range
        ? `u.deleted=0 AND u.start>GREATEST(-1,i.from_ms-86400000) AND u.start<i.to_ms
        AND u.created_revision<=i.cutoff AND (u.start,u.id)>(i.cursor_start,i.cursor_id)`
        : `u.id>i.cursor_id AND u.id IN(
          SELECT value FROM json_array_elements_text(coalesce(i.payload::json #> '{unitIds}','[]'::json)) AS j(value)
          UNION SELECT value FROM json_array_elements_text(coalesce(i.payload::json #> '{patch,includeUnitIds}','[]'::json)) AS j(value)
          UNION SELECT unit FROM selection_units
          WHERE selection=coalesce(i.payload::jsonb #>> '{selectionId}',i.payload::jsonb #>> '{baseSelectionId}'))`;
      await this.db
        .prepare(
          `WITH intent AS MATERIALIZED (SELECT * FROM deletion_intents WHERE job=?),
          candidates AS MATERIALIZED (
            SELECT u.* FROM intent i JOIN recording_units u ON u.subject=i.subject
            WHERE ${candidates} ORDER BY ${range ? 'u.start,u.id' : 'u.id'} LIMIT 256
          ), selected AS (
            INSERT INTO deletion_units(job,unit)
            SELECT i.job,u.id FROM candidates u CROSS JOIN intent i
            WHERE u.deleted=0 AND (${matches}) ON CONFLICT DO NOTHING RETURNING unit
          ), counts AS (
            SELECT (SELECT count(*) FROM candidates) AS scanned,(SELECT count(*) FROM selected) AS selected
          ), last AS (
            SELECT start,id FROM candidates ORDER BY ${range ? 'start DESC,id DESC' : 'id DESC'} LIMIT 1
          )
          UPDATE deletion_intents i SET phase=CASE WHEN c.scanned=256 THEN i.phase ELSE ? END,
          cursor_start=CASE WHEN c.scanned=256 THEN (SELECT start FROM last) ELSE -1 END,
          cursor_id=CASE WHEN c.scanned=256 THEN (SELECT id FROM last) ELSE '' END,
          scanned=i.scanned+c.scanned,selected=i.selected+c.selected FROM counts c WHERE i.job=?`,
        )
        .run(i.job, next, i.job);
    }
    await this.db
      .prepare('UPDATE media_deletions SET updated=?,error=NULL,retry_at=0 WHERE id=?')
      .run(Date.now(), i.job);
    const job = await this.get(i.job);
    if (job.state === 'completed') await this.jobs.promoteWaiting();
    return job;
  }
  async retry(id: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE media_deletions SET error='storage_unavailable',retry_at=?::bigint+30000,updated=? WHERE id=? AND state='preparing'`,
      )
      .run(Date.now(), Date.now(), id);
  }
}
