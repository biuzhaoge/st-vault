// Synthetic storage contention in an exact runtime image, with real Archive and HTTP routes.
// Mount only this script, a disposable /audit-scratch, and optional generated fMP4 fixtures.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { appendFile, chown, mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const seconds = Number(process.argv[2] ?? 1080);
assert(Number.isSafeInteger(seconds) && seconds >= 5 && seconds <= 3600, 'Invalid load duration');
const appRoot = process.env.STV_BENCH_APP_ROOT ?? '/app';
assert.equal(appRoot, '/app', 'Use the compiled runtime image');
const imported = (module) =>
  import(pathToFileURL(path.join(appRoot, 'apps/server/src', module)).href);
const scratch = process.env.STV_BENCH_SCRATCH;
assert.equal(scratch, '/audit-scratch', 'A dedicated scratch mount at /audit-scratch is required');
assert.equal(await realpath(scratch), scratch, 'Scratch cannot be a symlink');
const running = process.argv[3] === '--application';
assert(process.argv.length <= (running ? 4 : 3), 'Unexpected benchmark arguments');

const recorders = 21,
  monitored = 194,
  seedPerRecorder = 8,
  fragmentDurationMs = 2000,
  clipSize = Number(process.env.STV_BENCH_FRAGMENT_BYTES ?? 256 * 1024),
  minute = 60000,
  rates = { commit: 11, observation: monitored / 5, workbench: 2.38, media: 0.91, playback: 0.05 };
assert(
  Number.isSafeInteger(clipSize) && clipSize >= 16384 && clipSize <= 2 * 1024 * 1024,
  'Invalid synthetic fragment size',
);
const output = (event, fields) =>
  process.stdout.write(JSON.stringify({ event, at: new Date().toISOString(), ...fields }) + '\n');
const subjects = Array.from({ length: monitored }, (_, index) => ({
  id: `stripchat:${index + 1}`,
  providerId: index + 1,
  handle: `synthetic-${index + 1}`,
}));

async function loadSegments() {
  const fixture = process.env.STV_BENCH_FIXTURE;
  if (!fixture) return { kind: 'opaque-payload', init: null, fragments: [Buffer.alloc(0)] };
  assert.equal(fixture, '/audit-fixture');
  assert.equal(await realpath(fixture), fixture);
  const playlist = await readFile(path.join(fixture, 'stream.m3u8'), 'utf8');
  const names = [...playlist.matchAll(/^seg\d+\.m4s$/gm)].map(([name]) => name);
  assert(names.length > 0 && names.length <= 20, 'Expected local generated fMP4 fragments');
  return {
    kind: 'generated-fmp4',
    init: await readFile(path.join(fixture, 'init.mp4')),
    fragments: await Promise.all(names.map((name) => readFile(path.join(fixture, name)))),
  };
}

function makeBytes(fragment, unique) {
  // The valid free box retains fixture decodability and makes every object distinct.
  const size = Math.max(clipSize, fragment.length + 16);
  const result = Buffer.allocUnsafe(size);
  fragment.copy(result);
  const offset = fragment.length;
  result.writeUInt32BE(size - offset, offset);
  result.write('free', offset + 4, 'ascii');
  result.writeBigUInt64BE(BigInt(unique), offset + 8);
  let state = (unique ^ 0xa5366b4d) | 0;
  for (let index = offset + 16; index + 4 <= size; index += 4) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    result.writeUInt32LE(state >>> 0, index);
  }
  result.fill(0, size - ((size - offset - 16) % 4));
  return result;
}

const round = (value) => Math.round(value * 1000) / 1000;
// The incident accepted eleven delete requests between about minutes 3 and 14.
// Compress the cadence for a smoke test so it exercises the same API and worker.
const deletionOffsets = (
  seconds <= 30
    ? [1000, 3500]
    : [175, 227, 300, 365, 403, 492, 540, 601, 665, 740, 811].map((sec) => sec * 1000)
).filter((offset) => offset < seconds * 1000);
const historySegments = 32;

