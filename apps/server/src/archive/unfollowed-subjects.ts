import type { SqlDatabase } from '../database/sql.js';
import type { UnfollowedSubjectResult } from '../ports.js';
import type { DeletionIntents } from './deletion-intents.js';
import { unfinishedDeletionStates } from './deletion-store.js';
import type { EventStore } from './events-store.js';

export const unfollowedPrefix = 'archive.unfollowed.';
export const archiveRestrictionPrefix = 'archive.restriction.';
export const blockedUnfollowPrefix = 'archive.blocked-unfollow.';
export const verifiedUnfollowPrefix = 'archive.verified-unfollow.';

const batchSize = 256;
const liveSegments = `EXISTS(SELECT 1 FROM segments WHERE subject=s.id AND deleted=0)`;
export const hasSubjectFootage = `(${liveSegments}
  OR EXISTS(SELECT 1 FROM objects WHERE subject=s.id AND kind='fragment' AND deleted=0))`;
const idle = `NOT ${liveSegments}
  AND NOT EXISTS(SELECT 1 FROM objects WHERE subject=s.id AND (deleted=0 OR gc_done=0))
  AND NOT EXISTS(SELECT 1 FROM media_deletions WHERE subject=s.id AND state IN (${unfinishedDeletionStates}))
  AND NOT EXISTS(SELECT 1 FROM favorite_commands WHERE subject=s.id AND state='pending')`;
const receiptRows = `FROM subjects s LEFT JOIN account_subjects a ON a.subject=s.id
  LEFT JOIN settings k ON k.key='${unfollowedPrefix}'||s.id
  LEFT JOIN settings ar ON ar.key='${archiveRestrictionPrefix}'||s.id
  LEFT JOIN settings bu ON bu.key='${blockedUnfollowPrefix}'||s.id
  LEFT JOIN settings vu ON vu.key='${verifiedUnfollowPrefix}'||s.id`;
const authorizedCleanup = `CASE WHEN a.following=0 AND ar.value='account_disabled' AND bu.value='accepted'
  THEN 'account_disabled' WHEN a.following=0 AND ar.value IS NULL AND k.value='1' AND vu.value='accepted'
  THEN 'unfollowed' END`;
type CleanupReason = 'unfollowed' | 'account_disabled';

const selections = 'SELECT id FROM media_selections WHERE subject=?';
const units = 'SELECT id FROM recording_units WHERE subject=?';
const tables = [
  ['selection_deletion_copies', `selection IN (${selections})`],
  ['selection_edits', `selection IN (${selections})`],
  ['selection_pins', `selection IN (${selections})`],
  ['selection_units', `selection IN (${selections})`],
  ['favorite_commands', 'subject=?'],
  ['media_selections', 'subject=?'],
  ['unit_favorites', `unit IN (${units})`],
  ['unit_seen', 'subject=?'],
  ['unit_seen_ranges', 'subject=?'],
  ['unit_segments', `unit IN (${units})`],
  ['recording_units', 'subject=?'],
  ['segments', 'subject=?'],
  ['objects', 'subject=?'],
  ['source_checkpoints', 'subject=?'],
  ['coverage_minutes', 'subject=?'],
  ['journal_heads', 'subject=?'],
  ['status_intervals', 'subject=?'],
  ['status_heads', 'subject=?'],
  ['status_event_states', 'subject=?'],
  ['subject_images', 'subject=?'],
  ['subject_name_history', 'subject=?'],
] as const;

export function previewSettingSubject(key: string): string | undefined {
  const avatar = /^preview\.avatar-(?:source|version)\.(stripchat:[1-9]\d*)$/.exec(key);
  if (avatar) return avatar[1];
  const cover = /^preview\.(?:cover-source|default-cover-source)\.([1-9]\d*)$/.exec(key);
  return cover ? `stripchat:${cover[1]}` : undefined;
}

export async function stageEmptySubjectCleanups(
  db: SqlDatabase,
  ids: readonly string[],
  reason: CleanupReason,
): Promise<void> {
  if (!ids.length) return;
  const blocked = reason === 'account_disabled';
  await db
    .prepare(
      `INSERT INTO settings(key,value)
       SELECT ?||s.id,? FROM subjects s JOIN account_subjects a ON a.subject=s.id
       LEFT JOIN settings ar ON ar.key='${archiveRestrictionPrefix}'||s.id
       WHERE a.following=0 AND NOT ${hasSubjectFootage}
       AND ${blocked ? "ar.value='account_disabled'" : 'ar.value IS NULL'}
       AND s.id IN(SELECT value FROM json_array_elements_text(?::json))
       ON CONFLICT(key) DO NOTHING`,
    )
    .run(
      blocked ? blockedUnfollowPrefix : verifiedUnfollowPrefix,
      blocked ? 'pending' : 'accepted',
      JSON.stringify(ids),
    );
}

interface CleanupSubject {
  provider_id: number;
  following: number | null;
  marked: boolean | null;
  restriction: string | null;
  blocked_unfollow: 'pending' | 'accepted' | null;
  verified_unfollow: boolean | null;
  has_footage: boolean;
  idle: boolean;
  cleanup_reason: CleanupReason | null;
}

/** Each cleanup step is authorized by a fresh observation of the active account. */
export class UnfollowedSubjects {
  constructor(
    private readonly db: SqlDatabase,
    private readonly events: EventStore,
    private readonly deletions: DeletionIntents,
  ) {}

