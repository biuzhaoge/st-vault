// Run in an isolated ST-Vault runtime with this script mounted read-only and no library mounts.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chown, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [largeCount = 12692, shortCount = 342] = process.argv.slice(2).map(Number);
assert(
  process.argv.length <= 4 &&
    Number.isInteger(largeCount) &&
    largeCount >= 128 &&
    largeCount <= 50000,
);
assert(Number.isInteger(shortCount) && shortCount >= 1 && shortCount <= 1000);

const appRoot =
  process.env.STV_BENCH_APP_ROOT ?? fileURLToPath(new URL('../../build/', import.meta.url));
const imported = (module) =>
  import(pathToFileURL(path.join(appRoot, 'apps/server/src', module)).href);
const subject = { id: 'stripchat:1', providerId: 1, handle: 'deletion-benchmark' };
const origin = Date.UTC(2026, 0, 1);
const historyCount = Math.min(4096, largeCount);
const fixture = Buffer.alloc(4096, 0x53);
const hash = createHash('sha256').update(fixture).digest('hex');
const fragmentMs = 2000;
const perUnit = 30;
const pollMs = 50;
const fallbackWakeMs = 5000;
const round = (ms) => Math.round(ms * 100) / 100;
const fragmentFilename = ({ bucket, id }) => `${bucket}/seg-${id}.m4s`;

function makeRows() {
  const rows = [];
  const targets = [];
  let nextStart = origin;
  for (const [name, count] of [
    ['history', historyCount],
    ['large', largeCount],
    ['short', shortCount],
  ]) {
    const fromMs = nextStart;
    const rowId = (ix) => `00000000-0000-4000-8000-${String(ix).padStart(12, '0')}`;
    const base = rows.length + 1;
    for (let i = 0; i < count; i++) {
      const sequence = base + i;
      const id = rowId(sequence);
      const start = fromMs + i * fragmentMs;
      const end = start + fragmentMs;
      const bucket = new Date(start).toISOString().slice(0, 13).replace('T', '/');
      rows.push({ id, sequence, start, end, unit: rowId(base + i - (i % perUnit)), bucket });
    }
    if (name !== 'history')
      targets.push({ name, count, fromMs, toMs: fromMs + count * fragmentMs });
    nextStart += (Math.ceil(count / perUnit) + 1) * perUnit * fragmentMs;
  }
  return { rows, targets };
}

async function seed(db, directory, rows) {
  // Seed a fresh hot projection to keep recording and encoding out of the deletion measurement.
  // The worker will still journal every actual deletion and use real files for storage reclamation.
  await db.transaction(async () => {
    await db.exec(`SET LOCAL stv.replay='on';
      CREATE TEMP TABLE benchmark_fragments (id text,sequence bigint,start bigint,"end" bigint,unit text,bucket text) ON COMMIT DROP`);
    await db
      .prepare(
        `INSERT INTO benchmark_fragments
      SELECT * FROM json_to_recordset(?::json) AS r(id text,sequence bigint,start bigint,"end" bigint,unit text,bucket text)`,
      )
      .run(JSON.stringify(rows));
    await db
      .prepare(
        `INSERT INTO objects(id,subject,filename,bytes,hash,kind)
      SELECT id,?,bucket||'/seg-'||id||'.m4s',?,?, 'fragment' FROM benchmark_fragments`,
      )
      .run(subject.id, fixture.byteLength, hash);
    await db
      .prepare(
        `INSERT INTO segments(id,subject,epoch,sequence,media,init,start,"end",json,created_revision)
      SELECT id,?, 'benchmark',sequence::text,id,NULL,start,"end",json_build_object(
        'id',id,'subjectId',?::text,'sourceEpoch','benchmark','sourceSequence',sequence::text,
        'mediaObjectId',id,'initObjectId',NULL,'wallStartMs',start,'wallEndMs',"end",
        'durationSeconds',2,'timeBasis','source-pdt','uncertaintyMs',0,'discontinuity',false
      )::text,sequence FROM benchmark_fragments`,
      )
      .run(subject.id, subject.id);
    await db
      .prepare(
        `INSERT INTO recording_units(id,subject,start,"end",sample,last_start,created_revision,closed)
      SELECT unit,?,min(start),max("end"),min(start),max(start),min(sequence),1 FROM benchmark_fragments GROUP BY unit`,
      )
      .run(subject.id);
    await db.exec(
      'INSERT INTO unit_segments(segment,unit) SELECT id,unit FROM benchmark_fragments',
    );
    await db
      .prepare(
        `INSERT INTO coverage_minutes(subject,minute,spans,starts,ends,count,covered_ms,start_count,end_count)
      SELECT ?,min(start),json_build_array(json_build_array(0,count(*)*2000))::text,
        json_agg(start%60000 ORDER BY start)::text,json_agg("end"-start+start%60000 ORDER BY "end")::text,
        count(*),count(*)*2000,count(*),count(*) FROM benchmark_fragments GROUP BY unit`,
      )
      .run(subject.id);
    await db.prepare('UPDATE counters SET revision=? WHERE id=1').run(rows.length);
  });
  await db.exec(
    'ANALYZE segments; ANALYZE objects; ANALYZE unit_segments; ANALYZE recording_units;',
  );
  const buckets = [...new Set(rows.map(({ bucket }) => bucket))];
  await Promise.all(
    buckets.map((bucket) => mkdir(path.join(directory, bucket), { recursive: true })),
  );
  for (let i = 0; i < rows.length; i += 64) {
    await Promise.all(
      rows
        .slice(i, i + 64)
        .map((row) =>
          writeFile(path.join(directory, fragmentFilename(row)), fixture, { flag: 'wx' }),
        ),
    );
  }
  return buckets;
}