function timings(values) {
  if (!values.length) return { samples: 0 };
  const sorted = values.toSorted((a, b) => a - b);
  const percent = (fraction) => round(sorted[Math.ceil(sorted.length * fraction) - 1]);
  return {
    samples: sorted.length,
    p50: percent(0.5),
    p95: percent(0.95),
    p99: percent(0.99),
    max: round(sorted.at(-1)),
  };
}

function errorCode(error) {
  if (typeof error?.code === 'string' && /^[A-Z0-9_]{2,60}$/.test(error.code)) return error.code;
  if (typeof error?.message === 'string' && /^[A-Z0-9_]{2,60}$/.test(error.message))
    return error.message;
  return error?.name === 'TimeoutError' ? 'TIMEOUT' : 'OTHER';
}

async function startLauncher() {
  const [
    { initializeState, dropRuntimePrivileges },
    { EmbeddedPostgres },
    { superviseApplication },
    { getExecutionPolicy },
  ] = await Promise.all([
    imported('deploy/init.js'),
    imported('database/embedded.js'),
    imported('deploy/processes.js'),
    imported('runtime/execution-policy.js'),
  ]);
  const root = await mkdtemp(path.join(scratch, 'stv-recording-workbench-'));
  const identity = { uid: 1000, gid: 1000 };
  const data = path.join(root, 'data'),
    media = path.join(root, 'media');
  await chown(root, identity.uid, identity.gid);
  await initializeState(data, identity, media);
  dropRuntimePrivileges(identity);
  const binaries = process.env.STV_POSTGRES_BIN ?? '/usr/lib/postgresql/18/bin';
  const database = await EmbeddedPostgres.open({
    root: data,
    binaries,
    nssWrapper: '/usr/local/lib/libnss_wrapper.so',
  });
  try {
    await configurePostgresEvidence(database.connection, data, binaries);
  } catch (error) {
    await database.close();
    throw error;
  }
  const execution = getExecutionPolicy();
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), String(seconds), '--application'],
    {
      cwd: appRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        STV_BENCH_RUN_ROOT: root,
        STV_DATA_DIR: data,
        STV_MEDIA_DIR: media,
        STV_DATABASE_SOCKET: String(database.connection.host),
        STV_DATABASE_PASSWORD: String(database.connection.password),
        NODE_OPTIONS:
          process.env.NODE_OPTIONS?.trim() || `--max-old-space-size=${execution.nodeHeapMb}`,
        UV_THREADPOOL_SIZE:
          process.env.UV_THREADPOOL_SIZE?.trim() || String(execution.ioConcurrency),
      },
    },
  );
  process.exitCode = await superviseApplication(child, database);
}

async function configurePostgresEvidence(connection, data, binaries) {
  const cluster = path.join(data, 'postgres', '18');
  const socket = String(connection.host);
  assert(/^\/tmp\/stv-postgres-[A-Za-z0-9]+$/.test(socket), 'Expected a fresh benchmark socket');
  await appendFile(
    path.join(socket, 'postgresql.conf'),
    [
      "log_line_prefix='%m [%p] %b %e '",
      'log_error_verbosity=verbose',
      'log_checkpoints=on',
      '',
    ].join('\n'),
  );
  await new Promise((resolve, reject) => {
    const reload = spawn(path.join(binaries, 'pg_ctl'), ['reload', '-D', cluster], {
      stdio: 'inherit',
    });
    reload.once('error', reject);
    reload.once('exit', (code) =>
      code === 0 ? resolve() : reject(Error('BENCHMARK_LOG_RELOAD_FAILED')),
    );
  });
  const pid = Number((await readFile(path.join(cluster, 'postmaster.pid'), 'utf8')).split('\n')[0]);
  assert(Number.isSafeInteger(pid) && pid > 1);
  const { Client } = createRequire(path.join(appRoot, 'apps/server/package.json'))('pg');
  const client = new Client({ ...connection, application_name: 'recording-workbench-audit' });
  try {
    await client.connect();
    const names = [
      'log_line_prefix',
      'log_error_verbosity',
      'log_checkpoints',
      'fsync',
      'synchronous_commit',
      'full_page_writes',
      'data_sync_retry',
      'io_method',
    ];
    const sql = 'SELECT name, setting FROM pg_settings WHERE name = ANY($1::text[])';
    const deadline = performance.now() + 3000;
    for (;;) {
      const { rows } = await client.query(sql, [names]);
      const settings = Object.fromEntries(rows.map(({ name, setting }) => [name, setting]));
      if (
        settings.log_error_verbosity === 'verbose' &&
        settings.log_line_prefix?.includes('%b %e')
      ) {
        output('recording_workbench_postgres_started', {
          synthetic: true,
          postmasterPid: pid,
          settings,
        });
        return;
      }
      if (performance.now() >= deadline) throw Error('BENCHMARK_LOG_CONFIGURATION_UNVERIFIED');
      await delay(50);
    }
  } finally {
    await client.end();
  }
}

