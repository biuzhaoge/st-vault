// Run in the QA image with --network none after linking compiled workspace dependencies.
// The benchmark owns a fresh PostgreSQL cluster with synthetic projections.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import Fastify from 'fastify';
import { Client } from 'pg';
import { openArchive } from '../../build/apps/server/src/archive/index.js';
import {
  EmbeddedPostgres,
  PostgresProcessesRunningError,
} from '../../build/apps/server/src/database/embedded.js';
import { databaseSchema } from '../../build/apps/server/src/database/sql.js';
import { registerWorkbench } from '../../build/apps/server/src/http/workbench.js';
import { getExecutionPolicy } from '../../build/apps/server/src/runtime/execution-policy.js';

const windowHours = Number(process.argv[3] ?? 12);
assert([12, 24, 168].includes(windowHours), 'Window hours must be 12, 24 or 168');
const minute = 60000,
  dayMinutes = Math.ceil((windowHours * 60 + 240) / 1440) * 1440,
  windowMs = windowHours * 60 * minute,
  firstMinute = Math.floor(Date.now() / minute) * minute - (dayMinutes + 1440) * minute,
  fixedFrom = firstMinute + 120 * minute,
  buckets = windowHours === 168 ? 720 : 360,
  subjectsPerGroup = 24,
  rowsPerBatch = 3,
  warmupRounds = 8,
  sampleRounds = Number(process.argv[2] ?? 40);
assert(
  Number.isInteger(sampleRounds) && sampleRounds >= 8 && sampleRounds <= 200,
  'Optional sample count must be an integer from 8 to 200',
);
const subjects = Array.from({ length: subjectsPerGroup * 3 }, (_, i) => ({
  id: `stripchat:${i + 1}`,
  providerId: i + 1,
  handle: `synthetic-${i + 1}`,
}));
const ids = subjects.map(({ id }) => id);
const groups = [
  { density: 'no-recording', ids: ids.slice(0, subjectsPerGroup) },
  { density: 'indexed-dense', ids: ids.slice(subjectsPerGroup, subjectsPerGroup * 2) },
  {
    density: 'indexed-dense-seen',
    ids: ids.slice(subjectsPerGroup * 2),
    workloads: ['coverage', 'same-window', 'max-batch'],
  },
];
const methods = ['coverage', 'statusHistory'];
const workloads = [
  'coverage',
  'statusHistory',
  'same-window',
  'row-scroll',
  'shifted-window',
  'four-concurrent',
  'max-batch',
];
const observedTables = [
  'coverage_minutes',
  'status_intervals',
  'recording_units',
  'unit_seen_ranges',
  'media_deletions',
];
const policy = getExecutionPolicy();
const workbenchOptions = {
  maxRequests: Math.max(4, Math.min(16, Math.floor(policy.networkConcurrency / 4))),
  rowConcurrency: 3,
  totalRowConcurrency: Math.max(
    3,
    Math.min(8, Math.floor(policy.database.interactiveConnections / 2)),
  ),
};

const round = (value) => Math.round(value * 1000) / 1000;
const sum = (values) => values.reduce((total, value) => total + value, 0);
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (rank) => round(sorted[Math.ceil(sorted.length * rank) - 1]);
  return {
    samples: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    total: round(sum(sorted)),
  };
}

function newRpcSamples() {
  return Object.fromEntries(methods.map((name) => [name, { roundTrip: [], worker: [] }]));
}
const originalPost = Worker.prototype.postMessage;
const workerMessages = new WeakMap();
let rpcSamples;
Worker.prototype.postMessage = function (message, ...transfer) {
  if (rpcSamples && methods.includes(message?.method)) {
    let pending = workerMessages.get(this);
    if (!pending) {
      pending = new Map();
      workerMessages.set(this, pending);
      this.on('message', (reply) => {
        const sent = pending.get(reply.id);
        if (!sent) return;
        pending.delete(reply.id);
        sent.samples.roundTrip.push(performance.now() - sent.at);
        sent.samples.worker.push(reply.executionMs);
      });
    }
    pending.set(message.id, { at: performance.now(), samples: rpcSamples[message.method] });
  }
  return originalPost.call(this, message, ...transfer);
};