async function measure(archive, targets) {
  const runs = [];
  for (const { name, count, fromMs, toMs } of targets) {
    const id = randomUUID(),
      started = performance.now();
    await archive.admitDeletion(subject.id, id, { kind: 'range', mode: 'unliked', fromMs, toMs });
    runs.push({ id, name, count, started, admitMs: round(performance.now() - started) });
  }
  let workerError;
  // Mirror the service heartbeat so earlier builds with lost wakeups still make progress.
  const wake = setInterval(() => {
    void archive.resumeDeletions().catch((error) => {
      workerError = error;
    });
  }, fallbackWakeMs).unref();
  try {
    while (runs.some((run) => !run.completed)) {
      if (workerError) throw workerError;
      for (const run of runs) {
        if (run.completed) continue;
        const job = await archive.deletionJob(run.id);
        assert(job && job.state !== 'failed' && !job.error, 'Deletion failed');
        const elapsed = round(performance.now() - run.started);
        assert(elapsed < 900000, 'Deletion benchmark timed out');
        if (job.scannedUnits || job.phase !== 'units') run.firstPreparationMs ??= elapsed;
        if (job.reclaimedBytes) run.firstDurableReclaimMs ??= elapsed;
        if (job.state !== 'completed') continue;
        assert.equal(job.processed, run.count);
        assert.equal(job.reclaimedBytes, run.count * fixture.byteLength);
        run.completed = elapsed;
      }
      if (runs.some((run) => !run.completed)) await delay(pollMs);
    }
  } finally {
    clearInterval(wake);
  }
  return runs.map(
    ({ name, count, admitMs, firstPreparationMs, firstDurableReclaimMs, completed }) => ({
      name,
      fragments: count,
      reclaimedBytes: count * fixture.byteLength,
      admitMs,
      firstPreparationMs,
      firstDurableReclaimMs,
      totalMs: completed,
    }),
  );
}

const [
  { EmbeddedPostgres, PostgresProcessesRunningError },
  { openArchive },
  { SqlDatabase },
  paths,
] = await Promise.all([
  imported('database/embedded.js'),
  imported('archive/index.js'),
  imported('database/sql.js'),
  imported('library/paths.js'),
]);
const root = await mkdtemp(path.join(tmpdir(), 'stv-deletion-workload-'));
if (process.getuid() === 0) {
  await chown(root, 1000, 1000);
  process.setgid(1000);
  process.setuid(1000);
}
const data = path.join(root, 'data'),
  media = path.join(root, 'media');
let postgres,
  archive,
  db,
  cleanupAllowed = true;
try {
  postgres = await EmbeddedPostgres.open({
    root: data,
    binaries: process.env.STV_POSTGRES_BIN ?? '/usr/lib/postgresql/18/bin',
    nssWrapper: '/usr/local/lib/libnss_wrapper.so',
  });
  process.env.STV_DATABASE_SOCKET = String(postgres.connection.host);
  process.env.STV_DATABASE_PASSWORD = String(postgres.connection.password);
  archive = await openArchive({ root: data, mediaRoot: media });
  await archive.upsertSubjects([subject]);
  db = await SqlDatabase.open(paths.libraryIndexPath(data, media));
  const directory = path.join(paths.subjectDirectory(media, subject.id), 'recordings');
  const seedStarted = performance.now();
  const { rows, targets } = makeRows();
  const buckets = await seed(db, directory, rows);
  const seedMs = round(performance.now() - seedStarted);
  const jobs = await measure(archive, targets);
  const remaining = (
    await Promise.all(
      buckets.map(async (bucket) =>
        (await readdir(path.join(directory, bucket))).map((name) => `${bucket}/${name}`),
      ),
    )
  ).flat();
  assert.deepEqual(remaining.sort(), rows.slice(0, historyCount).map(fragmentFilename).sort());
  console.log(
    JSON.stringify({
      event: 'deletion_benchmark',
      pollMs,
      fallbackWakeMs,
      seedMs,
      remaining: remaining.length,
      jobs,
    }),
  );
} catch (error) {
  if (error instanceof PostgresProcessesRunningError) cleanupAllowed = false;
  throw error;
} finally {
  try {
    await db?.close();
    await archive?.close();
  } finally {
    await postgres?.close();
    if ((!postgres && cleanupAllowed) || postgres?.stopped)
      await rm(root, { recursive: true, force: true });
  }
}
