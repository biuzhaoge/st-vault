import type { ArchiveReason } from '@st-vault/api-schema';
import type { SqlDatabase } from '../database/sql.js';
import type { SubjectInput } from '../ports.js';
import {
  archiveRestrictionPrefix,
  blockedUnfollowPrefix,
  stageEmptySubjectCleanups,
  unfollowedPrefix,
  verifiedUnfollowPrefix,
} from './unfollowed-subjects.js';

const resetUnfollowsKey = 'account.reset-unfollows.next';
type ManualUnfollowState = 'ready' | 'retained' | 'missing' | 'stale';

interface AccountProfileRow {
  id: string;
  providerId: number;
  handle: string;
  accountArchiveReason: ArchiveReason | null;
  avatarSourceUrl: string | null;
  previewSourceUrl: string | null;
}

function profileInput({
  accountArchiveReason,
  avatarSourceUrl,
  previewSourceUrl,
  ...row
}: AccountProfileRow): SubjectInput {
  return {
    ...row,
    ...(accountArchiveReason ? { accountArchiveReason } : {}),
    ...(avatarSourceUrl ? { avatarSourceUrl } : {}),
    ...(previewSourceUrl ? { previewSourceUrl } : {}),
    ...(row.handle === `主播 #${row.providerId}` ? { subjectProfilePending: true } : {}),
  };
}

