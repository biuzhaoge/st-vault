import { libraryIndexPath } from '../library/paths.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openTestDatabase, planNodes } from './postgres.test-support.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { openArchive } from './index.js';
import type { ArchiveHandle } from './index.js';
import { firstStatusPageSql } from './status-history.js';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});

const id = 'stripchat:42',
  subject = { id, providerId: 42, handle: 'status-fixture' };
const roots: string[] = [],
  archives: ArchiveHandle[] = [];
async function create(root?: string): Promise<{ root: string; archive: ArchiveHandle }> {
  root ??= await mkdtemp(path.join(tmpdir(), 'stv-status-history-'));
  if (!roots.includes(root)) roots.push(root);
  const archive = await openArchive({ root });
  archives.push(archive);
  await archive.upsertSubjects([subject]);
  return { root, archive };
}
afterEach(async () => {
  await Promise.allSettled(archives.splice(0).map((a) => a.close()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('durable bounded status history', () => {
  it('returns both tracks and accepted personal masks in one workbench read', async () => {
    const { root, archive } = await create();
    await expect(archive.workbenchRow('stripchat:99', 0, 60000, 30, false)).rejects.toThrow(
      'SUBJECT_NOT_FOUND',
    );
    const empty = await archive.workbenchRow(id, 0, 60000, 30, false);
    expect(empty.coverage.buckets.every((bucket) => !bucket.coveredMs)).toBe(true);
    await archive.commit({
      subjectId: id,
      sourceEpoch: 'row',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 5,
      wallStartMs: 2000,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
    await archive.setObservation(id, 'PUBLIC', 1000, 15000);
    const [unit] = (await archive.snapshotUnits!(id, undefined, 1)).items;
    await archive.markUnitsSeen!(id, [{ unitId: unit.unitId, toMs: 4000 }]);
    const selection = await archive.prepareMediaSelection!(
      id,
      { fromMs: 0, toMs: 60000 },
      'explicit',
      undefined,
      { includeUnitIds: [unit.unitId] },
    );
    const db = await openTestDatabase(libraryIndexPath(root));
    try {
      // Isolate the accepted-but-unmaterialized state before the first favorite exists.
      await db
        .prepare(
          'INSERT INTO favorite_commands(id,seq,subject,selection,liked,total,created) VALUES(?,?,?,?,1,1,?)',
        )
        .run('first-like', 1, id, selection.id, 1);
      expect(await db.prepare('SELECT count(*) n FROM unit_favorites').get()).toEqual({ n: 0 });
      const row = await archive.workbenchRow(id, 0, 60000, 30, true);
      expect(row.coverage.favoriteSpans).toEqual([{ fromMs: 2000, toMs: 7000 }]);
      expect(row.coverage.seenSpans).toEqual([{ fromMs: 2000, toMs: 4000 }]);
      expect(row.coverage.protectedSpans?.length).toBeGreaterThan(0);
      expect(row).toEqual({
        coverage: await archive.coverage(id, 0, 60000, 30, true),
        status: await archive.statusHistory(id, 0, 60000, 30),
      });
    } finally {
      await db.close();
    }
  });
  it('seeks by interval end and reads the first bounded range through an index', async () => {
    const { archive, root } = await create();
    await archive.setObservation(id, 'PUBLIC', 1000, 10000);
    await archive.close();
    const db = await openTestDatabase(libraryIndexPath(root));
    try {
      await db
        .prepare(
          `INSERT INTO status_intervals SELECT ?,n*60000+10000,n*60000+11000,'OFFLINE' FROM generate_series(1,5000)n`,
        )
        .run(id);
      await db.exec('ANALYZE status_intervals');
      const details = planNodes(
        await db.prepare('EXPLAIN (FORMAT JSON) ' + firstStatusPageSql).all(id, id, 0, 20000),
      );
      expect(
        details.some(
          (node) =>
            node['Node Type'] === 'Index Only Scan' && node['Index Name'] === 'status_interval_end',
        ),
      ).toBe(true);
      expect(
        details.some(
          (node) =>
            node['Index Name'] === 'status_interval_window' ||
            node['Index Name'] === 'status_intervals_pkey',
        ),
      ).toBe(true);
    } finally {
      await db.close();
    }
  });
  it('keeps the last confirmed list state across lease expiry and restart without extending history', async () => {
    const { archive, root } = await create();
    await archive.setObservation(id, 'PUBLIC', 1000, 1000);
    expect((await archive.listSubjects())[0]).toMatchObject({
      providerStatus: 'UNKNOWN',
      lastKnownStatus: 'PUBLIC',
      observedAtMs: 1000,
    });
    await archive.setObservation(id, 'UNKNOWN', 4000, 1000);
    expect((await archive.listSubjects())[0]).toMatchObject({ lastKnownStatus: 'PUBLIC' });
    expect((await archive.statusHistory(id, 1000, 5000, 1)).buckets[0].durationsMs).toEqual({
      PUBLIC: 1000,
      PRIVATE: 0,
      OFFLINE: 0,
      UNKNOWN: 3000,
    });
    await archive.close();
    const reopened = (await create(root)).archive;
    expect((await reopened.listSubjects())[0]).toMatchObject({
      providerStatus: 'UNKNOWN',
      lastKnownStatus: 'PUBLIC',
    });
    await reopened.setObservation(id, 'OFFLINE', 6000, 1000, 5000);
    expect((await reopened.listSubjects())[0]).toMatchObject({ lastKnownStatus: 'OFFLINE' });
  });
  it('rejects a confirmed boundary older than newer evidence or newer than confirmation', async () => {
    const { archive } = await create();
    const at = Date.now(); // listSubjects intentionally expires historical evidence against wall time.
    await archive.setObservation(id, 'PUBLIC', at, 10000);
    await expect(
      archive.setObservation(id, 'OFFLINE', at + 2000, 10000, at - 1000),
    ).rejects.toThrow('INVALID_TRANSITION_TIME');
    await expect(
      archive.setObservation(id, 'OFFLINE', at + 2000, 10000, at + 3000),
    ).rejects.toThrow('INVALID_OBSERVATION');
    expect((await archive.listSubjects())[0].providerStatus).toBe('PUBLIC');
  });
  it('atomically backdates confirmed transitions and events without shifting the last observation', async () => {
    const { archive } = await create();
    await archive.setObservation(id, 'PUBLIC', 1000, 10000);
    await archive.setObservation(id, 'OFFLINE', 4000, 10000, 2000);
    const history = await archive.statusHistory(id, 1000, 5000, 4);
    expect(history.buckets.map((b) => b.durationsMs.OFFLINE)).toEqual([0, 1000, 1000, 1000]);
    expect((await archive.listSubjects())[0].observedAtMs).toBe(4000);
    const events = await archive.events();
    expect(
      events.items.find((e) => e.kind === 'status_changed' && e.toStatus === 'OFFLINE')
        ?.occurredAtMs,
    ).toBe(2000);
  });
  it('reports the latest continuous online start without moving it on public/private transitions', async () => {
    const { archive } = await create();
    await archive.setObservation(id, 'OFFLINE', 1000, 1000);
    await archive.setObservation(id, 'PUBLIC', 2000, 1000);
    await archive.setObservation(id, 'PRIVATE', 3000, 1000);
    await archive.setObservation(id, 'PUBLIC', 4000, 1000);
    expect((await archive.listSubjects())[0]).toMatchObject({
      lastKnownStatus: 'PUBLIC',
      lastOnlineAtMs: 4000,
      onlineSinceMs: 2000,
    });
    expect((await archive.listSubjects({ activity: false }))[0]).not.toHaveProperty(
      'onlineSinceMs',
    );

    await archive.setObservation(id, 'OFFLINE', 5000, 1000);
    expect((await archive.listSubjects())[0]).not.toHaveProperty('onlineSinceMs');
    await archive.setObservation(id, 'PUBLIC', 6000, 1000);
    expect((await archive.listSubjects())[0]).toMatchObject({ onlineSinceMs: 6000 });

    await archive.setObservation(id, 'PRIVATE', 8000, 1000);
    expect((await archive.listSubjects())[0]).toMatchObject({ onlineSinceMs: 8000 });
  });
  it('clips transitions and expired leases, preserving disconnected and never-observed time as UNKNOWN', async () => {
    const { archive } = await create();
    await archive.setObservation(id, 'PUBLIC', 1000, 5000);
    await archive.setObservation(id, 'PUBLIC', 4000, 5000);
    await archive.setObservation(id, 'PRIVATE', 6000, 1000);
    await archive.setObservation(id, 'UNKNOWN', 7000, 1000);
    await archive.setObservation(id, 'OFFLINE', 10000, 1000);
    const response = await archive.statusHistory(id, 0, 12000, 3);
    expect(response.buckets.map((b) => b.durationsMs)).toEqual([
      { PUBLIC: 3000, PRIVATE: 0, OFFLINE: 0, UNKNOWN: 1000 },
      { PUBLIC: 2000, PRIVATE: 1000, OFFLINE: 0, UNKNOWN: 1000 },
      { PUBLIC: 0, PRIVATE: 0, OFFLINE: 1000, UNKNOWN: 3000 },
    ]);
    await archive.setObservation(id, 'PUBLIC', 5000, 5000); // Late response cannot replace newer truth.
    expect(await archive.statusHistory(id, 0, 12000, 3)).toEqual(response);
    expect((await archive.listSubjects())[0].providerStatus).toBe('UNKNOWN');
  });
  it('seals only the last active tail on restart without extending status over downtime', async () => {
    const { archive, root } = await create();
    await archive.setObservation(id, 'PUBLIC', 1000, 10000);
    await archive.setObservation(id, 'PUBLIC', 5000, 10000);
    await archive.close();
    const { archive: reopened } = await create(root);
    expect((await reopened.listSubjects())[0]).toMatchObject({
      providerStatus: 'UNKNOWN',
      observedAtMs: 5000,
    });
    await reopened.setObservation(id, 'OFFLINE', 20000, 1000);
    expect((await reopened.statusHistory(id, 0, 25000, 1)).buckets[0].durationsMs).toEqual({
      PUBLIC: 4000,
      PRIVATE: 0,
      OFFLINE: 1000,
      UNKNOWN: 20000,
    });
  });
  // All 200 observations cross the durable archive boundary before checking coalescing.
  it('coalesces equal observations and stops accepting late writes while monitoring is disabled', async () => {
    const { archive, root } = await create();
    for (let index = 0; index < 200; index++)
      await archive.setObservation(id, 'PUBLIC', 1000 + index * 1000, 3000);
    await archive.setPolicy(id, { monitorEnabled: false });
    await archive.setObservation(id, 'PRIVATE', 300000, 1000);
    expect((await archive.listSubjects())[0].providerStatus).toBe('UNKNOWN');
    await archive.close();
    const db = await openTestDatabase(libraryIndexPath(root));
    try {
      expect(
        (await db.prepare('SELECT COUNT(*) AS count FROM status_intervals').get())?.count,
      ).toBe(1);
      expect(
        (await db.prepare('SELECT version FROM catalog_schema WHERE id=1').get())?.version,
      ).toBe(1);
    } finally {
      await db.close();
    }
  }, 15000);
  it('persists committed observations across abrupt process exit and leaves a restart gap', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'stv-status-crash-'));
    roots.push(root);
    const script = `import {openArchive} from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
      const a=await openArchive({root:${JSON.stringify(root)}});await a.upsertSubjects([${JSON.stringify(subject)}]);
      await a.setObservation(${JSON.stringify(id)},'PRIVATE',1000,10000);await a.setObservation(${JSON.stringify(id)},'PRIVATE',5000,10000);process.exit(73);`;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '--eval', script],
      { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true },
    );
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      expect(
        await new Promise<number | null>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', resolve);
        }),
      ).toBe(73);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
    }
    const { archive } = await create(root);
    expect((await archive.statusHistory(id, 0, 20000, 1)).buckets[0].durationsMs).toEqual({
      PUBLIC: 0,
      PRIVATE: 4000,
      OFFLINE: 0,
      UNKNOWN: 16000,
    });
  });
  it('clips partial intervals at both edges across multiple pages of a sparse history', async () => {
    const { root, archive } = await create();
    const db = await openTestDatabase(libraryIndexPath(root));
    try {
      await db
        .prepare(
          `INSERT INTO status_intervals SELECT ?,n*2000,n*2000+1500,
          CASE WHEN n%2=0 THEN 'PUBLIC' ELSE 'OFFLINE' END FROM generate_series(0,256)n`,
        )
        .run(id);
      const response = await archive.statusHistory(id, 500, 512250, 1);
      expect(response.buckets).toEqual([
        {
          fromMs: 500,
          toMs: 512250,
          durationsMs: { PUBLIC: 191750, OFFLINE: 192000, PRIVATE: 0, UNKNOWN: 128000 },
        },
      ]);
      const empty = await archive.statusHistory(id, 514000, 515000, 1);
      expect(empty.buckets[0].durationsMs.UNKNOWN).toBe(1000);
      await expect(archive.statusHistory('stripchat:999', 0, 1000, 1)).rejects.toThrow(
        'SUBJECT_NOT_FOUND',
      );
    } finally {
      await db.close();
    }
  });
  it('keeps seven-day aggregation bounded and conserves each bucket, including odd boundaries', async () => {
    const { archive } = await create();
    for (let index = 0; index < 100; index++)
      await archive.setObservation(id, index % 2 ? 'OFFLINE' : 'PUBLIC', 1000 + index * 1001, 1000);
    const response = await archive.statusHistory(id, 0, 7 * 86400000, 720);
    expect(response.buckets).toHaveLength(720);
    expect(
      response.buckets.reduce((sum, b) => sum + b.durationsMs.PUBLIC + b.durationsMs.OFFLINE, 0),
    ).toBe(100000);
    for (const b of response.buckets)
      expect(Object.values(b.durationsMs).reduce((a, v) => a + v, 0)).toBe(b.toMs - b.fromMs);
    const odd = await archive.statusHistory(id, 999, 9012, 7);
    for (const b of odd.buckets) {
      expect(Object.values(b.durationsMs).every((v) => v >= 0)).toBe(true);
      expect(Object.values(b.durationsMs).reduce((a, v) => a + v, 0)).toBe(b.toMs - b.fromMs);
    }
    await expect(archive.statusHistory(id, 0, 10 * 86400000, 720)).rejects.toThrow(
      'INVALID_TIME_WINDOW',
    );
    await expect(archive.statusHistory(id, 0, 10000, 721)).rejects.toThrow(
      'INVALID_STATUS_HISTORY_BUCKETS',
    );
    await expect(archive.setObservation(id, 'PUBLIC', 1000, 999)).rejects.toThrow(
      'INVALID_OBSERVATION',
    );
  });
});
