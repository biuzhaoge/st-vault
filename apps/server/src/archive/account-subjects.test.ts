import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';
import { SqlDatabase } from '../database/sql.js';
import { libraryIndexPath } from '../library/paths.js';

it('commits account archive evidence with the roster and distinguishes restrictions from unfollows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-archive-evidence-'));
  const archive = await openArchive({ root });
  const region = { id: 'stripchat:11', providerId: 11, handle: 'regional' };
  const unfollow = { id: 'stripchat:12', providerId: 12, handle: 'unfollowed' };
  const generation = randomUUID();
  try {
    await archive.upsertSubjects([region, unfollow], { syncAccount: true });
    await archive.prepareAccountSubjects(
      [
        { ...region, accountArchiveReason: 'region_restricted' },
        { ...unfollow, accountArchiveReason: 'unfollowed' },
      ],
      generation,
    );
    await archive.activateAccountSubjects(generation);
    await archive.setSetting(`archive.unfollowed.${region.id}`, '1');
    expect(await archive.getSubject(region.id)).toMatchObject({
      archived: false,
      archiveReason: 'region_restricted',
      autoRecord: false,
    });
    expect(await archive.recordVerifiedUnfollowed(region.id, generation)).toBe('stale');
    expect(await archive.getSubject(unfollow.id)).toMatchObject({
      archived: true,
      archiveReason: 'unfollowed',
    });
    expect(
      (await archive.listSubjects({ includeCleanup: true })).find((row) => row.id === unfollow.id),
    ).toMatchObject({
      archived: true,
      archiveReason: 'unfollowed',
    });
    expect(await archive.followedAccountSubjects()).toEqual([
      { ...region, accountArchiveReason: 'region_restricted' },
    ]);
    expect(await archive.archivedAccountSubjects(0, 10)).toMatchObject([
      { ...unfollow, accountArchiveReason: 'unfollowed' },
    ]);
    expect(
      await archive.archivedAccountSubjects(0, 1, [region.providerId, unfollow.providerId]),
    ).toHaveLength(1);
    await archive.upsertSubjects([region, { ...unfollow, accountArchivePending: true }], {
      syncAccount: true,
    });
    expect(await archive.getSubject(region.id)).toMatchObject({ archived: false });
    expect((await archive.getSubject(region.id))?.archiveReason).toBe('region_restricted');
    expect(await archive.getSubject(unfollow.id)).toMatchObject({ archived: true });
    expect((await archive.getSubject(unfollow.id))?.archiveReason).toBeUndefined();
    await archive.upsertSubjects(
      [{ ...region, accountArchiveReason: 'region_restricted', accountArchivePending: true }],
      { syncAccount: true },
    );
    expect(await archive.getSubject(region.id)).toMatchObject({
      archived: true,
      archiveReason: 'region_restricted',
    });
    expect(await archive.recordVerifiedUnfollowed(region.id, generation)).toBe('stale');
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('retains known names on incomplete profiles and leaves temporary ID labels out of name history', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-unresolved-profile-'));
  const archive = await openArchive({ root });
  const stub = {
    id: 'stripchat:7',
    providerId: 7,
    handle: '主播 #7',
    subjectProfilePending: true as const,
  };
  const named = { id: stub.id, providerId: stub.providerId, handle: 'confirmed' };
  try {
    await archive.upsertSubjects([stub], { syncAccount: true });
    await archive.upsertSubjects([named], { syncAccount: true });
    await archive.upsertSubjects([stub], { syncAccount: true });
    expect(await archive.getSubject(named.id)).toMatchObject({
      handle: named.handle,
      formerNames: [],
    });
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('revokes prior cleanup evidence when a new account activation replaces it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-owner-reset-'));
  const archive = await openArchive({ root });
  const old = { id: 'stripchat:12', providerId: 12, handle: 'former' };
  const next = { id: 'stripchat:13', providerId: 13, handle: 'current' };
  const region = { id: 'stripchat:14', providerId: 14, handle: 'former-region' };
  const original = randomUUID();
  const changed = randomUUID();
  try {
    await archive.prepareAccountSubjects(
      [
        { ...old, accountArchiveReason: 'unfollowed', accountUnfollowConfirmed: true },
        { ...region, accountArchiveReason: 'region_restricted' },
      ],
      original,
    );
    await archive.activateAccountSubjects(original);
    expect(await archive.getSubject(old.id)).toBeNull();
    expect(await archive.acceptedSubjectCleanupIds(0, 8)).toEqual([
      { id: old.id, providerId: old.providerId },
    ]);
    await archive.prepareAccountSubjects([next], changed, true);
    expect(await archive.archivedAccountSubjects(0, 10)).toEqual([
      { ...old, accountArchiveReason: 'unfollowed' },
    ]);
    await archive.activateAccountSubjects(changed);
    expect(await archive.acceptedSubjectCleanupIds(0, 8)).toEqual([]);
    expect(await archive.recordVerifiedUnfollowed(old.id, original)).toBe('stale');
    expect(await archive.getSubject(old.id)).toMatchObject({ archived: true });
    expect((await archive.getSubject(old.id))?.archiveReason).toBeUndefined();
    expect(await archive.getSubject(region.id)).toMatchObject({ archived: true });
    expect((await archive.getSubject(region.id))?.archiveReason).toBe('region_restricted');
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('replaces stale disabled evidence with a confirmed unfollow and preserves region restrictions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-restriction-unfollow-'));
  const archive = await openArchive({ root });
  const region = { id: 'stripchat:1', providerId: 1, handle: 'regional' };
  const blocked = { id: 'stripchat:2', providerId: 2, handle: 'blocked' };
  const generation = randomUUID();
  try {
    await archive.upsertSubjects(
      [
        { ...region, accountArchiveReason: 'region_restricted' },
        { ...blocked, accountArchiveReason: 'account_disabled' },
      ],
      { syncAccount: true },
    );
    await archive.upsertSubjects([{ ...blocked, accountArchiveReason: 'unfollowed' }], {
      syncAccount: true,
    });
    expect((await archive.getSubject(blocked.id))?.archiveReason).toBe('account_disabled');
    await archive.prepareAccountSubjects(
      [
        { ...region, accountArchiveReason: 'unfollowed', accountUnfollowConfirmed: true },
        { ...blocked, accountArchiveReason: 'unfollowed', accountUnfollowConfirmed: true },
      ],
      generation,
    );
    await archive.activateAccountSubjects(generation);
    expect(await archive.listSubjects()).toMatchObject([
      { id: region.id, archived: true, archiveReason: 'region_restricted' },
    ]);
    expect(await archive.archivedAccountSubjects(0, 10)).toEqual([
      { ...region, accountArchiveReason: 'region_restricted' },
      { ...blocked, accountArchiveReason: 'unfollowed' },
    ]);
    expect(await archive.recordVerifiedUnfollowed(region.id, generation)).toBe('stale');
    expect(await archive.resumeAcceptedSubjectCleanup(region.id, generation)).toBe('stale');
    expect(await archive.acceptedSubjectCleanupIds(0, 10)).toEqual([
      { id: blocked.id, providerId: blocked.providerId },
    ]);
    expect(await archive.recordVerifiedUnfollowed(blocked.id, generation)).toBe('purged');
    await archive.upsertSubjects(
      [{ ...region, accountArchiveReason: 'account_disabled', accountBlockedConfirmed: true }],
      { syncAccount: true },
    );
    expect((await archive.getSubject(region.id))?.archiveReason).toBe('region_restricted');
    expect(await archive.recordArchiveRestriction(region.id, generation, 'account_deleted')).toBe(
      false,
    );
    expect(
      await archive.recordVerifiedBlocked(region.id, generation, () => Promise.resolve()),
    ).toBe('stale');
    const lifted = randomUUID();
    await archive.prepareAccountSubjects(
      [
        {
          ...region,
          accountArchiveReason: 'unfollowed',
          accountUnfollowConfirmed: true,
          accountRegionCleared: true,
        },
      ],
      lifted,
    );
    await archive.activateAccountSubjects(lifted);
    expect(await archive.acceptedSubjectCleanupIds(0, 10)).toEqual([
      { id: region.id, providerId: region.providerId },
    ]);
    expect(await archive.resumeAcceptedSubjectCleanup(region.id, lifted)).toBe('purged');
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('updates a verified restriction only within its active roster and keeps confirmed unfollows', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-restriction-refresh-'));
  const archive = await openArchive({ root });
  const blocked = { id: 'stripchat:21', providerId: 21, handle: 'hidden' };
  const unfollow = { id: 'stripchat:22', providerId: 22, handle: 'unfollowed' };
  const generation = randomUUID();
  try {
    await archive.prepareAccountSubjects(
      [
        { ...blocked, accountArchiveReason: 'account_disabled' },
        { ...unfollow, accountArchiveReason: 'unfollowed' },
      ],
      generation,
    );
    await archive.activateAccountSubjects(generation);
    expect(
      await archive.recordArchiveRestriction(blocked.id, randomUUID(), 'account_deleted'),
    ).toBe(false);
    expect(
      await archive.recordArchiveRestriction(unfollow.id, generation, 'account_disabled'),
    ).toBe(false);
    expect((await archive.getSubject(blocked.id))?.archiveReason).toBe('account_disabled');
    expect(await archive.recordArchiveRestriction(blocked.id, generation, 'account_deleted')).toBe(
      true,
    );
    expect(await archive.recordArchiveRestriction(blocked.id, generation, 'account_deleted')).toBe(
      false,
    );
    expect((await archive.getSubject(blocked.id))?.archiveReason).toBe('account_deleted');
    expect(await archive.recordVerifiedUnfollowed(blocked.id, generation)).toBe('stale');
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('reads the committed followed roster with canonical handles and no local or archived entries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-roster-'));
  const archive = await openArchive({ root });
  const removed = { id: 'stripchat:1', providerId: 1, handle: 'removed' };
  const followed = { id: 'stripchat:2', providerId: 2, handle: 'renamed' };
  const original = { ...followed, handle: 'old-name' };
  const renamed = {
    ...followed,
    avatarSourceUrl: 'https://images.invalid/a.jpg',
    previewSourceUrl: 'https://images.invalid/cover.jpg',
  };
  const local = { id: 'stripchat:3', providerId: 3, handle: 'local' };
  const next = { id: 'stripchat:4', providerId: 4, handle: 'next' };
  const generation = randomUUID();
  try {
    await archive.upsertSubjects([removed, original], { syncAccount: true });
    await archive.upsertSubjects([renamed], { syncAccount: true });
    await archive.upsertSubjects([local]);
    await archive.prepareAccountSubjects([next], generation);
    expect(await archive.getSubject(removed.id)).toMatchObject({ archived: true });
    expect(await archive.getSubject(local.id)).toMatchObject({ archived: false });
    expect(await archive.followedAccountSubjects()).toEqual([renamed]);
    expect(await archive.followedAccountSubjects(true)).toEqual([renamed, local]);
    await archive.activateAccountSubjects(generation);
    expect(await archive.followedAccountSubjects()).toEqual([next]);
    expect(await archive.archivedAccountSubjects(0, 3, [followed.providerId])).toEqual([renamed]);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('pages archived recovery candidates in provider ID order without changing the roster', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-archived-account-roster-'));
  const archive = await openArchive({ root });
  const first = { id: 'stripchat:2', providerId: 2, handle: 'first' };
  const followed = { id: 'stripchat:4', providerId: 4, handle: 'followed' };
  const local = { id: 'stripchat:5', providerId: 5, handle: 'local' };
  const unfollowed = { id: 'stripchat:10', providerId: 10, handle: 'canonical' };
  const last = { id: 'stripchat:18', providerId: 18, handle: 'last' };
  const generation = randomUUID();
  try {
    await archive.upsertSubjects([last, { ...unfollowed, handle: 'old-name' }, first, followed], {
      syncAccount: true,
    });
    await archive.commit({
      subjectId: unfollowed.id,
      sourceEpoch: 'recording',
      sourceSequence: '1',
      init: null,
      bytes: Uint8Array.of(1),
      durationSeconds: 2,
      wallStartMs: null,
      timeBasis: 'unknown',
      uncertaintyMs: null,
      discontinuity: false,
    });
    await archive.prepareAccountSubjects([followed], generation);
    await archive.activateAccountSubjects(generation);
    await archive.upsertSubjects([local, unfollowed]);
    expect(await archive.recordVerifiedUnfollowed(unfollowed.id, generation)).toBe('retained');
    const before = await archive.listSubjects({ activity: false });
    expect(before.find(({ id }) => id === unfollowed.id)?.archiveReason).toBe('unfollowed');

    const verifiedUnfollow = { ...unfollowed, accountArchiveReason: 'unfollowed' };
    expect(await archive.archivedAccountSubjects(0, 2)).toEqual([first, verifiedUnfollow]);
    expect(await archive.archivedAccountSubjects(first.providerId, 1)).toEqual([verifiedUnfollow]);
    expect(await archive.archivedAccountSubjects(unfollowed.providerId, 2)).toEqual([last]);
    expect(await archive.archivedAccountSubjects(last.providerId, 2)).toEqual([]);
    await expect(archive.archivedAccountSubjects(-1, 2)).rejects.toThrow(
      'INVALID_ARCHIVED_SUBJECT_QUERY',
    );
    await expect(archive.archivedAccountSubjects(0, 0)).rejects.toThrow(
      'INVALID_ARCHIVED_SUBJECT_QUERY',
    );
    await expect(archive.archivedAccountSubjects(0, 129)).rejects.toThrow(
      'INVALID_ARCHIVED_SUBJECT_QUERY',
    );
    expect(await archive.accountActivation()).toBe(generation);
    expect(await archive.listSubjects({ activity: false })).toEqual(before);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('leaves unchanged membership rows untouched and inherits recording policy only on re-follow', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-diff-'));
  const archive = await openArchive({ root });
  const db = await SqlDatabase.open(libraryIndexPath(root));
  const alice = { id: 'stripchat:1', providerId: 1, handle: 'one' };
  const bob = { id: 'stripchat:2', providerId: 2, handle: 'two' };
  const versions = () =>
    db.prepare('SELECT subject,xmin::text AS version FROM account_subjects ORDER BY subject').all();
  const activate = async (members: (typeof alice)[]) => {
    const generation = randomUUID();
    await archive.prepareAccountSubjects(members, generation);
    await archive.activateAccountSubjects(generation);
  };
  try {
    await archive.setGlobalRecording(true);
    await activate([alice, bob]);
    await archive.setPolicy(alice.id, { autoRecord: false });
    const before = await versions();
    await activate([bob, alice, alice]);
    expect(await versions()).toEqual(before);
    expect(await archive.getSubject(alice.id)).toMatchObject({
      archived: false,
      autoRecord: false,
    });
    await activate([bob]);
    expect((await versions())[1]).toEqual(before[1]);
    expect(await archive.getSubject(alice.id)).toMatchObject({ archived: true, autoRecord: false });
    await activate([alice, bob]);
    expect((await versions())[1]).toEqual(before[1]);
    expect(await archive.getSubject(alice.id)).toMatchObject({ archived: false, autoRecord: true });
  } finally {
    await db.close();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('stages a public list without changing membership and activates it idempotently after reopening', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-stage-'));
  let archive = await openArchive({ root });
  const old = { id: 'stripchat:1', providerId: 1, handle: 'old' },
    next = { id: 'stripchat:2', providerId: 2, handle: 'next' };
  const generation = randomUUID();
  try {
    await archive.upsertSubjects([old], { syncAccount: true });
    const extra = { ...next, cookiesText: 'sensitive-extra-field-must-not-enter-media' };
    await archive.prepareAccountSubjects([extra], generation);
    for (const file of await readdir(path.join(root, 'media', 'postgres-journal')))
      expect(
        (await readFile(path.join(root, 'media', 'postgres-journal', file))).includes(
          Buffer.from(extra.cookiesText),
        ),
      ).toBe(false);
    expect(await archive.getSubject(old.id)).toMatchObject({ archived: false });
    expect(await archive.getSubject(next.id)).toBeNull();
    await archive.close();
    archive = await openArchive({
      root: path.join(root, 'restored'),
      mediaRoot: path.join(root, 'media'),
    });
    await archive.activateAccountSubjects(generation);
    expect(await archive.accountActivation()).toBe(generation);
    expect(await archive.getSubject(old.id)).toMatchObject({ archived: true });
    expect(await archive.getSubject(next.id)).toMatchObject({ archived: false });
    await archive.activateAccountSubjects(generation);
    expect(await archive.accountActivation()).toBe(generation);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('publishes only new indexed members under the active generation and preserves the addition on reopen', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-index-'));
  let archive = await openArchive({ root });
  const generation = randomUUID();
  const followed = { id: 'stripchat:1', providerId: 1, handle: 'known' };
  const archived = { id: 'stripchat:2', providerId: 2, handle: 'regional' };
  const fresh = {
    id: 'stripchat:3',
    providerId: 3,
    handle: '主播 #3',
    subjectProfilePending: true as const,
  };
  const candidates = [followed.providerId, archived.providerId, fresh.providerId, fresh.providerId];
  try {
    expect(await archive.addIndexedAccountSubjects(candidates, generation)).toBe(0);
    expect(await archive.getSubject(fresh.id)).toBeNull();
    await archive.setGlobalRecording(true);
    await archive.prepareAccountSubjects(
      [
        followed,
        { ...archived, accountArchiveReason: 'region_restricted', accountArchivePending: true },
      ],
      generation,
    );
    await archive.activateAccountSubjects(generation);
    await archive.setPolicy(followed.id, { autoRecord: false });
    const existing = await archive.listSubjects({ activity: false });
    expect(await archive.addIndexedAccountSubjects(candidates, randomUUID())).toBe(0);
    const controller = new AbortController();
    const cancellation = Error('aborted before enqueue');
    controller.abort(cancellation);
    await expect(
      archive.addIndexedAccountSubjects(candidates, generation, controller.signal),
    ).rejects.toBe(cancellation);
    expect(await archive.addIndexedAccountSubjects(candidates, generation)).toBe(1);
    expect(await archive.addIndexedAccountSubjects(candidates, generation)).toBe(0);
    expect(await archive.accountActivation()).toBe(generation);
    expect(
      (await archive.listSubjects({ activity: false })).filter(({ id }) => id !== fresh.id),
    ).toEqual(existing);
    expect(await archive.followedAccountSubjects()).toEqual([followed, fresh]);
    expect(await archive.getSubject(fresh.id)).toMatchObject({
      handle: fresh.handle,
      archived: false,
      monitorEnabled: true,
      autoRecord: true,
    });
    await archive.close();
    archive = await openArchive({
      root: path.join(root, 'restored'),
      mediaRoot: path.join(root, 'media'),
    });
    expect(await archive.accountActivation()).toBe(generation);
    expect(await archive.followedAccountSubjects()).toEqual([followed, fresh]);
    const nextGeneration = randomUUID();
    const named = { id: fresh.id, providerId: fresh.providerId, handle: 'hydrated' };
    await archive.prepareAccountSubjects([followed, named], nextGeneration);
    await archive.activateAccountSubjects(nextGeneration);
    expect(await archive.getSubject(fresh.id)).toMatchObject({
      handle: named.handle,
      formerNames: [],
      autoRecord: true,
    });
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('discards an unaccepted preparation without changing the active list', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-discard-'));
  const archive = await openArchive({ root }),
    generation = randomUUID();
  try {
    await archive.prepareAccountSubjects(
      [{ id: 'stripchat:2', providerId: 2, handle: 'unused' }],
      generation,
    );
    await archive.discardAccountPreparation(generation);
    await expect(archive.activateAccountSubjects(generation)).rejects.toThrow(
      'ACCOUNT_ACTIVATION_MISSING',
    );
    expect(await archive.listSubjects()).toEqual([]);
    expect(await archive.accountActivation()).toBeNull();
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('activates and refreshes avatar sources through the real metadata worker', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-avatar-'));
  let archive = await openArchive({ root });
  const subject = { id: 'stripchat:7', providerId: 7, handle: 'with-avatar' };
  const key = `preview.avatar-source.${subject.id}`;
  try {
    for (const source of [
      'https://images.invalid/avatar-v1.jpg',
      'https://images.invalid/avatar-v2.jpg',
      'https://images.invalid/avatar-v2.jpg',
    ]) {
      const generation = randomUUID();
      await archive.prepareAccountSubjects([{ ...subject, avatarSourceUrl: source }], generation);
      await archive.activateAccountSubjects(generation);
      expect(await archive.accountActivation()).toBe(generation);
      expect(await archive.getSetting(key)).toBe(source);
      expect(await archive.getSubject(subject.id)).toMatchObject({ archived: false });
    }
    await archive.close();
    archive = await openArchive({ root });
    expect(await archive.getSetting(key)).toBe('https://images.invalid/avatar-v2.jpg');
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
