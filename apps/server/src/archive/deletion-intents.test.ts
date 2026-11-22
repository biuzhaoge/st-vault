import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';
import { openTestDatabase } from './postgres.test-support.js';
import { libraryIndexPath } from '../library/paths.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
import { DeletionStore } from './deletion-store.js';
import { DeletionIntents } from './deletion-intents.js';
import { MediaSelectionStore } from './media-selection-store.js';
import { spawn } from 'node:child_process';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});

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
    await archive.admitDeletion!(subjectId, commandId, {
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
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
    await archive.resumeDeletions!();
    expect((await archive.deletionJobs!()).find((entry) => entry.id === commandId)).toMatchObject({
      state: 'completed',
      total: 3,
      processed: 3,
    });
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
  await db.exec(
    'CREATE TABLE subjects(id TEXT PRIMARY KEY,deletion_revision BIGINT);\n    CREATE TABLE personal_owner(id BIGINT PRIMARY KEY,revision BIGINT);INSERT INTO personal_owner VALUES(1,0);\n    CREATE TABLE recording_units(id TEXT PRIMARY KEY,subject TEXT,start BIGINT,"end" BIGINT,closed BIGINT,deleted BIGINT,created_revision BIGINT);\n    CREATE INDEX unit_window ON recording_units(subject,start,id);CREATE INDEX unit_open ON recording_units(subject,closed);\n    CREATE TABLE segments(id TEXT PRIMARY KEY,subject TEXT,start BIGINT,"end" BIGINT,deleted BIGINT,created_revision BIGINT,media TEXT);\n    CREATE INDEX segment_window ON segments(subject,start,id);CREATE INDEX segment_unit_append ON segments(subject,created_revision,id);\n    CREATE TABLE objects(id TEXT PRIMARY KEY,bytes BIGINT);INSERT INTO objects VALUES(\'media\',10);\n    CREATE TABLE unit_segments(segment TEXT PRIMARY KEY,unit TEXT);CREATE INDEX unit_members ON unit_segments(unit,segment);\n    CREATE TABLE unit_favorites(unit TEXT PRIMARY KEY);CREATE VIEW unit_favorite_facts AS SELECT * FROM unit_favorites;\n    CREATE VIEW effective_unit_favorites AS SELECT * FROM unit_favorites;INSERT INTO subjects VALUES(\'s\',0);',
  );
  try {
    await db.transaction(async () => {
      for (let i = 0; i < 10000; i++) {
        const id = String(i).padStart(8, '0');
        await db
          .prepare('INSERT INTO recording_units VALUES(?,?,?,?,1,0,?)')
          .run(id, 's', i * 60000, i * 60000 + 2000, i + 1);
        await db
          .prepare("INSERT INTO segments VALUES(?,?,?,?,0,?,'media')")
          .run(id, 's', i * 60000, i * 60000 + 2000, i + 1);
        await db.prepare('INSERT INTO unit_segments VALUES(?,?)').run(id, id);
      }
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
      batches = 0;
    while ((await jobs.get(job.id)).state === 'preparing') {
      await intents.step();
      batches++;
      const units = (await db
        .prepare('SELECT count(*) n FROM deletion_units')
        .get<{ n: number }>())!.n;
      const files = (await jobs.get(job.id)).total;
      expect(units - priorUnits).toBeLessThanOrEqual(256);
      expect(files - priorFiles).toBeLessThanOrEqual(128);
      priorUnits = units;
      priorFiles = files;
      expect(batches).toBeLessThan(200);
    }
    expect(await jobs.get(job.id)).toMatchObject({ state: 'queued', total: 10000 });
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
