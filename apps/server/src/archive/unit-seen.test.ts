import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { openArchive } from './index.js';
import { SqlDatabase } from '../database/sql.js';
import { initializeCatalogSchema } from '../database/catalog-schema.js';
import { LibraryStorage } from '../library/storage.js';
import { openTestDatabase, planNodes } from './postgres.test-support.js';
import { PersonalStore } from './personal-store.js';

it('does not rescan seen evidence for each visible unit in a dense subject window', async () => {
  const db = await openTestDatabase();
  const subject = 'stripchat:49';
  const firstMinute = 172800000;
  const from = firstMinute + 7200000;
  const to = from + 43200000;
  try {
    await initializeCatalogSchema(db, 0);
    await db.exec(`INSERT INTO subjects(id,provider_id,handle)
      SELECT 'stripchat:'||i,i,'synthetic-'||i FROM generate_series(1,72) AS ids(i)`);
    // Keep the dense-seen benchmark's half-hour units and hourly evidence.
    await db
      .prepare(
        `WITH units AS (
        INSERT INTO recording_units(id,subject,start,"end",sample,last_start,created_revision,closed)
        SELECT md5(subjects.id||':'||i)::uuid::text,subjects.id,
          $1::bigint+i*1800000,$1::bigint+i*1800000+60000,
          $1::bigint+i*1800000,$1::bigint+i*1800000,0,1
        FROM subjects CROSS JOIN generate_series(0,47) AS seq(i) WHERE provider_id>=49
        RETURNING id,subject,start,"end"
      ), segments AS (
        INSERT INTO segments(id,subject,epoch,sequence,media,start,"end",json)
        SELECT id,subject,'synthetic-seen',id,id,start,"end",'{}' FROM units RETURNING id
      ), membership AS (
        INSERT INTO unit_segments(segment,unit) SELECT id,id FROM segments RETURNING unit
      )
      INSERT INTO unit_seen_ranges(unit,subject,seen_at,seen_to)
      SELECT u.id,u.subject,u."end",u."end" FROM units u JOIN membership m ON m.unit=u.id
      WHERE (u.start-$1::bigint)%3600000=0`,
      )
      .run(firstMinute);
    await db.exec(
      'ANALYZE subjects; ANALYZE recording_units; ANALYZE segments; ANALYZE unit_segments; ANALYZE unit_seen_ranges',
    );
    const store = new PersonalStore(db);
    const execute = vi.spyOn(db.postgres, 'execute');
    const { seenSpans: actual } = await store.seenCoverage(subject, from, to, 360);
    expect(execute).toHaveBeenCalledTimes(1);
    const [query, parameters] = execute.mock.calls[0];
    execute.mockRestore();
    expect(actual).toEqual(
      Array.from({ length: 12 }, (_, index) => ({
        fromMs: from + index * 3600000,
        toMs: from + index * 3600000 + 60000,
      })),
    );
    const explain = async () =>
      planNodes(
        await db.postgres.query(
          'EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON) ' + query,
          parameters,
        ),
      );
    const plan = await explain();
    const scans = plan
      .filter(
        (node) => node['Relation Name'] === 'unit_seen_ranges' && node['Node Type'] === 'Seq Scan',
      )
      .reduce(
        (count, node) => count + ('Actual Loops' in node ? Number(node['Actual Loops']) : 0),
        0,
      );
    // A subject's evidence-existence probe may scan once on a small table.
    expect(scans).toBeLessThanOrEqual(1);

    expect(await store.seenCoverage(subject, from, from + 1860000, 1)).toEqual({
      seenSpans: [{ fromMs: from, toMs: from + 60000 }],
      unreadSpans: [{ fromMs: from + 1800000, toMs: from + 1860000 }],
    });
    expect(await store.seenCoverage(subject, from + 60000, from + 1800000, 1)).toEqual({
      seenSpans: [],
    });
    await db
      .prepare('UPDATE unit_seen_ranges SET seen_to=? WHERE subject=? AND seen_to=?')
      .run(from + 31000, subject, from + 60000);
    expect(await store.seenCoverage(subject, from + 500, from + 32501, 4)).toEqual({
      seenSpans: [{ fromMs: from + 500, toMs: from + 31000 }],
      unreadSpans: [{ fromMs: from + 31000, toMs: from + 32501 }],
    });
    await db
      .prepare('UPDATE recording_units SET deleted=1 WHERE subject=? AND start=?')
      .run(subject, from + 3600000);
    await db
      .prepare(
        `WITH job AS (
          INSERT INTO media_deletions(id,subject,state,total,created,updated)
          VALUES('fixture-preparing',?,'preparing',0,0,0) RETURNING id,subject
        )
        INSERT INTO deletion_intents(job,subject,payload,cutoff,personal,phase,from_ms,to_ms)
        SELECT job.id,job.subject,json_build_object('kind','units','unitIds',json_build_array(u.id))::text,
          0,0,'units',u.start,u."end"
        FROM recording_units u JOIN job ON job.subject=u.subject WHERE u.start=?`,
      )
      .run(subject, from + 7200000);
    // The partial first unit still contributes its viewed prefix. Only the two
    // units covered by deletion are removed from the projection.
    expect((await store.seenCoverage(subject, from, to, 360)).seenSpans).toEqual([
      { fromMs: from, toMs: from + 31000 },
      ...actual.slice(3),
    ]);

    await db.prepare('DELETE FROM unit_seen_ranges WHERE subject=?').run(subject);
    expect(await store.seenCoverage(subject, from, to, 360)).toEqual({ seenSpans: [] });
    expect((await explain()).filter((node) => node['Relation Name'] === 'recording_units')).toEqual(
      expect.arrayContaining([expect.objectContaining({ Alias: 'u', 'Actual Loops': 0 })]),
    );
  } finally {
    await db.close();
  }
});