function monitored(row: SubjectInput): boolean {
  return (
    (!row.accountArchiveReason || row.accountArchiveReason === 'region_restricted') &&
    !row.accountArchivePending
  );
}
/** Only public list data and an opaque activation ID enter the portable library. */
export class AccountSubjects {
  private readonly db: SqlDatabase;
  private readonly add: (subject: SubjectInput, trackNames: boolean) => Promise<void>;
  private readonly disable: (id: string) => Promise<void>;
  constructor(
    db: SqlDatabase,
    add: (subject: SubjectInput, trackNames: boolean) => Promise<void>,
    disable: (id: string) => Promise<void>,
  ) {
    this.db = db;
    this.add = add;
    this.disable = disable;
  }
  async initialize(): Promise<void> {
    const db = this.db;
    await db.exec(
      'CREATE TABLE IF NOT EXISTS account_preparations(generation TEXT PRIMARY KEY,subjects TEXT NOT NULL,created BIGINT NOT NULL)',
    );
  }
  async upsert(subjects: SubjectInput[], syncAccount = false): Promise<void> {
    const inherit =
      (
        await this.db
          .prepare("SELECT value FROM settings WHERE key='recording.default'")
          .get<{ value: string }>()
      )?.value === 'true';
    const existing = inherit
      ? new Map(
          (
            await this.db
              .prepare(
                'SELECT s.id,a.following FROM subjects s LEFT JOIN account_subjects a ON a.subject=s.id',
              )
              .all<{ id: string; following: number | null }>()
          ).map((row) => [row.id, row.following]),
        )
      : null;
    // Discard old archived choices; re-following inherits the current default.
    if (syncAccount)
      await this.db.exec(
        'UPDATE subjects SET auto_record=0 WHERE auto_record=1 AND id IN(SELECT subject FROM account_subjects WHERE following=0)',
      );
    for (const subject of subjects) {
      await this.add(subject, syncAccount);
      // Existing per-model choices survive ordinary sync and online transitions.
      if (
        existing &&
        monitored(subject) &&
        (!existing.has(subject.id) || (syncAccount && existing.get(subject.id) === 0))
      )
        await this.db
          .prepare('UPDATE subjects SET auto_record=1,monitor=1 WHERE id=?')
          .run(subject.id);
    }
    if (!syncAccount) return;
    // Subjects without prior membership also belong to the partition. Update only
    // changed rows so an unchanged roster creates no portable membership writes.
    const changed = await this.db
      .prepare(
        `WITH desired AS (
        SELECT s.id,CASE WHEN present.id IS NULL THEN 0 ELSE 1 END AS following
        FROM subjects s LEFT JOIN json_array_elements_text(?::json) AS present(id) ON present.id=s.id)
        INSERT INTO account_subjects(subject,following)
        SELECT d.id,d.following FROM desired d LEFT JOIN account_subjects a ON a.subject=d.id
        WHERE a.following IS DISTINCT FROM d.following
        ON CONFLICT(subject) DO UPDATE SET following=excluded.following
        RETURNING subject,following`,
      )
      .all<{ subject: string; following: number }>(
        JSON.stringify([...new Set(subjects.filter(monitored).map((s) => s.id))]),
      );
    const followed = changed.filter((member) => member.following === 1);
    const archiveEvidence = subjects.filter((row) => row.accountArchiveReason !== undefined);
    const clearedRegions = subjects
      .filter((row) => row.accountRegionCleared)
      .map((row) => archiveRestrictionPrefix + row.id);
    if (clearedRegions.length)
      await this.db
        .prepare(
          `DELETE FROM settings WHERE value='region_restricted'
           AND key IN(SELECT value FROM json_array_elements_text(?::json))`,
        )
        .run(JSON.stringify(clearedRegions));
    const clearedKeys = [
      ...followed.flatMap(({ subject }) => [
        unfollowedPrefix + subject,
        archiveRestrictionPrefix + subject,
        blockedUnfollowPrefix + subject,
        verifiedUnfollowPrefix + subject,
      ]),
      ...archiveEvidence
        .filter((row) => row.accountArchiveReason !== 'unfollowed')
        .flatMap((row) => [unfollowedPrefix + row.id, verifiedUnfollowPrefix + row.id]),
      ...subjects
        .filter((row) => row.accountArchivePending && !row.accountArchiveReason)
        .flatMap((row) => [unfollowedPrefix + row.id, verifiedUnfollowPrefix + row.id]),
      ...archiveEvidence
        .filter((row) => row.accountArchiveReason !== 'account_disabled')
        .map((row) => blockedUnfollowPrefix + row.id),
    ];
    if (clearedKeys.length)
      await this.db
        .prepare(
          `DELETE FROM settings WHERE value!='region_restricted'
           AND key IN(SELECT value FROM json_array_elements_text(?::json))`,
        )
        .run(JSON.stringify(clearedKeys));
    const unfollowed = archiveEvidence
      .filter((row) => row.accountUnfollowConfirmed)
      .map((row) => row.id);
    if (unfollowed.length)
      await this.db
        .prepare(
          `DELETE FROM settings WHERE value='account_disabled'
           AND key IN(SELECT value FROM json_array_elements_text(?::json))`,
        )
        .run(JSON.stringify(unfollowed.map((id) => archiveRestrictionPrefix + id)));
    if (archiveEvidence.length)
      await this.db
        .prepare(
          `INSERT INTO settings(key,value)
           SELECT DISTINCT ON (e.key) e.key,e.value
           FROM json_to_recordset(?::json) AS e(key text,value text)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value
           WHERE settings.value!='region_restricted' AND settings.value IS DISTINCT FROM excluded.value`,
        )
        .run(
          JSON.stringify(
            archiveEvidence.map(({ id, accountArchiveReason }) =>
              accountArchiveReason === 'unfollowed'
                ? { key: unfollowedPrefix + id, value: '1' }
                : { key: archiveRestrictionPrefix + id, value: accountArchiveReason },
            ),
          ),
        );
    await stageEmptySubjectCleanups(this.db, unfollowed, 'unfollowed');
    await stageEmptySubjectCleanups(
      this.db,
      archiveEvidence.filter((row) => row.accountBlockedConfirmed).map((row) => row.id),
      'account_disabled',
    );
    for (const member of changed) if (member.following === 0) await this.disable(member.subject);
  }
  async prepare(
    subjects: SubjectInput[],
    generation: string,
    resetUnfollows = false,
  ): Promise<void> {
    if ((await this.current()) === generation) return;
    // The account owner finishes accepted activation before preparing another.
    // Retire at most one orphan from a crash before private acceptance.
    await this.db
      .prepare(
        'DELETE FROM account_preparations WHERE generation IN(SELECT generation FROM account_preparations WHERE generation!=? ORDER BY created LIMIT 1)',
      )
      .run(generation);
    // Structural TypeScript types do not strip runtime extras at a persistence boundary.
    const json = JSON.stringify(
      subjects.map(
        ({
          id,
          providerId,
          handle,
          previewSourceUrl,
          avatarSourceUrl,
          subjectProfilePending,
          accountArchiveReason,
          accountArchivePending,
          accountBlockedConfirmed,
          accountUnfollowConfirmed,
          accountRegionCleared,
        }) => ({
          id,
          providerId,
          handle,
          previewSourceUrl,
          avatarSourceUrl,
          subjectProfilePending,
          accountArchiveReason,
          accountArchivePending,
          accountBlockedConfirmed,
          accountUnfollowConfirmed,
          accountRegionCleared,
        }),
      ),
    );
    const previous = await this.db
      .prepare('SELECT subjects FROM account_preparations WHERE generation=?')
      .get<{
        subjects: string;
      }>(generation);
    if (previous && previous.subjects !== json) throw Error('ACCOUNT_ACTIVATION_CONFLICT');
    const reset = await this.db
      .prepare('SELECT value FROM settings WHERE key=?')
      .get<{ value: string }>(resetUnfollowsKey);
    if (previous && (reset?.value === generation) !== resetUnfollows)
      throw Error('ACCOUNT_ACTIVATION_CONFLICT');
    if (resetUnfollows)
      await this.db
        .prepare(
          'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        )
        .run(resetUnfollowsKey, generation);
    else await this.db.prepare('DELETE FROM settings WHERE key=?').run(resetUnfollowsKey);
    await this.db
      .prepare('INSERT INTO account_preparations VALUES(?,?,?) ON CONFLICT(generation) DO NOTHING')
      .run(generation, json, Date.now());
  }
  async activate(generation: string): Promise<void> {
    if ((await this.current()) === generation) return;
    const prepared = await this.db
      .prepare('SELECT subjects FROM account_preparations WHERE generation=?')
      .get<{
        subjects: string;
      }>(generation);
    if (!prepared) throw Error('ACCOUNT_ACTIVATION_MISSING');
    const reset = await this.db
      .prepare('SELECT 1 FROM settings WHERE key=? AND value=?')
      .get(resetUnfollowsKey, generation);
    const subjects = JSON.parse(prepared.subjects) as SubjectInput[];
    if (reset)
      await this.db
        .prepare('DELETE FROM settings WHERE key LIKE ? OR key LIKE ? OR key LIKE ?')
        .run(unfollowedPrefix + '%', blockedUnfollowPrefix + '%', verifiedUnfollowPrefix + '%');
    await this.upsert(subjects, true);
    await this.db
      .prepare(
        "INSERT INTO settings VALUES('account.activation-generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(generation);
    await this.discard(generation);
  }
  async current(): Promise<string | null> {
    return (
      (
        await this.db
          .prepare("SELECT value FROM settings WHERE key='account.activation-generation'")
          .get<{
            value: string;
          }>()
      )?.value ?? null
    );
  }
  async addIndexed(indexedIds: readonly number[], generation: string): Promise<number> {
    // Index membership is positive evidence. Existing archive and policy decisions
    // remain owned by full reconciliation, including when an archived ID reappears.
    const result = await this.db
      .prepare(
        `WITH added AS (
           INSERT INTO subjects(id,provider_id,handle,auto_record)
           SELECT p.id,p.provider_id,'主播 #'||p.provider_id,
             CASE WHEN EXISTS(SELECT 1 FROM settings WHERE key='recording.default' AND value='true')
             THEN 1 ELSE 0 END
           FROM (
             SELECT 'stripchat:'||id AS id,id::bigint AS provider_id
             FROM json_array_elements_text(?::json) AS indexed(id)
           ) AS p
           WHERE EXISTS(SELECT 1 FROM settings WHERE key='account.activation-generation' AND value=?)
             AND NOT EXISTS(SELECT 1 FROM account_subjects a WHERE a.subject=p.id)
           ON CONFLICT(id) DO NOTHING RETURNING id
         )
         INSERT INTO account_subjects(subject,following) SELECT id,1 FROM added`,
      )
      .run(JSON.stringify(indexedIds), generation);
    return result.changes;
  }
  async manualUnfollowState(id: string): Promise<ManualUnfollowState> {
    const row = await this.db
      .prepare(
        `SELECT a.following,r.value AS restriction,u.value AS unfollowed
         FROM subjects s LEFT JOIN account_subjects a ON a.subject=s.id
         LEFT JOIN settings r ON r.key=?||s.id
         LEFT JOIN settings u ON u.key=?||s.id WHERE s.id=?`,
      )
      .get<{ following: number | null; restriction: string | null; unfollowed: string | null }>(
        archiveRestrictionPrefix,
        unfollowedPrefix,
        id,
      );
    if (!row) return 'missing';
    if (row.restriction && row.restriction !== 'account_disabled') return 'stale';
    if (row.following === 1 || (row.following === 0 && row.restriction === 'account_disabled'))
      return 'ready';
    return row.following === 0 && row.unfollowed === '1' ? 'retained' : 'stale';
  }
  async confirmManualUnfollow(id: string): Promise<ManualUnfollowState> {
    const state = await this.manualUnfollowState(id);
    if (state !== 'ready') return state;
    const result = await this.db
      .prepare('UPDATE account_subjects SET following=0 WHERE subject=? AND following=1')
      .run(id);
    if (result.changes) await this.disable(id);
    return 'ready';
  }
  async followed(includeUnassigned?: true): Promise<SubjectInput[]> {
    return (
      await this.db
        .prepare(
          `SELECT s.id,s.provider_id AS "providerId",s.handle,ar.value AS "accountArchiveReason",
           avatar.value AS "avatarSourceUrl",image.preview AS "previewSourceUrl"
         FROM subjects s LEFT JOIN account_subjects a ON s.id=a.subject
         LEFT JOIN settings ar ON ar.key=?||s.id AND ar.value='region_restricted'
         LEFT JOIN settings avatar ON avatar.key='preview.avatar-source.'||s.id
         LEFT JOIN subject_images image ON image.subject=s.id
         WHERE ${includeUnassigned ? 'a.following IS DISTINCT FROM 0' : 'a.following=1'} ORDER BY s.id`,
        )
        .all<AccountProfileRow>(archiveRestrictionPrefix)
    ).map(profileInput);
  }
  async archived(
    afterProviderId: number,
    limit: number,
    matchingProviderIds?: readonly number[],
  ): Promise<SubjectInput[]> {
    const rows = await this.db
      .prepare(
        `SELECT s.id,s.provider_id AS "providerId",s.handle,
           COALESCE(ar.value,CASE WHEN uf.value='1' THEN 'unfollowed' END) AS "accountArchiveReason",
           avatar.value AS "avatarSourceUrl",image.preview AS "previewSourceUrl"
         FROM account_subjects a JOIN subjects s ON s.id=a.subject
         LEFT JOIN settings uf ON uf.key=?||s.id
         LEFT JOIN settings ar ON ar.key=?||s.id
         LEFT JOIN settings avatar ON avatar.key='preview.avatar-source.'||s.id
         LEFT JOIN subject_images image ON image.subject=s.id
         WHERE a.following=0 AND ${
           matchingProviderIds
             ? 's.provider_id IN (SELECT value::bigint FROM json_array_elements_text(?::json))'
             : 's.provider_id>?'
         }
         ORDER BY s.provider_id LIMIT ?`,
      )
      .all<AccountProfileRow>(
        unfollowedPrefix,
        archiveRestrictionPrefix,
        matchingProviderIds ? JSON.stringify(matchingProviderIds) : afterProviderId,
        matchingProviderIds?.length ?? limit,
      );
    return rows.map(profileInput);
  }
  async discard(generation: string): Promise<void> {
    await this.db
      .prepare('DELETE FROM settings WHERE key=? AND value=?')
      .run(resetUnfollowsKey, generation);
    await this.db.prepare('DELETE FROM account_preparations WHERE generation=?').run(generation);
  }
  async recordRestriction(
    id: string,
    generation: string,
    reason: Exclude<ArchiveReason, 'unfollowed'>,
  ): Promise<boolean> {
    if ((await this.current()) !== generation) return false;
    const result = await this.db
      .prepare(
        `INSERT INTO settings(key,value)
         SELECT ?,? FROM account_subjects a
         WHERE a.subject=? AND a.following=0
         AND (?='region_restricted' OR NOT EXISTS(SELECT 1 FROM settings k WHERE k.key=? AND k.value='1'))
         ON CONFLICT(key) DO UPDATE SET value=excluded.value
         WHERE settings.value!='region_restricted' AND settings.value IS DISTINCT FROM excluded.value`,
      )
      .run(archiveRestrictionPrefix + id, reason, id, reason, unfollowedPrefix + id);
    if (reason === 'region_restricted') {
      const revoked = await this.db
        .prepare(
          `DELETE FROM settings WHERE key IN(?,?,?) AND EXISTS(
             SELECT 1 FROM account_subjects a JOIN settings r ON r.key=? AND r.value='region_restricted'
             WHERE a.subject=? AND a.following=0
           )`,
        )
        .run(
          unfollowedPrefix + id,
          verifiedUnfollowPrefix + id,
          blockedUnfollowPrefix + id,
          archiveRestrictionPrefix + id,
          id,
        );
      return result.changes > 0 || revoked.changes > 0;
    }
    if (result.changes && reason !== 'account_disabled')
      await this.db.prepare('DELETE FROM settings WHERE key=?').run(blockedUnfollowPrefix + id);
    return result.changes > 0;
  }
}
