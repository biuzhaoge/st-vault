import { lstat, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { SubjectInput } from '../ports.js';
import * as libraryImages from '../library/images.js';
import { subjectImagePath } from '../library/paths.js';
import { openArchive, type ArchiveHandle } from './index.js';

const subject = (providerId: number) => ({
  id: `stripchat:${providerId}`,
  providerId,
  handle: `fixture${providerId}`,
});

it('waits for an in-flight recording before deciding whether a blocked subject may be unfollowed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-blocked-commit-race-'));
  let entered!: () => void;
  let release!: () => void;
  const staged = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const archive = await openArchive({
    root,
    fault: async (point) => {
      if (point === 'before-journal-write') {
        entered();
        await gate;
      }
    },
  });
  const blocked = subject(42);
  try {
    const generation = await activate(archive, [
      { ...blocked, accountArchiveReason: 'account_disabled' },
    ]);
    const writing = archive.commit({
      subjectId: blocked.id,
      sourceEpoch: 'fixture',
      sourceSequence: '1',
      init: null,
      bytes: Uint8Array.of(1),
      durationSeconds: 2,
      wallStartMs: null,
      timeBasis: 'unknown',
      uncertaintyMs: null,
      discontinuity: false,
    });
    await staged;
    const removeFavorite = vi.fn(() => Promise.resolve());
    const cleanup = archive.recordVerifiedBlocked(blocked.id, generation, removeFavorite);
    release();
    const recording = await writing;
    expect(await cleanup).toBe('retained');
    expect(removeFavorite).not.toHaveBeenCalled();
    expect(await archive.hasMedia([recording.mediaObjectId])).toBe(true);
  } finally {
    release();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('reuses the successful upstream result after image cleanup fails', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-blocked-image-retry-'));
  const mediaRoot = path.join(root, 'media');
  const archive = await openArchive({ root, mediaRoot });
  const blocked = subject(42);
  const filenames = (['avatar', 'cover', 'default-cover'] as const).map((kind) =>
    subjectImagePath(mediaRoot, blocked.id, kind),
  );
  const subjectDirectory = path.dirname(filenames[0]);
  const outside = path.join(root, 'outside');
  const outsideFile = path.join(outside, path.basename(filenames[0]));
  try {
    const generation = await activate(archive, [
      { ...blocked, accountArchiveReason: 'account_disabled', accountBlockedConfirmed: true },
    ]);
    await mkdir(outside);
    await writeFile(outsideFile, Uint8Array.of(1));
    await mkdir(path.dirname(subjectDirectory), { recursive: true });
    await symlink(outside, subjectDirectory, 'dir');
    const removeFavorite = vi.fn(() => Promise.resolve());
    expect(await archive.resumeAcceptedSubjectCleanup(blocked.id, generation)).toBe('stale');
    await expect(
      archive.recordVerifiedBlocked(blocked.id, generation, removeFavorite),
    ).rejects.toThrow();
    expect(removeFavorite).toHaveBeenCalledTimes(1);
    expect(await lstat(outsideFile)).toMatchObject({ size: 1 });
    expect(await archive.listSubjects({ includeCleanup: true })).toHaveLength(1);
    await unlink(subjectDirectory);
    await mkdir(subjectDirectory);
    for (const filename of filenames) await writeFile(filename, Uint8Array.of(1));
    expect(await archive.resumeAcceptedSubjectCleanup(blocked.id, generation)).toBe('purged');
    expect(removeFavorite).toHaveBeenCalledTimes(1);
    for (const filename of filenames)
      await expect(lstat(filename)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await archive.listSubjects({ includeCleanup: true })).toEqual([]);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rechecks the account after waiting for a subject image writer', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cleanup-image-roster-race-'));
  const mediaRoot = path.join(root, 'media');
  const archive = await openArchive({ root, mediaRoot });
  const images = new libraryImages.LibraryImages(mediaRoot, 'avatar');
  const entry = subject(42);
  const key = `avatar:${entry.id}`;
  const bytes = Uint8Array.of(1, 2, 3);
  let signalWriter!: () => void;
  let releaseWriter!: () => void;
  let signalCleanup!: () => void;
  const writerHoldingImages = new Promise<void>((resolve) => {
    signalWriter = resolve;
  });
  const releaseImages = new Promise<void>((resolve) => {
    releaseWriter = resolve;
  });
  const cleanupQueued = new Promise<void>((resolve) => {
    signalCleanup = resolve;
  });
  const remove = libraryImages.removeSubjectLibraryImages;
  const spy = vi
    .spyOn(libraryImages, 'removeSubjectLibraryImages')
    .mockImplementation((...args) => {
      const queued = remove(...args);
      signalCleanup();
      return queued;
    });
  try {
    const generation = await activate(archive, [
      { ...entry, accountArchiveReason: 'unfollowed', accountUnfollowConfirmed: true },
    ]);
    const writing = images.put(key, bytes, async () => {
      signalWriter();
      await releaseImages;
      return true;
    });
    await writerHoldingImages;
    const cleanup = archive.resumeAcceptedSubjectCleanup(entry.id, generation);
    await cleanupQueued;
    await activate(archive, [entry]);
    releaseWriter();
    expect(await writing).toBe(true);
    expect(await cleanup).toBe('stale');
    expect(await archive.getSubject(entry.id)).toMatchObject({ archived: false });
    expect(await images.get(key)).toEqual(Buffer.from(bytes));
  } finally {
    releaseWriter();
    spy.mockRestore();
    await images.close();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('resumes only fresh unfollows after image failure and revokes receipts on positive follow', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unfollow-image-retry-'));
  const mediaRoot = path.join(root, 'media');
  const archive = await openArchive({ root, mediaRoot });
  const legacy = subject(41);
  const staged = subject(42);
  const direct = subject(43);
  const protectedRegion = subject(44);
  const filename = subjectImagePath(mediaRoot, direct.id, 'avatar');
  const subjectDirectory = path.dirname(filename);
  const outside = path.join(root, 'outside');
  const outsideFile = path.join(outside, path.basename(filename));
  try {
    await activate(archive, [legacy, staged, direct, protectedRegion]);
    const at = Date.now() - 300000;
    for (let step = 0; step < 257; step++)
      await archive.setObservation(
        direct.id,
        step % 2 === 0 ? 'OFFLINE' : 'PUBLIC',
        at + step * 1000,
      );
    const generation = await activate(archive, [
      { ...legacy, accountArchiveReason: 'unfollowed' },
      { ...staged, accountArchiveReason: 'unfollowed', accountUnfollowConfirmed: true },
      { ...protectedRegion, accountArchiveReason: 'unfollowed', accountUnfollowConfirmed: true },
    ]);
    expect(await archive.acceptedSubjectCleanupIds(0, 10)).toEqual([
      { id: staged.id, providerId: staged.providerId },
      { id: protectedRegion.id, providerId: protectedRegion.providerId },
    ]);
    expect(await archive.getSubject(legacy.id)).toMatchObject({
      archived: true,
      archiveReason: 'unfollowed',
    });
    expect(await archive.resumeAcceptedSubjectCleanup(legacy.id, generation)).toBe('stale');
    await mkdir(outside);
    await writeFile(outsideFile, Uint8Array.of(1));
    await mkdir(path.dirname(subjectDirectory), { recursive: true });
    await symlink(outside, subjectDirectory, 'dir');
    await expect(archive.recordVerifiedUnfollowed(direct.id, generation)).rejects.toThrow();
    expect(await archive.acceptedSubjectCleanupIds(0, 1)).toEqual([
      { id: staged.id, providerId: staged.providerId },
    ]);
    expect(await archive.acceptedSubjectCleanupIds(staged.providerId, 1)).toEqual([
      { id: direct.id, providerId: direct.providerId },
    ]);
    expect(
      await archive.recordArchiveRestriction(protectedRegion.id, generation, 'region_restricted'),
    ).toBe(true);
    expect(await archive.resumeAcceptedSubjectCleanup(protectedRegion.id, generation)).toBe(
      'stale',
    );
    const refreshed = await activate(archive, [
      staged,
      {
        ...protectedRegion,
        accountArchiveReason: 'region_restricted',
        accountArchivePending: true,
      },
    ]);
    expect(await archive.resumeAcceptedSubjectCleanup(staged.id, refreshed)).toBe('stale');
    expect(await archive.resumeAcceptedSubjectCleanup(protectedRegion.id, refreshed)).toBe('stale');
    expect(await archive.getSubject(protectedRegion.id)).toMatchObject({
      archived: true,
      archiveReason: 'region_restricted',
    });
    expect(await archive.resumeAcceptedSubjectCleanup(direct.id, generation)).toBe('stale');
    await unlink(subjectDirectory);
    expect(await archive.resumeAcceptedSubjectCleanup(direct.id, refreshed)).toBe('retained');
    expect(await archive.acceptedSubjectCleanupIds(0, 10)).toEqual([
      { id: direct.id, providerId: direct.providerId },
    ]);
    let result = await archive.resumeAcceptedSubjectCleanup(direct.id, refreshed);
    for (let step = 0; step < 4 && result === 'retained'; step++)
      result = await archive.resumeAcceptedSubjectCleanup(direct.id, refreshed);
    expect(result).toBe('purged');
    expect(await archive.acceptedSubjectCleanupIds(0, 10)).toEqual([]);
    expect(await lstat(outsideFile)).toMatchObject({ size: 1 });
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);

async function activate(archive: ArchiveHandle, subjects: SubjectInput[]) {
  const generation = randomUUID();
  await archive.prepareAccountSubjects(subjects, generation);
  await archive.activateAccountSubjects(generation);
  return generation;
}

it('applies a manual unfollow only after upstream acceptance and preserves recorded footage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-manual-unfollow-'));
  const archive = await openArchive({ root });
  const empty = subject(41);
  const recorded = subject(42);
  const disabled = subject(43);
  const regional = subject(44);
  const deleted = subject(45);
  const commit = (id: string) =>
    archive.commit({
      subjectId: id,
      sourceEpoch: 'manual-unfollow',
      sourceSequence: '1',
      init: null,
      bytes: Uint8Array.of(1),
      durationSeconds: 2,
      wallStartMs: null,
      timeBasis: 'unknown',
      uncertaintyMs: null,
      discontinuity: false,
    });
  try {
    const previous = await activate(archive, [empty, recorded, disabled]);
    const firstRecording = await commit(recorded.id);
    const secondRecording = await commit(disabled.id);
    const generation = await activate(archive, [
      empty,
      recorded,
      { ...disabled, accountArchiveReason: 'account_disabled' },
      { ...regional, accountArchiveReason: 'region_restricted', accountArchivePending: true },
      { ...deleted, accountArchiveReason: 'account_deleted' },
    ]);
    await archive.setPolicy(recorded.id, { autoRecord: true });
    const removeFavorite = vi.fn(() => Promise.resolve());
    expect(await archive.recordManualUnfollow(empty.id, previous, removeFavorite)).toBe('stale');
    expect(await archive.recordManualUnfollow(regional.id, generation, removeFavorite)).toBe(
      'stale',
    );
    expect(await archive.recordManualUnfollow(deleted.id, generation, removeFavorite)).toBe(
      'stale',
    );
    expect(removeFavorite).not.toHaveBeenCalled();
    await expect(
      archive.recordManualUnfollow(empty.id, generation, () =>
        Promise.reject(new Error('upstream rejected')),
      ),
    ).rejects.toThrow('upstream rejected');
    expect(await archive.getSubject(empty.id)).toMatchObject({ archived: false });
    expect(await archive.recordManualUnfollow(empty.id, generation, removeFavorite)).toBe('purged');
    expect(await archive.recordManualUnfollow(recorded.id, generation, removeFavorite)).toBe(
      'retained',
    );
    expect(await archive.recordManualUnfollow(disabled.id, generation, removeFavorite)).toBe(
      'retained',
    );
    expect(await archive.recordManualUnfollow(recorded.id, generation, removeFavorite)).toBe(
      'retained',
    );
    expect(removeFavorite).toHaveBeenCalledTimes(3);
    expect(await archive.getSubject(empty.id)).toBeNull();
    expect(await archive.getSubject(recorded.id)).toMatchObject({
      archived: true,
      archiveReason: 'unfollowed',
      autoRecord: false,
    });
    expect(await archive.getSubject(disabled.id)).toMatchObject({
      archived: true,
      archiveReason: 'unfollowed',
    });
    expect(
      await archive.hasMedia([firstRecording.mediaObjectId, secondRecording.mediaObjectId]),
    ).toBe(true);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('discards a manual unfollow result when the roster changes while waiting for upstream', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-manual-unfollow-roster-race-'));
  const archive = await openArchive({ root });
  const entry = subject(42);
  let began!: () => void;
  let finish!: () => void;
  const requested = new Promise<void>((resolve) => {
    began = resolve;
  });
  const remote = new Promise<void>((resolve) => {
    finish = resolve;
  });
  try {
    const generation = await activate(archive, [entry]);
    const pending = archive.recordManualUnfollow(entry.id, generation, () => {
      began();
      return remote;
    });
    void pending.catch(began);
    await requested;
    expect(await archive.getSubject(entry.id)).toMatchObject({ archived: false });
    await activate(archive, [entry]);
    finish();
    expect(await pending).toBe('stale');
    expect(await archive.getSubject(entry.id)).toMatchObject({ archived: false });
  } finally {
    finish();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('resumes local cleanup after a successful manual unfollow without repeating the request', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-manual-unfollow-local-retry-'));
  const archive = await openArchive({ root });
  const entry = subject(42);
  const removeFavorite = vi.fn(() => Promise.resolve());
  const graphics = vi
    .spyOn(libraryImages, 'removeSubjectLibraryImages')
    .mockRejectedValueOnce(new Error('image cleanup blocked'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const generation = await activate(archive, [entry]);
    expect(await archive.recordManualUnfollow(entry.id, generation, removeFavorite)).toBe(
      'retained',
    );
    expect(await archive.getSubject(entry.id)).toBeNull();
    expect(await archive.acceptedSubjectCleanupIds(0, 10)).toEqual([
      { id: entry.id, providerId: entry.providerId },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('manual_unfollow_cleanup_deferred'));
    expect(await archive.resumeAcceptedSubjectCleanup(entry.id, generation)).toBe('purged');
    expect(removeFavorite).toHaveBeenCalledOnce();
  } finally {
    graphics.mockRestore();
    warn.mockRestore();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('hides confirmed empty entries immediately and keeps recordings with their archive cause', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-banned-disposition-'));
  const archive = await openArchive({ root });
  const unfollowed = subject(1);
  const blocked = subject(2);
  const recordedBlock = subject(3);
  const recordedUnfollow = subject(4);
  const legacy = subject(5);
  const regional = subject(6);
  const blockedCoverKey = `preview.cover-source.${blocked.providerId}`;
  const blockedCover = 'https://img.doppiocdn.test/first.jpg';
  const commit = (id: string) =>
    archive.commit({
      subjectId: id,
      sourceEpoch: 'fixture',
      sourceSequence: '1',
      init: null,
      bytes: Uint8Array.of(1),
      durationSeconds: 2,
      wallStartMs: null,
      timeBasis: 'unknown',
      uncertaintyMs: null,
      discontinuity: false,
    });
  try {
    const earlier = await activate(archive, [unfollowed, blocked, recordedBlock, recordedUnfollow]);
    await archive.setSetting(blockedCoverKey, blockedCover);
    const firstRecording = await commit(recordedBlock.id);
    const secondRecording = await commit(recordedUnfollow.id);
    const generation = await activate(archive, [
      { ...unfollowed, accountArchiveReason: 'unfollowed', accountUnfollowConfirmed: true },
      { ...blocked, accountArchiveReason: 'account_disabled', accountBlockedConfirmed: true },
      {
        ...recordedBlock,
        accountArchiveReason: 'account_disabled',
        accountBlockedConfirmed: true,
      },
      { ...recordedUnfollow, accountArchiveReason: 'unfollowed' },
      { ...legacy, accountArchiveReason: 'account_disabled' },
      { ...regional, accountArchiveReason: 'region_restricted' },
    ]);
    expect(await archive.listSubjects()).toMatchObject([
      { id: recordedBlock.id, archived: true, archiveReason: 'account_disabled' },
      { id: recordedUnfollow.id, archived: true, archiveReason: 'unfollowed' },
      { id: legacy.id, archived: true, archiveReason: 'account_disabled' },
      { id: regional.id, archived: false, archiveReason: 'region_restricted' },
    ]);
    expect(await archive.listSubjects({ includeCleanup: true })).toHaveLength(6);
    expect(await archive.followedAccountSubjects()).toContainEqual({
      ...regional,
      accountArchiveReason: 'region_restricted',
    });
    const removeFavorite = vi.fn(() => Promise.resolve());
    expect(await archive.recordVerifiedBlocked(blocked.id, earlier, removeFavorite)).toBe('stale');
    expect(await archive.recordVerifiedBlocked(recordedBlock.id, generation, removeFavorite)).toBe(
      'retained',
    );
    expect(removeFavorite).not.toHaveBeenCalled();
    await expect(
      archive.recordVerifiedBlocked(blocked.id, generation, () =>
        Promise.reject(new Error('upstream rejected')),
      ),
    ).rejects.toThrow('upstream rejected');
    expect(await archive.getSubject(blocked.id)).toBeNull();
    expect(await archive.archivedAccountSubjects(0, 10)).toContainEqual({
      ...blocked,
      accountArchiveReason: 'account_disabled',
    });
    await archive.setSetting(blockedCoverKey, 'https://img.doppiocdn.test/late.jpg');
    expect(await archive.getSetting(blockedCoverKey)).toBe(blockedCover);
    await expect(commit(blocked.id)).rejects.toThrow('SUBJECT_ARCHIVED');
    expect(await archive.recordVerifiedBlocked(blocked.id, generation, removeFavorite)).toBe(
      'purged',
    );
    expect(removeFavorite).toHaveBeenCalledTimes(1);
    expect(await archive.recordVerifiedUnfollowed(unfollowed.id, generation)).toBe('purged');
    expect(await archive.getSubject(blocked.id)).toBeNull();
    expect(await archive.getSubject(unfollowed.id)).toBeNull();
    expect(
      await archive.hasMedia([firstRecording.mediaObjectId, secondRecording.mediaObjectId]),
    ).toBe(true);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('removes only a verified unfollow without footage and keeps the cleanup on cold restore', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unfollow-'));
  const mediaRoot = path.join(root, 'media');
  let archive = await openArchive({ root, mediaRoot });
  const empty = subject(41);
  const stillFollowing = subject(42);
  const unknown = subject(43);
  const coverKey = `preview.cover-source.${empty.providerId}`;
  const cover = 'https://img.doppiocdn.test/fixture.jpg';
  try {
    const earlier = await activate(archive, [empty, stillFollowing, unknown]);
    await archive.setSetting(coverKey, cover);
    const at = Date.now() - 10000;
    await archive.setObservation(empty.id, 'OFFLINE', at);
    await archive.setObservation(empty.id, 'PUBLIC', at + 2000);
    await archive.setObservation(unknown.id, 'OFFLINE', at);
    await archive.setObservation(unknown.id, 'PUBLIC', at + 2000);
    const generation = await activate(archive, [stillFollowing]);
    expect(await archive.recordVerifiedUnfollowed(empty.id, earlier)).toBe('stale');
    expect((await archive.getSubject(empty.id))?.archiveReason).toBeUndefined();
    expect(await archive.recordVerifiedUnfollowed(stillFollowing.id, generation)).toBe('stale');
    expect(await archive.getSubject(empty.id)).toMatchObject({ archived: true });
    expect(await archive.getSetting(coverKey)).toBe(cover);
    const before = await archive.eventMeta();
    expect(await archive.recordVerifiedUnfollowed(empty.id, generation)).toBe('purged');
    expect(await archive.recordVerifiedUnfollowed(empty.id, generation)).toBe('missing');
    expect(await archive.getSubject(empty.id)).toBeNull();
    expect(await archive.getSubject(unknown.id)).toMatchObject({ archived: true });
    expect(await archive.getSetting(coverKey)).toBeNull();
    await archive.setSetting(coverKey, cover);
    expect(await archive.getSetting(coverKey)).toBeNull();
    const after = await archive.eventMeta();
    expect(after.revision).toBeGreaterThan(before.revision);
    expect(after.unreadCount).toBe(before.unreadCount - 1);
    expect((await archive.events()).items).toEqual([
      expect.objectContaining({ kind: 'status_changed', subjectId: unknown.id }),
    ]);

    await archive.close();
    archive = await openArchive({ root: path.join(root, 'restored'), mediaRoot });
    expect(await archive.getSubject(empty.id)).toBeNull();
    expect(await archive.getSetting(coverKey)).toBeNull();
    await activate(archive, [empty, stillFollowing]);
    expect(await archive.getSubject(empty.id)).toMatchObject({ archived: false, formerNames: [] });
    expect((await archive.getSubject(empty.id))?.archiveReason).toBeUndefined();
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps unlocated footage, clears the marker on re-follow, and purges after physical reclamation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unfollow-footage-'));
  const archive = await openArchive({ root });
  const saved = subject(42);
  const commit = (library: ArchiveHandle) =>
    library.commit({
      subjectId: saved.id,
      sourceEpoch: 'recording',
      sourceSequence: '1',
      init: new Uint8Array([0, 1]),
      bytes: new Uint8Array([1, 2]),
      durationSeconds: 2,
      wallStartMs: null,
      timeBasis: 'unknown',
      uncertaintyMs: null,
      discontinuity: false,
    });
  try {
    await activate(archive, [saved]);
    const segment = await commit(archive);
    const earlier = await activate(archive, []);
    expect(await archive.recordVerifiedUnfollowed(saved.id, earlier)).toBe('retained');
    expect((await archive.getSubject(saved.id))?.archiveReason).toBe('unfollowed');
    expect(await archive.hasMedia([segment.mediaObjectId])).toBe(true);
    await activate(archive, [saved]);
    expect((await archive.getSubject(saved.id))?.archiveReason).toBeUndefined();
    const generation = await activate(archive, []);
    expect(await archive.recordVerifiedUnfollowed(saved.id, earlier)).toBe('stale');
    expect((await archive.getSubject(saved.id))?.archiveReason).toBeUndefined();
    expect(await archive.recordVerifiedUnfollowed(saved.id, generation)).toBe('retained');
    await archive.deleteUnlocated(saved.id);
    expect(await archive.hasMedia([segment.mediaObjectId])).toBe(false);
    expect(await archive.getSubject(saved.id)).toMatchObject({ archiveReason: 'unfollowed' });
    expect(await archive.archivedAccountSubjects(0, 10)).toContainEqual({
      ...saved,
      accountArchiveReason: 'unfollowed',
    });
    expect(await archive.recordVerifiedUnfollowed(saved.id, generation)).toBe('purged');
    expect(await archive.getSubject(saved.id)).toBeNull();
    await activate(archive, [saved]);
    expect(await archive.sourceCheckpoint(saved.id)).toBeNull();
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('waits for pending reclamation and keeps the old deletion command idempotent after re-following', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unfollow-deleting-'));
  let release!: () => void;
  let reclaiming!: () => void;
  let held = false;
  const entered = new Promise<void>((resolve) => {
    reclaiming = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const archive = await openArchive({
    root,
    fault: async (point) => {
      if (point !== 'before-unlink' || held) return;
      held = true;
      reclaiming();
      await gate;
    },
  });
  const saved = subject(42);
  const command = randomUUID();
  const target = { kind: 'range', mode: 'all', fromMs: 60000, toMs: 180000 } as const;
  const commit = (start: number) =>
    archive.commit({
      subjectId: saved.id,
      sourceEpoch: 'recording',
      sourceSequence: String(start),
      init: null,
      bytes: Uint8Array.of(1),
      durationSeconds: 2,
      wallStartMs: start,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
  try {
    await activate(archive, [saved]);
    await commit(60000);
    const generation = await activate(archive, []);
    await archive.admitDeletion!(saved.id, command, target);
    await entered;
    expect(await archive.recordVerifiedUnfollowed(saved.id, generation)).toBe('retained');
    expect(await archive.acceptedSubjectCleanupIds(0, 8)).toEqual([]);
    expect(await archive.getSubject(saved.id)).toBeNull();
    expect(await archive.archivedAccountSubjects(0, 8)).toContainEqual({
      ...saved,
      accountArchiveReason: 'unfollowed',
    });
    release();
    await archive.resumeDeletions!();
    const receipt = await archive.deletionJob!(command);
    expect(receipt).toMatchObject({ state: 'completed', processed: 1 });
    expect(await archive.acceptedSubjectCleanupIds(0, 8)).toEqual([
      { id: saved.id, providerId: saved.providerId },
    ]);
    for (let step = 0; step < 6; step++) {
      if (!(await archive.listSubjects({ includeCleanup: true })).some(({ id }) => id === saved.id))
        break;
      await archive.resumeAcceptedSubjectCleanup(saved.id, generation);
    }
    expect(await archive.getSubject(saved.id)).toBeNull();
    expect(await archive.listSubjects({ includeCleanup: true })).toEqual([]);
    expect(await archive.deletionJob!(command)).toEqual(receipt);

    await activate(archive, [saved]);
    const next = await commit(120000);
    expect(await archive.admitDeletion!(saved.id, command, target)).toEqual(receipt);
    expect(await archive.hasMedia([next.mediaObjectId])).toBe(true);
  } finally {
    release();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
}, 15000);