async function startApplication() {
  const root = process.env.STV_BENCH_RUN_ROOT;
  assert(
    typeof root === 'string' &&
      /^\/audit-scratch\/stv-recording-workbench-[A-Za-z0-9]+$/.test(root),
  );
  assert.equal(await realpath(root), root);
  const data = path.join(root, 'data'),
    media = path.join(root, 'media'),
    logs = path.join(root, 'logs');
  await mkdir(logs);
  const [
    { openArchive },
    { buildApp },
    { LocalAuth },
    { KeyVault },
    { installRuntimeLogs, closeRuntimeLogs, logContext },
    { getExecutionPolicy },
    { MediaBudget },
  ] = await Promise.all([
    imported('archive/index.js'),
    imported('http/app.js'),
    imported('http/auth.js'),
    imported('http/key-vault.js'),
    imported('runtime/runtime-logs.js'),
    imported('runtime/execution-policy.js'),
    imported('provider/media-budget.js'),
  ]);
  const fixture = await loadSegments();
  installRuntimeLogs(logs, 'app');
  const execution = getExecutionPolicy();
  const archive = await openArchive({ root: data, mediaRoot: media });
  const stored = Array.from({ length: recorders }, () => []);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const originMs = Math.floor(Date.now() / minute) * minute - 2 * minute;
  let app, run;
  let measuring = false;
  const queues = { acquisitionMs: [], waits: 0, peakWaiting: 0 };
  const acquire = MediaBudget.prototype.acquire;
  MediaBudget.prototype.acquire = async function (signal) {
    if (!measuring || !logContext.getStore()) return acquire.call(this, signal);
    // Workbench is the only MediaBudget owner exercised by these routes.
    const before = this.stats();
    const queued = before.active >= before.limit;
    const at = performance.now();
    try {
      if (queued) {
        queues.waits++;
        queues.peakWaiting = Math.max(queues.peakWaiting, before.waiting + 1);
      }
      return await acquire.call(this, signal);
    } finally {
      queues.acquisitionMs.push(performance.now() - at);
    }
  };
  let mediaFallback = 0;
  const historyStart = originMs - 45 * minute;
  const deletionIds = [];
  const makeSegment = async (recording, sequence, historical = false) => {
    const unique = (sequence + (historical ? 100000 : 0)) * recorders + recording + 1;
    const fragment = fixture.fragments[sequence % fixture.fragments.length];
    const bytes = makeBytes(fragment, unique);
    const segment = await archive.commit({
      subjectId: subjects[recording].id,
      sourceEpoch: historical ? 'synthetic-history' : 'synthetic-recording',
      sourceSequence: String(sequence),
      init: fixture.init,
      bytes,
      wallStartMs: historical
        ? historyStart + sequence * fragmentDurationMs
        : originMs + (sequence - seedPerRecorder) * fragmentDurationMs,
      durationSeconds: fragmentDurationMs / 1000,
      timeBasis: 'source-pdt',
      uncertaintyMs: 0,
      discontinuity: false,
    });
    if (!historical) stored[recording][sequence] = { segment, bytes: bytes.length };
    return { bytes: bytes.length };
  };

  try {
    await archive.upsertSubjects(subjects, { syncAccount: true });
    await archive.setPolicies(
      subjects.slice(0, recorders).map(({ id }) => id),
      { autoRecord: true },
    );
    if (deletionOffsets.length) {
      run = await archive.startRun(historyStart);
      for (let sequence = 0; sequence < historySegments; sequence++) {
        await Promise.all(
          deletionOffsets.map((_, recorder) => makeSegment(recorder, sequence, true)),
        );
      }
      await archive.stopRun(run, 'normal', historyStart + historySegments * fragmentDurationMs);
    }
    run = await archive.startRun();
    for (let sequence = 0; sequence < seedPerRecorder; sequence++) {
      await Promise.all(stored.map((_, recorder) => makeSegment(recorder, sequence)));
    }
    let seenUnits = 0;
    for (let recorder = 0; recorder < recorders; recorder += 2) {
      const id = subjects[recorder].id;
      const page = await archive.timeline(
        id,
        originMs - seedPerRecorder * fragmentDurationMs,
        originMs,
        100,
      );
      const seen = new Map();
      for (const segment of page.segments) {
        if (segment.recordingUnitId)
          seen.set(segment.recordingUnitId, {
            unitId: segment.recordingUnitId,
            toMs: segment.wallEndMs,
          });
      }
      if (seen.size) {
        const marked = await archive.markUnitsSeen(id, [...seen.values()]);
        seenUnits += marked.changed;
      }
    }
    assert(seenUnits > 0, 'Expected synthetic playback evidence');

    const auth = await LocalAuth.open(archive);
    const pin = String(randomInt(100000, 1000000));
    const session = await auth.completeSetup(pin, await auth.beginSetup());
    const cookie = auth.cookie(session, false).split(';')[0];
    const noop = async () => {};
    app = await buildApp({
      archive,
      vault: await KeyVault.open(data, archive),
      provider: { importList: async () => subjects, status: async () => 'PUBLIC', capture: noop },
      supervisor: { reconcile: noop, states: () => ({}), close: noop },
      live: { close: noop },
      previews: { close: noop },
    });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const request = async (route, options = {}) => {
      const response = await fetch(address + route, {
        ...options,
        headers: { cookie, ...options.headers },
        signal: AbortSignal.timeout(20000),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!response.ok) throw Error(`HTTP_${response.status}`);
      return { response, bytes };
    };
    const submit = (route, value) =>
      request(route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(value),
      });

    const workbench = async (index) => {
      const recorder = index % recorders;
      const first = (index * 2) % (monitored - recorders - 1);
      const ids = [
        subjects[recorder].id,
        subjects[recorders + first].id,
        subjects[recorders + first + 1].id,
      ];
      const shift = (index % 5) * 30000;
      const to = originMs + Math.ceil(seconds / 60 + 4) * minute + shift;
      const from = to - 12 * 60 * minute;
      const query = new URLSearchParams({ ids: ids.join(','), from, to, buckets: 360 });
      const { bytes } = await request(`/api/workbench?${query}`);
      const result = JSON.parse(bytes);
      assert(result.rows.length === 3 && result.rows[0].coverage.buckets.length > 0);
      return { bytes: bytes.length, rows: result.rows.length };
    };
    const mediaRead = async (index, offset) => {
      const recorder = index % recorders;
      const nominal = Math.floor(((offset - 5000) * rates.commit) / (1000 * recorders));
      let clip = stored[recorder][seedPerRecorder + nominal];
      if (nominal < 0 || !clip) {
        if (nominal >= 0) mediaFallback++;
        clip = stored[recorder][index % seedPerRecorder];
      }
      const range = index % 5 === 0;
      const { response, bytes } = await request(`/api/media/${clip.segment.mediaObjectId}`, {
        headers: range ? { range: 'bytes=0-65535' } : {},
      });
      assert.equal(response.status, range ? 206 : 200);
      assert.equal(bytes.length, range ? Math.min(65536, clip.bytes) : clip.bytes);
      return { bytes: bytes.length };
    };
    const playback = async (index) => {
      const clip = stored[(index * 11) % recorders][0].segment;
      const opened = await submit('/api/playback', {
        subjectId: clip.subjectId,
        targetUtcMs: clip.wallStartMs,
        gapPolicy: 'report',
      });
      const { sessionId, manifestUrl } = JSON.parse(opened.bytes);
      try {
        const manifest = await request(manifestUrl);
        assert(manifest.bytes.toString().startsWith('#EXTM3U'));
        assert(manifest.bytes.toString().includes(clip.mediaObjectId));
        return { bytes: opened.bytes.length + manifest.bytes.length };
      } finally {
        await submit(`/api/playback/${sessionId}/close`, {});
      }
    };
    const deleteHistory = async (recorder) => {
      const commandId = randomUUID();
      const { response, bytes } = await submit(
        `/api/subjects/${subjects[recorder].id}/deletion-intents`,
        {
          commandId,
          target: {
            kind: 'range',
            mode: 'all',
            fromMs: historyStart,
            toMs: historyStart + historySegments * fragmentDurationMs,
          },
        },
      );
      assert.equal(response.status, 202);
      assert.equal(JSON.parse(bytes).id, commandId);
      deletionIds.push(commandId);
      return { bytes: bytes.length };
    };
    const observation = (index, offset) => {
      const subjectIndex = index % monitored;
      const rotation = Math.floor((index / monitored + subjectIndex * 17) / 64);
      const status =
        subjectIndex < recorders ? 'PUBLIC' : ['OFFLINE', 'PRIVATE', 'PUBLIC'][rotation % 3];
      return archive.setObservation(
        subjects[subjectIndex].id,
        status,
        originMs + Math.floor(offset),
        20000,
      );
    };
    const actions = {
      commit: (index) =>
        makeSegment(index % recorders, seedPerRecorder + Math.floor(index / recorders)),
      observation,
      workbench,
      media: mediaRead,
      playback,
      deletion: deleteHistory,
    };
    // Open the real routes and media before starting the timed schedule.
    await workbench(0);
    await playback(0);
    await mediaRead(0, 0);
    await trace({
      actions,
      controller,
      queues,
      seenUnits,
      execution,
      fixture,
      mediaFallback: () => mediaFallback,
      startMeasuring: () => {
        measuring = true;
      },
      stopMeasuring: () => {
        measuring = false;
      },
    });
    if (!controller.signal.aborted && deletionIds.length) {
      const deadline = performance.now() + 15000;
      for (;;) {
        const jobs = (await archive.deletionJobs()).filter(({ id }) => deletionIds.includes(id));
        const completed =
          jobs.length === deletionIds.length && jobs.every(({ state }) => state === 'completed');
        if (completed || performance.now() >= deadline) {
          const jobEvidence = jobs.map(({ state, processed, total }) => ({
            state,
            processed,
            total,
          }));
          output('recording_workbench_deletion_results', {
            accepted: deletionIds.length,
            jobs: jobEvidence,
          });
          assert.equal(jobs.length, deletionIds.length);
          assert(jobs.every(({ state, processed }) => state === 'completed' && processed > 0));
          break;
        }
        await delay(500);
      }
    }
  } finally {
    MediaBudget.prototype.acquire = acquire;
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    try {
      await app?.close();
    } finally {
      try {
        if (run) await archive.stopRun(run, 'normal');
      } finally {
        try {
          await archive.close();
        } finally {
          await closeRuntimeLogs();
        }
      }
    }
  }
}

