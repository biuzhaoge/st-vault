import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { openArchive } from './index.js';
import { openTestDatabase } from './postgres.test-support.js';
import { libraryIndexPath } from '../library/paths.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
import { deletionBatchSize, deletionPlanPageSize, DeletionStore } from './deletion-store.js';
import { DeletionIntents } from './deletion-intents.js';
import { MediaSelectionStore } from './media-selection-store.js';
import { Metadata } from './metadata.js';
import { spawn } from 'node:child_process';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});

it('replays compacted deletion receipts across a cold restore without selecting later footage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-deletion-receipt-'));
  const mediaRoot = path.join(root, 'media');
  let archive = await openArchive({ root, mediaRoot });
  const id = 'stripchat:42',
    other = 'stripchat:43',
    key = randomUUID();
  const target = { kind: 'range', mode: 'all', fromMs: 60000, toMs: 180000 } as const;
  const commit = (start: number) =>
    archive.commit({
      subjectId: id,
      sourceEpoch: 'receipt',
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
    await archive.upsertSubjects([
      { id, providerId: 42, handle: 'fixture' },
      { id: other, providerId: 43, handle: 'other' },
    ]);
    await commit(60000);
    await archive.admitDeletion!(id, key, target);
    await archive.resumeDeletions!();
    const prior = (await archive.deletionJobs!()).find((job) => job.id === key);
    expect(prior).toMatchObject({ state: 'completed', processed: 1 });
    const later = await commit(120000);
    for (let i = 0; i < 20; i++) {
      await archive.admitDeletion!(id, randomUUID(), { ...target, fromMs: 240000, toMs: 300000 });
      await archive.resumeDeletions!();
      if (i === 18) {
        await archive.resumeFavorites!();
        expect(await archive.admitDeletion!(id, key, target)).toEqual(prior);
      }
    }
    await archive.resumeFavorites!();
    expect((await archive.deletionJobs!()).some((job) => job.id === key)).toBe(false);
    await archive.close();
    archive = await openArchive({ root: path.join(root, 'cold'), mediaRoot });
    const mediaChanges = vi.fn();
    archive.subscribeMedia!(mediaChanges);
    const resume = vi.spyOn(archive, 'resumeDeletions');
    const revision = (await archive.coverage(id, target.fromMs, target.toMs, 30)).revision;
    expect(await archive.deletionJob!(key)).toEqual(prior);
    expect(await archive.deletionJob!(randomUUID())).toBeNull();
    await expect(archive.admitDeletion!(other, key, target)).rejects.toThrow('COMMAND_ID_CONFLICT');
    await expect(archive.admitDeletion!(id, key, { ...target, toMs: 179999 })).rejects.toThrow(
      'COMMAND_ID_CONFLICT',
    );
    expect(
      await archive.admitDeletion!(id, key, {
        toMs: 180000,
        fromMs: 60000,
        mode: 'all',
        kind: 'range',
      }),
    ).toEqual(prior);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mediaChanges).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
    expect((await archive.coverage(id, target.fromMs, target.toMs, 30)).revision).toBe(revision);
    expect(
      (await archive.timeline(id, target.fromMs, target.toMs)).segments.map(
        (segment) => segment.id,
      ),
    ).toEqual([later.id]);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

it('advances a backed-off deletion intent when manually retried after storage recovers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-deletion-retry-'));
  let unavailable = true;
  const archive = await openArchive({
    root,
    fault: (point) => {
      if (unavailable && point === 'before-deletion-prepare') throw Error('FIXTURE_STORAGE');
    },
  });
  const subjectId = 'stripchat:42';
  const commandId = randomUUID();
  try {
    await archive.upsertSubjects([{ id: subjectId, providerId: 42, handle: 'fixture' }]);
    await archive.commit({
      subjectId,
      sourceEpoch: 'one',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 2,
      wallStartMs: 60000,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
    const accepted = await archive.admitDeletion!(subjectId, commandId, {
      kind: 'range',
      mode: 'all',
      fromMs: 60000,
      toMs: 120000,
    });
    await archive.resumeDeletions!();
    expect((await archive.deletionJobs!())[0]).toMatchObject({
      id: commandId,
      state: 'preparing',
      error: 'storage_unavailable',
    });
    unavailable = false;
    await archive.retryDeletions?.();
    expect((await archive.deletionJobs!())[0]).toMatchObject({
      id: commandId,
      state: 'completed',
      total: 1,
      processed: 1,
      error: null,
    });
    const coverage = await archive.coverage(subjectId, 60000, 120000);
    expect(coverage.revision).toBe(accepted.deletionRevision);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps the archive available when a queued deletion cannot read its batch and journal head', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-deletion-pressure-'));
  const archive = await openArchive({ root });
  const subjectId = 'stripchat:42';
  const commandId = randomUUID();
  const originalRead = Metadata.prototype.read;
  let pressure = false,
    rejectedBatch = false;
  const metadata = vi.spyOn(Metadata.prototype, 'read').mockImplementation(function (
    this: Metadata,
    method,
    input,
    signal,
  ) {
    if (method === 'deleteBatch' && pressure && !rejectedBatch) {
      rejectedBatch = true;
      return Promise.reject(Error('METADATA_READ_BUSY'));
    }
    return originalRead.call(this, method, input, signal);
  });
  try {
    await archive.upsertSubjects([{ id: subjectId, providerId: 42, handle: 'fixture' }]);
    await archive.commit({
      subjectId,
      sourceEpoch: 'pressure',
      sourceSequence: '1',
      init: null,
      bytes: Uint8Array.of(1),
      durationSeconds: 2,
      wallStartMs: 60000,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
    pressure = true;
    await archive.admitDeletion!(subjectId, commandId, {
      kind: 'range',
      mode: 'all',
      fromMs: 60000,
      toMs: 120000,
    });
    await archive.resumeDeletions!();
    expect(rejectedBatch).toBe(true);
    expect(await archive.getSubject(subjectId)).toMatchObject({ id: subjectId });
    expect(await archive.deletionJob!(commandId)).toMatchObject({ state: 'retry', processed: 0 });

    await archive.retryDeletions!();
    expect(await archive.deletionJob!(commandId)).toMatchObject({
      state: 'completed',
      processed: 1,
    });
  } finally {
    metadata.mockRestore();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('continues immediately when a step finishes inside a lookup that excluded its subject', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-deletion-wakeup-'));
  const subjectId = 'stripchat:42',
    commandId = randomUUID();
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const archive = await openArchive({
    root,
    backgroundConcurrency: 2,
    fault: (point) => (point === 'before-deletion-prepare' ? hold : undefined),
  });
  const originalRead = Metadata.prototype.read;
  let sawExcludedLookup = false;
  const metadata = vi.spyOn(Metadata.prototype, 'read').mockImplementation(async function (
    this: Metadata,
    method,
    input,
    signal,
  ) {
    const result = await originalRead.call(this, method, input, signal);
    if (
      method === 'nextMediaDeletion' &&
      !result &&
      !sawExcludedLookup &&
      (input as { excludedSubjects: string[] }).excludedSubjects.includes(subjectId)
    ) {
      sawExcludedLookup = true;
      release();
      await vi.waitFor(async () =>
        expect((await archive.deletionJob!(commandId))?.phase).toBe('plan'),
      );
    }
    return result;
  });
  try {
    await archive.upsertSubjects([{ id: subjectId, providerId: 42, handle: 'fixture' }]);
    await archive.commit({
      subjectId,
      sourceEpoch: 'wakeup',
      sourceSequence: '1',
      init: null,
      bytes: Uint8Array.of(1),
      durationSeconds: 2,
      wallStartMs: 60000,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
    await archive.admitDeletion!(subjectId, commandId, {
      kind: 'range',
      mode: 'all',
      fromMs: 60000,
      toMs: 120000,
    });
    await archive.resumeDeletions!();
    expect(sawExcludedLookup).toBe(true);
    expect(await archive.deletionJob!(commandId)).toMatchObject({
      state: 'completed',
      processed: 1,
      reclaimedBytes: 1,
    });
  } finally {
    release();
    metadata.mockRestore();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('persists overflow deletions and resumes them from the original confirmation after recovery', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-deletion-overflow-'));
  const mediaRoot = path.join(root, 'media');
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let archive = await openArchive({
    root,
    mediaRoot,
    backgroundConcurrency: 1,
    fault: (point) => (point === 'before-deletion-prepare' ? hold : undefined),
  });
  const subjectId = 'stripchat:42',
    busySubject = 'stripchat:43';
  const commandId = randomUUID();
  const target = { kind: 'range', mode: 'unliked', fromMs: 60000, toMs: 180000 } as const;
  const record = (at: number) =>
    archive.commit({
      subjectId,
      sourceEpoch: 'overflow',
      sourceSequence: String(at),
      init: null,
      bytes: Uint8Array.of(at / 1000),
      durationSeconds: 2,
      wallStartMs: at,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
  try {
    await archive.upsertSubjects([
      { id: subjectId, providerId: 42, handle: 'recorded' },
      { id: busySubject, providerId: 43, handle: 'busy' },
    ]);
    const liked = await record(60000);
    const original = await record(120000);
    await archive.unitFavorites!(subjectId, [liked.id], true, await archive.personalRevision());
    for (let i = 0; i < 64; i++) await archive.admitDeletion!(busySubject, randomUUID(), target);
    const accepted = await archive.admitDeletion!(subjectId, commandId, target);
    expect(accepted).toMatchObject({ id: commandId, state: 'waiting', processed: 0 });
    expect(await archive.admitDeletion!(subjectId, commandId, target)).toEqual(accepted);
    expect(await archive.media(original.mediaObjectId)).toBeNull();
    expect((await archive.deletionInventory!()).waiting).toBe(1);
    await archive.unitFavorites!(subjectId, [liked.id], false, await archive.personalRevision());
    const later = await record(125000);

    const closing = archive.close();
    release();
    await closing;
    archive = await openArchive({ root: path.join(root, 'restored'), mediaRoot });
    expect(await archive.deletionJob!(commandId)).toEqual(accepted);
    await archive.resumeDeletions!();
    expect(await archive.deletionJob!(commandId)).toMatchObject({
      state: 'completed',
      processed: 1,
    });
    expect(
      (await archive.timeline(subjectId, target.fromMs, target.toMs)).segments.map(({ id }) => id),
    ).toEqual([liked.id, later.id]);
  } finally {
    release();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);

it('keeps unrelated reads available when a recording write times out before publication', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-busy-recording-'));
  const archive = await openArchive({ root });
  const blocker = await openTestDatabase(libraryIndexPath(root));
  let release!: () => void, locked!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const acquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const id = 'stripchat:42';
  let held: Promise<void> | undefined;
  const input = {
    subjectId: id,
    sourceEpoch: 'busy',
    sourceSequence: '1',
    init: null,
    bytes: new Uint8Array([1]),
    durationSeconds: 2,
    wallStartMs: 60000,
    timeBasis: 'source-pdt' as const,
    uncertaintyMs: 0,
    discontinuity: false,
  };
  try {
    await archive.upsertSubjects([{ id, providerId: 42, handle: 'Fixture' }]);
    held = blocker.transaction(async () => {
      await blocker.exec('SELECT * FROM counters WHERE id=1 FOR UPDATE');
      locked();
      await gate;
    });
    await Promise.race([acquired, held]);
    await expect(archive.commit(input)).rejects.toThrow('METADATA_STORAGE_BUSY');
    expect(await archive.listSubjects()).toMatchObject([{ id }]);
    expect((await archive.timeline(id, 0, 120000)).segments).toEqual([]);
    release();
    await held;
    await archive.commit(input);
    expect((await archive.timeline(id, 0, 120000)).segments).toHaveLength(1);
  } finally {
    release();
    await Promise.allSettled(held ? [held] : []);
    await blocker.close();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('durably accepts before preparation, hides media immediately, and resumes on another hot index', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-intent-'));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let armed = true;
  let archive = await openArchive({
    root,
    fault: async (point) => {
      if (armed && point === 'before-deletion-prepare') {
        armed = false;
        entered();
        await gate;
      }
    },
  });
  const subjectId = 'stripchat:42';
  const commandId = randomUUID();
  try {
    const completed = vi.fn();
    archive.subscribeDeletionComplete!(completed);
    await archive.upsertSubjects([{ id: subjectId, providerId: 42, handle: 'intent' }]);
    for (let index = 0; index <= 3; index++)
      await archive.commit({
        subjectId,
        sourceEpoch: 'intent',
        sourceSequence: String(index),
        init: null,
        bytes: new Uint8Array([index]),
        durationSeconds: 2,
        wallStartMs: index * 60000,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    const target = { kind: 'range' as const, mode: 'all' as const, fromMs: 60000, toMs: 240000 };
    const job = await archive.admitDeletion!(subjectId, commandId, target);
    expect(job).toMatchObject({ id: commandId, state: 'preparing', processed: 0, total: 0 });
    await preparing;
    expect(await archive.deletionJob!(commandId)).toMatchObject({
      id: commandId,
      state: 'preparing',
    });
    expect(completed).not.toHaveBeenCalled();
    expect((await archive.getSubject(subjectId))?.lastRecordedAtMs).toBe(2000);
    expect((await archive.listSubjects())[0]?.lastRecordedAtMs).toBe(2000);
    expect((await archive.timeline(subjectId, 60000, 300000)).segments).toHaveLength(0);
    expect(
      (await archive.coverage(subjectId, 60000, 300000, 30)).buckets.every(
        (bucket) => bucket.coveredMs === 0,
      ),
    ).toBe(true);
    expect(
      (await archive.snapshotPages!(subjectId, 60000, 1, 30, { fromMs: 60000, toMs: 300000 }))
        .total,
    ).toBe(0);
    expect((await archive.admitDeletion!(subjectId, commandId, target)).id).toBe(commandId);
    await expect(
      archive.admitDeletion!(subjectId, commandId, { ...target, toMs: 250000 }),
    ).rejects.toThrow('COMMAND_ID_CONFLICT');
    const closing = archive.close();
    release();
    await closing;
    archive = await openArchive({
      root: path.join(root, 'other-index'),
      mediaRoot: path.join(root, 'media'),
    });
    expect((await archive.deletionJobs!()).some((entry) => entry.id === commandId)).toBe(true);
    expect((await archive.deletionJobs!()).find((entry) => entry.id === commandId)?.state).toBe(
      'preparing',
    );
    const changes = vi.fn();
    archive.subscribeMedia!(changes);
    archive.subscribeDeletionComplete!(completed);
    const resume = vi.spyOn(archive, 'resumeDeletions');
    await archive.admitDeletion!(subjectId, commandId, target);
    await vi.waitFor(
      async () =>
        expect(
          (await archive.deletionJobs!()).find((entry) => entry.id === commandId),
        ).toMatchObject({
          state: 'completed',
          total: 3,
          processed: 3,
        }),
      { timeout: 10000 },
    );
    await archive.resumeDeletions!();
    expect(resume).toHaveBeenCalled();
    expect(changes).not.toHaveBeenCalled();
    expect(completed).toHaveBeenCalledOnce();
  } finally {
    release();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it('continues an accepted unliked deletion across later unfavorites without expanding its target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-intent-favorite-change-'));
  let entered!: () => void, release!: () => void;
  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let archive = await openArchive({
    root,
    fault: async (point) => {
      if (point === 'before-deletion-prepare') {
        entered();
        await gate;
      }
    },
  });
  const id = 'stripchat:42';
  const commit = (at: number) =>
    archive.commit({
      subjectId: id,
      sourceEpoch: 'fixture',
      sourceSequence: String(at),
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 2,
      wallStartMs: at,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
  try {
    await archive.upsertSubjects([{ id, providerId: 42, handle: 'fixture' }]);
    const liked = await commit(60000),
      unliked = await commit(120000);
    await archive.unitFavorites!(id, [liked.id], true, await archive.personalRevision());
    const command = randomUUID();
    const target = { kind: 'range', mode: 'unliked', fromMs: 60000, toMs: 180000 } as const;
    await archive.admitDeletion!(id, command, target);
    await preparing;
    await archive.unitFavorites!(id, [liked.id], false, await archive.personalRevision());
    const original = await archive.admitDeletion!(id, command, target);
    expect(original).toMatchObject({ id: command, state: 'preparing' });
    expect(
      (await archive.timeline(id, 60000, 180000)).segments.map(({ id: segment }) => segment),
    ).toEqual([liked.id]);
    const closing = archive.close();
    release();
    await closing;
    archive = await openArchive({
      root: path.join(root, 'cold'),
      mediaRoot: path.join(root, 'media'),
    });
    await archive.resumeDeletions!();
    expect((await archive.deletionJobs!()).find((job) => job.id === command)).toMatchObject({
      state: 'completed',
      processed: 1,
    });
    const remaining = (await archive.timeline(id, 60000, 180000)).segments.map(
      ({ id: segment }) => segment,
    );
    expect(remaining).toEqual([liked.id]);
    expect(remaining).not.toContain(unliked.id);
  } finally {
    release();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it('recovers an admitted intent after abrupt process exit before any preparation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-intent-crash-'));
  const commandId = randomUUID();
  const script = `import {openArchive} from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
    const archive=await openArchive({root:${JSON.stringify(root)},fault(point){if(point==='before-deletion-prepare')process.exit(74);}});
    await archive.upsertSubjects([{id:'stripchat:42',providerId:42,handle:'crash'}]);
    for(let i=1;i<=3;i++)await archive.commit({subjectId:'stripchat:42',sourceEpoch:'crash',sourceSequence:String(i),init:null,bytes:new Uint8Array([i]),durationSeconds:2,wallStartMs:i*60000,timeBasis:'source-pdt',uncertaintyMs:0,discontinuity:false});
    await archive.admitDeletion('stripchat:42',${JSON.stringify(commandId)},{kind:'range',mode:'all',fromMs:0,toMs:300000});`;
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', script],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  let error = '';
  child.stderr.on('data', (bytes: Buffer) => {
    error = (error + bytes.toString()).slice(-8000);
  });
  const timer = setTimeout(() => child.kill(), 15000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(code, error).toBe(74);
    const archive = await openArchive({
      root: path.join(root, 'cold'),
      mediaRoot: path.join(root, 'media'),
    });
    try {
      expect((await archive.deletionJobs!()).find((job) => job.id === commandId)).toMatchObject({
        state: 'preparing',
        processed: 0,
        total: 0,
      });
      await archive.resumeDeletions!();
      expect((await archive.deletionJobs!()).find((job) => job.id === commandId)).toMatchObject({
        state: 'completed',
        processed: 3,
        total: 3,
      });
    } finally {
      await archive.close();
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);

it('admits 10000 units without enumerating targets and prepares in bounded continuations', async () => {
  const db = await openTestDatabase();
  await db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  await db.exec(
    'CREATE TABLE subjects(id TEXT PRIMARY KEY,deletion_revision BIGINT);\n    CREATE TABLE personal_owner(id BIGINT PRIMARY KEY,revision BIGINT);INSERT INTO personal_owner VALUES(1,0);\n    CREATE TABLE recording_units(id TEXT PRIMARY KEY,subject TEXT,start BIGINT,"end" BIGINT,closed BIGINT,deleted BIGINT,created_revision BIGINT);\n    CREATE INDEX unit_window ON recording_units(subject,start,id);CREATE INDEX unit_open ON recording_units(subject,closed);\n    CREATE TABLE segments(id TEXT PRIMARY KEY,subject TEXT,start BIGINT,"end" BIGINT,deleted BIGINT,created_revision BIGINT,media TEXT);\n    CREATE INDEX segment_window ON segments(subject,start,id);CREATE INDEX segment_unit_append ON segments(subject,created_revision,id);\n    CREATE TABLE objects(id TEXT PRIMARY KEY,bytes BIGINT);INSERT INTO objects VALUES(\'media\',10);\n    CREATE TABLE unit_segments(segment TEXT PRIMARY KEY,unit TEXT);CREATE INDEX unit_members ON unit_segments(unit,segment);\n    CREATE TABLE unit_favorites(unit TEXT PRIMARY KEY);CREATE VIEW unit_favorite_facts AS SELECT * FROM unit_favorites;\n    CREATE VIEW effective_unit_favorites AS SELECT * FROM unit_favorites;INSERT INTO subjects VALUES(\'s\',0);',
  );
  try {
    await db.transaction(async () => {
      await db.exec(`
        INSERT INTO recording_units
        SELECT lpad(i::text,8,'0'),'s',i*60000,i*60000+2000,1,0,i+1
        FROM generate_series(0,9999) AS ids(i);
        INSERT INTO segments SELECT id,subject,start,"end",0,created_revision,'media' FROM recording_units;
        INSERT INTO unit_segments SELECT id,id FROM recording_units;
      `);
    });
    const jobs = new DeletionStore(db, () => Promise.resolve(0)),
      selections = new MediaSelectionStore(db, () => Promise.resolve(10000));
    await jobs.initialize();
    await selections.initialize();
    const intents = new DeletionIntents(
      db,
      jobs,
      selections,
      () => Promise.resolve(10000),
      () => Promise.resolve(0),
    );
    await intents.initialize();
    const started = performance.now();
    const job = await intents.admit('s', randomUUID(), {
      kind: 'range',
      mode: 'all',
      fromMs: 0,
      toMs: 600000000,
    });
    const admittedMs = performance.now() - started;
    expect(await db.prepare('SELECT count(*) n FROM deletion_units').get()).toMatchObject({ n: 0 });
    expect(await db.prepare('SELECT count(*) n FROM deletion_items').get()).toMatchObject({ n: 0 });
    let priorUnits = 0,
      priorFiles = 0,
      batches = 0,
      reclaimedDuringPlanning = false;
    while ((await jobs.get(job.id)).state === 'preparing') {
      await intents.step();
      batches++;
      const units = (await db
        .prepare('SELECT count(*) n FROM deletion_units')
        .get<{ n: number }>())!.n;
      const files = (await jobs.get(job.id)).total;
      expect(units - priorUnits).toBeLessThanOrEqual(256);
      expect(files - priorFiles).toBeLessThanOrEqual(deletionPlanPageSize);
      if (files && !reclaimedDuringPlanning) {
        const firstBatch = await jobs.next([], true);
        expect(firstBatch).toMatchObject({ id: job.id, state: 'preparing', phase: 'plan' });
        expect(firstBatch!.segmentIds).toHaveLength(deletionBatchSize);
        // A new process must read the same committed batch without an earlier claim.
        await jobs.recover();
        expect((await jobs.next([], true))!.segmentIds).toEqual(firstBatch!.segmentIds);
        const checkpoint = await jobs.advance(job.id, deletionBatchSize, 1024);
        expect(checkpoint).toMatchObject({
          processed: deletionBatchSize,
          total: deletionPlanPageSize,
          reclaimedBytes: 1024,
          state: 'preparing',
        });
        expect((await jobs.next([], true))!.segmentIds).not.toContain(firstBatch!.segmentIds[0]);
        reclaimedDuringPlanning = true;
      }
      priorUnits = units;
      priorFiles = files;
      expect(batches).toBeLessThan(200);
    }
    expect(await jobs.get(job.id)).toMatchObject({
      state: 'queued',
      total: 10000,
      processed: deletionBatchSize,
    });
    console.info(
      JSON.stringify({
        benchmark: 'durable-deletion-10000',
        admittedMs,
        prepareMs: performance.now() - started,
        batches,
      }),
    );
  } finally {
    await db.close();
  }
}, 20000);

it('preserves favorites and recordings committed after durable admission', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-intent-boundary-'));
  const archive = await openArchive({ root });
  const subjectId = 'stripchat:42';
  const commit = (sequence: number) =>
    archive.commit({
      subjectId,
      sourceEpoch: 'boundary',
      sourceSequence: String(sequence),
      init: null,
      bytes: new Uint8Array([sequence]),
      durationSeconds: 2,
      wallStartMs: sequence * 60000,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
  try {
    await archive.upsertSubjects([{ id: subjectId, providerId: 42, handle: 'boundary' }]);
    const favorite = await commit(1),
      removed = await commit(2);
    await archive.unitFavorites!(subjectId, [favorite.id], true, 0);
    const job = await archive.admitDeletion!(subjectId, randomUUID(), {
      kind: 'range',
      mode: 'unliked',
      fromMs: 0,
      toMs: 600000,
    });
    const later = await commit(3);
    await archive.resumeDeletions!();
    expect((await archive.deletionJobs!()).find((entry) => entry.id === job.id)).toMatchObject({
      state: 'completed',
      total: 1,
      processed: 1,
    });
    const ids = (await archive.timeline(subjectId, 0, 600000)).segments.map(
      (segment) => segment.id,
    );
    expect(ids).toContain(favorite.id);
    expect(ids).toContain(later.id);
    expect(ids).not.toContain(removed.id);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