async function seedProjections(client, schema) {
  await client.query('BEGIN');
  try {
    // These replay-format inserts populate only the fixture's indexed read models.
    await client.query(
      "SELECT set_config('search_path',$1,true),set_config('stv.replay','on',true)",
      [`${schema},public`],
    );
    const statuses = await client.query(
      `INSERT INTO status_intervals(subject,start,"end",status)
      SELECT subjects.id,$1::bigint+i::bigint*300000,$1::bigint+i::bigint*300000+240000,
        (ARRAY['PUBLIC','PRIVATE','OFFLINE'])[(i%3)+1]
      FROM subjects CROSS JOIN generate_series(0,$2::integer-1) AS seq(i)`,
      [firstMinute, dayMinutes / 5],
    );
    assert.equal(statuses.rowCount, subjects.length * (dayMinutes / 5));
    const segmentEdges = (shift) =>
      JSON.stringify(Array.from({ length: 30 }, (_, i) => i * 2000 + shift));
    const coverage = await client.query(
      `INSERT INTO coverage_minutes(subject,minute,spans,starts,ends,count,covered_ms,start_count,end_count)
      SELECT subjects.id,$1::bigint+i::bigint*60000,'[[0,60000]]',$2,$3,30,60000,30,30
      FROM subjects CROSS JOIN generate_series(0,$4::integer-1) AS seq(i)
      WHERE subjects.id=ANY($5::text[]) AND i%5<4`,
      [firstMinute, segmentEdges(0), segmentEdges(2000), dayMinutes, ids.slice(subjectsPerGroup)],
    );
    assert.equal(coverage.rowCount, (subjectsPerGroup * 2 * dayMinutes * 4) / 5);
    // Metadata-only segment membership makes these units visible to the seen query.
    // The other dense cohort keeps identical coverage minutes with no seen evidence.
    const seen = await client.query(
      `WITH units AS (
        INSERT INTO recording_units(id,subject,start,"end",sample,last_start,created_revision,closed)
        SELECT md5(subjects.id || ':' || i)::uuid::text,subjects.id,
          $1::bigint+i*1800000,$1::bigint+i*1800000+60000,
          $1::bigint+i*1800000,$1::bigint+i*1800000,0,1
        FROM subjects CROSS JOIN generate_series(0,$2::integer-1) AS seq(i)
        WHERE subjects.id=ANY($3::text[]) RETURNING id,subject,start,"end"
      ), segments AS (
        INSERT INTO segments(id,subject,epoch,sequence,media,start,"end",json)
        SELECT id,subject,'synthetic-seen',id,id,start,"end",'{}' FROM units RETURNING id
      ), membership AS (
        INSERT INTO unit_segments(segment,unit) SELECT id,id FROM segments RETURNING unit
      )
      INSERT INTO unit_seen_ranges(unit,subject,seen_at,seen_to)
      SELECT u.id,u.subject,u."end",u."end" FROM units u JOIN membership m ON m.unit=u.id
      WHERE (u.start-$1::bigint)%3600000=0`,
      [firstMinute, dayMinutes / 30, groups[2].ids],
    );
    assert.equal(seen.rowCount, (subjectsPerGroup * dayMinutes) / 60);
    await client.query(
      'ANALYZE subjects; ANALYZE coverage_minutes; ANALYZE status_intervals; ANALYZE recording_units; ANALYZE segments; ANALYZE unit_segments; ANALYZE unit_seen_ranges',
    );
    await client.query('COMMIT');
    return {
      coverageMinuteRows: coverage.rowCount,
      statusIntervalRows: statuses.rowCount,
      seenEvidenceRows: seen.rowCount,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function tableStats(client, schema) {
  const result = await client.query(
    `SELECT stats.relname,stats.idx_scan AS index_scans,stats.seq_scan AS sequential_scans,
      COALESCE(io.heap_blks_read,0)+COALESCE(io.idx_blks_read,0)+COALESCE(io.toast_blks_read,0)+COALESCE(io.tidx_blks_read,0) AS blocks_read,
      COALESCE(io.heap_blks_hit,0)+COALESCE(io.idx_blks_hit,0)+COALESCE(io.toast_blks_hit,0)+COALESCE(io.tidx_blks_hit,0) AS blocks_hit
    FROM pg_stat_user_tables stats JOIN pg_statio_user_tables io USING(relid)
    WHERE stats.schemaname=$1 AND stats.relname=ANY($2::text[])`,
    [schema, observedTables],
  );
  assert.equal(result.rowCount, observedTables.length);
  return Object.fromEntries(
    result.rows.map(({ relname, ...counters }) => [
      relname,
      Object.fromEntries(Object.entries(counters).map(([field, value]) => [field, Number(value)])),
    ]),
  );
}
function tableDelta(before, after) {
  return Object.fromEntries(
    Object.entries(after).map(([table, counters]) => [
      table,
      Object.fromEntries(
        Object.entries(counters).map(([field, count]) => [field, count - before[table][field]]),
      ),
    ]),
  );
}

function checkCoverage(coverage, from, group) {
  assert.equal(coverage.fromMs, from);
  assert.equal(coverage.toMs, from + windowMs);
  const coveredMs = sum(coverage.buckets.map((bucket) => bucket.coveredMs));
  assert.equal(coveredMs, group.density === 'no-recording' ? 0 : (windowMs * 4) / 5);
  assert.equal(coverage.seenSpans.length > 0, group.density === 'indexed-dense-seen');
}
function checkStatus(history, from) {
  assert.equal(history.fromMs, from);
  assert.equal(history.toMs, from + windowMs);
  const unknownMs = sum(history.buckets.map(({ durationsMs }) => durationsMs.UNKNOWN));
  assert.equal(unknownMs, windowMs / 5);
}

async function benchmark(archiveRoot, client, schema, group, workload) {
  const before = await tableStats(client, schema);
  const archive = await openArchive({ root: archiveRoot });
  const direct = methods.includes(workload);
  const clients = workload === 'four-concurrent' ? 4 : 1;
  const rows = direct ? 1 : workload === 'max-batch' ? subjectsPerGroup : rowsPerBatch;
  const waveMs = [],
    requestsMs = [],
    payloadBytes = [];
  const measured = newRpcSamples();
  let app;
  try {
    let origin;
    if (!direct) {
      app = Fastify();
      registerWorkbench(app, archive, workbenchOptions);
      origin = await app.listen({ host: '127.0.0.1', port: 0 });
    }
    const request = async (from, subjects) => {
      const started = performance.now();
      if (direct) {
        const result = await archive[workload](subjects[0], from, from + windowMs, buckets);
        const elapsed = performance.now() - started;
        assert.equal(result.subjectId, subjects[0]);
        assert.equal(result.buckets.length, buckets);
        if (workload === 'coverage') checkCoverage(result, from, group);
        else checkStatus(result, from);
        return { elapsed };
      }
      const query = new URLSearchParams({
        ids: subjects.join(','),
        from: String(from),
        to: String(from + windowMs),
        buckets: String(buckets),
      });
      const response = await fetch(`${origin}/api/workbench?${query}`, {
        signal: AbortSignal.timeout(15000),
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      const packet = JSON.parse(text);
      const elapsed = performance.now() - started;
      assert.deepEqual(
        packet.rows.map((row) => row.subjectId),
        subjects,
      );
      for (const row of packet.rows) {
        checkCoverage(row.coverage, from, group);
        checkStatus(row.status, from);
      }
      return { elapsed, bytes: Buffer.byteLength(text) };
    };
    for (let i = 0; i < warmupRounds + sampleRounds; i++) {
      const measuredRound = i >= warmupRounds;
      if (measuredRound) rpcSamples = measured;
      const from = workload === 'shifted-window' ? fixedFrom + (i + 1) * (minute / 2) : fixedFrom;
      const started = performance.now();
      const results = await Promise.all(
        Array.from({ length: clients }, (_, offset) => {
          const first =
            workload === 'row-scroll' || clients > 1 ? (i + offset) % group.ids.length : 0;
          const visible = Array.from(
            { length: rows },
            (_, index) => group.ids[(first + index) % group.ids.length],
          );
          return request(from, visible);
        }),
      );
      if (!measuredRound) continue;
      waveMs.push(performance.now() - started);
      for (const { elapsed, bytes } of results) {
        requestsMs.push(elapsed);
        if (bytes !== undefined) payloadBytes.push(bytes);
      }
    }
  } finally {
    rpcSamples = undefined;
    try {
      await app?.close();
    } finally {
      await archive.close();
    }
  }
  const rpc = {};
  for (const [method, samples] of Object.entries(measured)) {
    const expected = direct && method !== workload ? 0 : sampleRounds * clients * rows;
    assert.equal(samples.roundTrip.length, expected, `Unexpected RPC count for ${method}`);
    assert(samples.worker.every(Number.isFinite), `Missing Worker timing for ${method}`);
    if (expected > 0) {
      rpc[method] = {
        count: expected,
        roundTripMs: distribution(samples.roundTrip),
        workerMs: distribution(samples.worker),
        outsideWorkerMs: distribution(
          samples.roundTrip.map((elapsed, i) => Math.max(0, elapsed - samples.worker[i])),
        ),
      };
    }
  }
  return {
    density: group.density,
    workload,
    clients,
    rowsPerRequest: rows,
    requestMs: distribution(requestsMs),
    waveMs: distribution(waveMs),
    ...(payloadBytes.length ? { payloadBytes: distribution(payloadBytes) } : {}),
    rpc,
    // Closing the Archive flushes its PostgreSQL sessions before reading the cumulative stats.
    tableAccessIncludingWarmup: tableDelta(before, await tableStats(client, schema)),
  };
}

const root = await mkdtemp(path.join(tmpdir(), 'stv-workbench-cost-'));
const archiveRoot = path.join(root, 'archive');
let server,
  client,
  cleanupAllowed = true;
try {
  server = await EmbeddedPostgres.open({
    root: path.join(root, 'database'),
    binaries: process.env.STV_POSTGRES_BIN ?? '/usr/lib/postgresql/18/bin',
  });
  process.env.STV_DATABASE_SOCKET = String(server.connection.host);
  process.env.STV_DATABASE_PASSWORD = String(server.connection.password);
  client = new Client({ ...server.connection, application_name: 'stv-workbench-cost-observer' });
  await client.connect();
  const archive = await openArchive({ root: archiveRoot });
  let schema, rows;
  try {
    await archive.upsertSubjects(subjects);
    const manifest = JSON.parse(
      await readFile(path.join(archiveRoot, 'media', 'library.json'), 'utf8'),
    );
    schema = databaseSchema(path.join(archiveRoot, 'indexes', manifest.id));
    rows = await seedProjections(client, schema);
  } finally {
    await archive.close();
  }
  const results = [];
  for (const group of groups) {
    for (const workload of group.workloads ?? workloads)
      results.push(await benchmark(archiveRoot, client, schema, group, workload));
  }
  console.log(
    JSON.stringify({
      event: 'workbench_cost_benchmark',
      synthetic: true,
      node: process.version,
      postgres: (await client.query('SHOW server_version')).rows[0].server_version,
      blockBytes: Number((await client.query('SHOW block_size')).rows[0].block_size),
      cpu: policy.cpuCount,
      interactiveConnections: policy.database.interactiveConnections,
      workbenchOptions,
      fixture: {
        subjectsPerGroup,
        dayMinutes,
        windowHours,
        windowMs,
        buckets,
        protectionRequested: false,
        pendingDeletion: false,
        coverageFractionOfDenseWindow: 0.8,
        statusKnownFraction: 0.8,
        logicalSegmentsPerCoveredMinute: 30,
        ...rows,
      },
      warmupRounds,
      sampleRounds,
      results,
    }),
  );
} catch (error) {
  if (error instanceof PostgresProcessesRunningError) cleanupAllowed = false;
  throw error;
} finally {
  Worker.prototype.postMessage = originalPost;
  try {
    await client?.end();
  } finally {
    try {
      await server?.close();
    } finally {
      if (cleanupAllowed && (!server || server.stopped))
        await rm(root, { recursive: true, force: true });
    }
  }
}