async function trace({
  actions,
  controller,
  queues,
  seenUnits,
  execution,
  fixture,
  mediaFallback,
  startMeasuring,
  stopMeasuring,
}) {
  const limits = {
    commit: 84,
    observation: 96,
    workbench: 32,
    media: 24,
    playback: 4,
    deletion: 4,
  };
  const lanes = Object.fromEntries(
    Object.keys(actions).map((kind) => [
      kind,
      {
        offered: kind === 'deletion' ? deletionOffsets.length : Math.ceil(rates[kind] * seconds),
        started: 0,
        completed: 0,
        dropped: 0,
        active: 0,
        peakActive: 0,
        failure: new Map(),
        latency: [],
        issueDelay: [],
        bytes: 0,
        rows: 0,
      },
    ]),
  );
  const events = Object.entries(rates)
    .flatMap(([kind, rate]) =>
      Array.from({ length: lanes[kind].offered }, (_, index) => ({
        kind,
        index,
        offset: (index * 1000) / rate,
      })),
    )
    .concat(deletionOffsets.map((offset, index) => ({ kind: 'deletion', index, offset })))
    .sort((left, right) => left.offset - right.offset);
  const pending = new Set();
  const began = performance.now();
  let lastProgress = began;
  const snapshot = () => ({
    elapsedSeconds: round((performance.now() - began) / 1000),
    lanes: Object.fromEntries(
      Object.entries(lanes).map(([kind, lane]) => [
        kind,
        {
          offered: lane.offered,
          started: lane.started,
          completed: lane.completed,
          droppedAtDriverCap: lane.dropped,
          active: lane.active,
          peakActive: lane.peakActive,
          failed: Object.fromEntries(lane.failure),
          bytes: lane.bytes,
          rows: lane.rows,
          httpOrCommitMs: timings(lane.latency),
          driverIssueDelayMs: timings(lane.issueDelay),
        },
      ]),
    ),
    workbenchRows: {
      waiterCount: queues.waits,
      peakWaiting: queues.peakWaiting,
      acquisitionMs: timings(queues.acquisitionMs),
    },
    mediaFallback: mediaFallback(),
  });
  output('recording_workbench_trace_start', {
    synthetic: true,
    requestedSeconds: seconds,
    rates,
    recorders,
    monitored,
    observationPeriodMs: 5000,
    seedSegments: recorders * seedPerRecorder,
    historicalSegments: deletionOffsets.length * historySegments,
    deletionOffsets,
    seenUnits,
    fixture: fixture.kind,
    baseFragmentBytes: fixture.fragments.map((bytes) => bytes.length),
    minFragmentBytes: clipSize,
    workbenchRows: 3,
    workbenchBuckets: 360,
    workbenchHours: 12,
    execution,
  });
  startMeasuring();
  try {
    for (const { kind, index, offset } of events) {
      if (controller.signal.aborted) break;
      const due = began + offset;
      const wait = due - performance.now();
      if (wait > 0) await delay(wait);
      if (controller.signal.aborted) break;
      const lane = lanes[kind];
      if (lane.active >= limits[kind]) {
        lane.dropped++;
        continue;
      }
      const started = performance.now();
      lane.started++;
      lane.active++;
      lane.peakActive = Math.max(lane.peakActive, lane.active);
      lane.issueDelay.push(started - due);
      const operation = Promise.resolve()
        .then(() => actions[kind](index, offset))
        .then(
          (result) => {
            lane.completed++;
            lane.bytes += result?.bytes ?? 0;
            lane.rows += result?.rows ?? 0;
          },
          (error) => {
            const code = errorCode(error);
            const failures = (lane.failure.get(code) ?? 0) + 1;
            lane.failure.set(code, failures);
            if (failures === 1)
              output('recording_workbench_operation_failure', { kind, code, index });
          },
        )
        .finally(() => {
          lane.active--;
          lane.latency.push(performance.now() - started);
          pending.delete(operation);
        });
      pending.add(operation);
      if (started - lastProgress >= 30000) {
        lastProgress = started;
        output('recording_workbench_progress', snapshot());
      }
    }
    const liveSeconds = (performance.now() - began) / 1000;
    await Promise.all(pending);
    const stats = snapshot();
    output('recording_workbench_trace_complete', {
      ...stats,
      liveSeconds: round(liveSeconds),
      interrupted: controller.signal.aborted,
      completedRates: Object.fromEntries(
        Object.entries(lanes).map(([kind, lane]) => [kind, round(lane.completed / liveSeconds)]),
      ),
    });
    if (
      !controller.signal.aborted &&
      (seconds <= 30 || process.env.STV_BENCH_STRICT === '1') &&
      Object.values(lanes).some((lane) => lane.completed !== lane.offered)
    )
      throw Error('SYNTHETIC_TRACE_INCOMPLETE');
  } finally {
    stopMeasuring();
  }
}

if (running) await startApplication();
else await startLauncher();