  private candidate(id: string): Promise<CleanupSubject | undefined> {
    return this.db
      .prepare(
        `SELECT s.provider_id,a.following,k.value='1' AS marked,ar.value AS restriction,
           bu.value AS blocked_unfollow,vu.value='accepted' AS verified_unfollow,
           ${hasSubjectFootage} AS has_footage,${idle} AS idle,${authorizedCleanup} AS cleanup_reason
         ${receiptRows} WHERE s.id=?`,
      )
      .get<CleanupSubject>(id);
  }

  acceptedIds(
    afterProviderId: number,
    limit: number,
  ): Promise<{ id: string; providerId: number }[]> {
    return this.db
      .prepare(
        `SELECT s.id,s.provider_id AS "providerId" ${receiptRows}
         WHERE s.provider_id>? AND (${authorizedCleanup}) IS NOT NULL AND ${idle}
         ORDER BY s.provider_id LIMIT ?`,
      )
      .all<{ id: string; providerId: number }>(afterProviderId, limit);
  }

  async prepareUnfollowed(id: string): Promise<UnfollowedSubjectResult | 'purge'> {
    const row = await this.candidate(id);
    if (!row) return 'missing';
    // Re-read membership in the same transaction as deletion. A heartbeat can
    // select a candidate immediately before an account sync follows it again.
    if (row.following !== 0 || (row.restriction && row.restriction !== 'account_disabled'))
      return 'stale';
    if (row.restriction || row.blocked_unfollow)
      await this.db
        .prepare('DELETE FROM settings WHERE key IN(?,?)')
        .run(archiveRestrictionPrefix + id, blockedUnfollowPrefix + id);
    if (!row.marked) {
      await this.db
        .prepare(
          "INSERT INTO settings(key,value) VALUES(?,'1') ON CONFLICT(key) DO UPDATE SET value='1'",
        )
        .run(unfollowedPrefix + id);
    }
    if (!row.has_footage && !row.verified_unfollow)
      await stageEmptySubjectCleanups(this.db, [id], 'unfollowed');
    // Scope this to the real segment and object records, including unlocated
    // fragments and footage hidden by an in-flight deletion.
    return row.idle ? 'purge' : 'retained';
  }

  async prepareBlocked(id: string): Promise<UnfollowedSubjectResult | 'unfollow' | 'purge'> {
    const row = await this.candidate(id);
    if (!row) return 'missing';
    if (row.following !== 0 || (row.restriction && row.restriction !== 'account_disabled'))
      return 'stale';
    if (!row.restriction)
      await this.db
        .prepare("INSERT INTO settings(key,value) VALUES(?,'account_disabled')")
        .run(archiveRestrictionPrefix + id);
    if (row.marked || row.verified_unfollow)
      await this.db
        .prepare('DELETE FROM settings WHERE key IN(?,?)')
        .run(unfollowedPrefix + id, verifiedUnfollowPrefix + id);
    if (row.has_footage) {
      if (row.blocked_unfollow)
        await this.db.prepare('DELETE FROM settings WHERE key=?').run(blockedUnfollowPrefix + id);
      return 'retained';
    }
    if (!row.blocked_unfollow) await stageEmptySubjectCleanups(this.db, [id], 'account_disabled');
    if (!row.idle) return 'retained';
    return row.blocked_unfollow === 'accepted' ? 'purge' : 'unfollow';
  }

  async confirmBlockedUnfollow(id: string): Promise<UnfollowedSubjectResult | 'purge'> {
    const row = await this.candidate(id);
    if (!row) return 'missing';
    if (row.following !== 0 || row.restriction !== 'account_disabled' || !row.blocked_unfollow)
      return 'stale';
    await this.db
      .prepare("UPDATE settings SET value='accepted' WHERE key=? AND value='pending'")
      .run(blockedUnfollowPrefix + id);
    return row.idle ? 'purge' : 'retained';
  }

  async resumeAccepted(id: string): Promise<UnfollowedSubjectResult | CleanupReason> {
    const row = await this.candidate(id);
    if (!row) return 'missing';
    if (!row.cleanup_reason) return 'stale';
    return row.idle ? row.cleanup_reason : 'retained';
  }

  async finish(id: string, reason: CleanupReason): Promise<UnfollowedSubjectResult> {
    const row = await this.candidate(id);
    if (!row) return 'missing';
    if (row.cleanup_reason !== reason) return 'stale';
    if (!row.idle) return 'retained';
    return this.purge(id, row.provider_id);
  }

  private async purge(id: string, providerId: number): Promise<UnfollowedSubjectResult> {
    // Preserve terminal command receipts before discarding job details.
    if (await this.deletions.cleanup(id)) return 'retained';
    for (const [table, scope] of tables) {
      const result = await this.db
        .prepare(
          `DELETE FROM ${table} WHERE ctid IN(SELECT ctid FROM ${table} WHERE ${scope} LIMIT ?)`,
        )
        .run(id, batchSize);
      if (Number(result.changes) === batchSize) return 'retained';
    }
    if (await this.events.pruneSubject(id, batchSize)) return 'retained';

    await this.db
      .prepare('DELETE FROM settings WHERE key IN(?,?,?,?,?,?,?,?)')
      .run(
        unfollowedPrefix + id,
        archiveRestrictionPrefix + id,
        blockedUnfollowPrefix + id,
        verifiedUnfollowPrefix + id,
        `preview.cover-source.${providerId}`,
        `preview.default-cover-source.${providerId}`,
        `preview.avatar-source.${id}`,
        `preview.avatar-version.${id}`,
      );
    await this.db.prepare('DELETE FROM account_subjects WHERE subject=?').run(id);
    await this.db.prepare('DELETE FROM subjects WHERE id=?').run(id);
    return 'purged';
  }
}