it('persists idempotent seen evidence by unit without changing favorites or unknown units', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-seen-'));
  let a = await openArchive({ root });
  const id = 'stripchat:1';
  try {
    await a.upsertSubjects([
      { id, providerId: 1, handle: 'seen' },
      { id: 'stripchat:2', providerId: 2, handle: 'other' },
    ]);
    const commit = (sequence: number) =>
      a.commit({
        subjectId: id,
        sourceEpoch: 'e',
        sourceSequence: String(sequence),
        init: null,
        bytes: new Uint8Array([1]),
        durationSeconds: 2,
        wallStartMs: sequence * 60000,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    const first = await commit(1),
      second = await commit(2);
    expect((await a.coverage(id, 0, 180000, 180)).seenSpans).toEqual([]);
    const revision = await a.personalRevision();
    expect(await a.markUnitsSeen!('stripchat:2', [{ unitId: first.id, toMs: 62000 }])).toEqual({
      changed: 0,
    });
    expect(
      await a.markUnitsSeen!(id, [
        { unitId: first.id, toMs: 62000 },
        { unitId: first.id, toMs: 62000 },
      ]),
    ).toEqual({ changed: 1 });
    expect(await a.markUnitsSeen!(id, [{ unitId: first.id, toMs: 62000 }])).toEqual({ changed: 0 });
    expect(await a.personalRevision()).toBe(revision);
    expect((await a.personal(id, 0, 180000)).favorites).toEqual([]);
    expect((await a.coverage(id, 0, 180000, 180)).seenSpans).toEqual([
      { fromMs: 60000, toMs: 62000 },
    ]);
    expect(await a.coverage(id, 0, 180000, 1)).toMatchObject({
      seenSpans: [{ fromMs: 60000, toMs: 62000 }],
      unreadSpans: [{ fromMs: 120000, toMs: 122000 }],
    });
    await a.markUnitsSeen!(id, [{ unitId: second.id, toMs: 122000 }]);
    expect((await a.coverage(id, 0, 180000, 1)).seenSpans).toEqual([
      { fromMs: 60000, toMs: 122000 },
    ]);
    expect(await a.coverage(id, 0, 180000, 1)).toMatchObject({ unreadSpans: [] });
    await a.close();
    a = await openArchive({ root });
    expect((await a.coverage(id, 0, 180000, 180)).seenSpans).toEqual([
      { fromMs: 60000, toMs: 62000 },
      { fromMs: 120000, toMs: 122000 },
    ]);
  } finally {
    await a.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('reopens legacy three-column seen journal rows without trusting their unbounded evidence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-seen-legacy-'));
  const media = path.join(root, 'media');
  let a = await openArchive({ root });
  try {
    await a.upsertSubjects([{ id: 'stripchat:1', providerId: 1, handle: 'legacy' }]);
    const first = await a.commit({
      subjectId: 'stripchat:1',
      sourceEpoch: 'e',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 2,
      wallStartMs: 60000,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
    await a.snapshotPages!('stripchat:1', 60000, 1, 30, { fromMs: 0, toMs: 120000 });
    await a.close();
    const library = new LibraryStorage(root, media);
    const db = await SqlDatabase.open(library.indexFile);
    try {
      await library.attach(db);
      await library.transaction(db, () =>
        db
          .prepare('INSERT INTO unit_seen(unit,subject,seen_at) VALUES(?,?,?)')
          .run(first.id, 'stripchat:1', Date.now()),
      );
    } finally {
      await library.close();
      await db.close();
    }
    a = await openArchive({ root });
    expect((await a.coverage('stripchat:1', 0, 120000, 120)).seenSpans).toEqual([]);
    await a.markUnitsSeen!('stripchat:1', [{ unitId: first.id, toMs: 62000 }]);
    await a.close();
    a = await openArchive({ root });
    expect((await a.coverage('stripchat:1', 0, 120000, 120)).seenSpans).toEqual([
      { fromMs: 60000, toMs: 62000 },
    ]);
  } finally {
    await a.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps a growing tail unread and never rolls evidence back on delayed retries', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-seen-growth-'));
  let a = await openArchive({ root });
  const id = 'stripchat:1';
  try {
    await a.upsertSubjects([{ id, providerId: 1, handle: 'growing' }]);
    const commit = (start: number) =>
      a.commit({
        subjectId: id,
        sourceEpoch: 'e',
        sourceSequence: String(start),
        init: null,
        bytes: new Uint8Array([1]),
        durationSeconds: 2,
        wallStartMs: start,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      });
    const first = await commit(60000);
    await a.markUnitsSeen!(id, [{ unitId: first.id, toMs: 62000 }]);
    await commit(62000);
    await commit(64000);
    const coverage = () => a.coverage(id, 60000, 70000, 100);
    expect((await coverage()).seenSpans).toEqual([{ fromMs: 60000, toMs: 62000 }]);
    expect(await a.markUnitsSeen!(id, [{ unitId: first.id, toMs: 64000 }])).toEqual({ changed: 1 });
    expect(await a.markUnitsSeen!(id, [{ unitId: first.id, toMs: 62000 }])).toEqual({ changed: 0 });
    expect((await coverage()).seenSpans).toEqual([{ fromMs: 60000, toMs: 64000 }]);
    expect(await a.coverage(id, 60000, 70000, 1)).toMatchObject({
      seenSpans: [{ fromMs: 60000, toMs: 64000 }],
      unreadSpans: [{ fromMs: 64000, toMs: 66000 }],
    });
    await a.close();
    a = await openArchive({ root });
    expect((await coverage()).seenSpans).toEqual([{ fromMs: 60000, toMs: 64000 }]);
    // Clamp an overlarge boundary to committed media, never reserve future evidence.
    await a.markUnitsSeen!(id, [{ unitId: first.id, toMs: 999999 }]);
    await commit(66000);
    expect((await coverage()).seenSpans).toEqual([{ fromMs: 60000, toMs: 66000 }]);
  } finally {
    await a.close();
    await rm(root, { recursive: true, force: true });
  }
});
