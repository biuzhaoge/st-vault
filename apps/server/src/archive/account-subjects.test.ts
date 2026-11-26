import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';
import { SqlDatabase } from '../database/sql.js';
import { libraryIndexPath } from '../library/paths.js';

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
