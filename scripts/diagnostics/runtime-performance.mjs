// Reads runtime JSONL from stdin and emits a shareable summary of this log slice.
import { createInterface } from 'node:readline';

const captureCounts = [
  'sweeps',
  'failedSweeps',
  'skippedClockRuns',
  'coalescedReconciles',
  'capacityLimitedSweeps',
  'deadlineLimitedSweeps',
  'disabledCandidates',
  'pendingCandidates',
  'observations',
  'cacheHits',
  'sharedObservations',
  'unknownObservations',
  'upstreamCalls',
  'upstreamRetries',
  'admissionDeadlines',
  'upstreamDeadlines',
  'persistenceFailures',
];
const capturePhases = [
  'inventory',
  'policyRecheck',
  'admission',
  'upstream',
  'persist',
  'sweep',
  'tail',
  'rotation',
];
const captureWindowFields = ['monitored', 'sweepBudgetMs', 'sweepWorkers', 'windowMs'];
const workbenchRows = ['rowsRequested', 'rowsAdmitted', 'rowsBuilt', 'rowsCancelledWhileWaiting'];
const workbenchDurations = ['maxRowQueueMs', 'maxArchiveReadMs', 'elapsedMs', 'drainMs'];
const abortSources = ['client', 'shutdown', 'read-error'];
const metadataMethods = [
  'apply',
  'buildRecordingUnits',
  'coverage',
  'events',
  'head',
  'list',
  'observation',
  'snapshotForSegment',
  'snapshotPages',
  'snapshotUnit',
  'snapshotUnits',
  'statusHistory',
  'storageStatus',
  'subject',
  'syncRevisions',
  'unitBounds',
];
const databaseLanes = ['interactive', 'background', 'playback', 'writer', 'snapshot'];
const logLossEvents = ['log_queue_overflow', 'log_stdout_overflow', 'log_persistence_recovered'];
const correlatedEvents = [
  'workbench_batch_timing',
  'metadata_rpc_slow',
  'database_pool_wait',
  'database_query_slow',
];
const events = zeros([
  'capture_polling',
  ...correlatedEvents,
  'metadata_read_busy',
  ...logLossEvents,
]);
const capture = { totals: zeros(captureCounts), endOfWindow: {}, timings: {} };
const workbench = { rows: zeros(workbenchRows), cancellations: zeros(abortSources), maximaMs: {} };
const slow = { metadata: {}, pool: {}, sql: {} };
const logLoss = zeros(logLossEvents);
const byRequest = new Map();
let lines = 0,
  ignoredLines = 0,
  first = Infinity,
  last = -Infinity;

function zeros(keys) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function addCounts(target, entry) {
  for (const key of Object.keys(target)) {
    if (validCount(entry?.[key])) target[key] += entry[key];
  }
}

function recordMaxima(target, entry, fields) {
  for (const key of fields) {
    const value = entry[key];
    if (Number.isFinite(value) && value >= 0) target[key] = Math.max(target[key] ?? 0, value);
  }
}

function recordCapture(entry) {
  addCounts(capture.totals, entry.counts);
  for (const key of captureWindowFields) {
    const value = entry[key];
    if (!validCount(value)) continue;
    const range = (capture.endOfWindow[key] ??= { min: value, max: value });
    range.min = Math.min(range.min, value);
    range.max = Math.max(range.max, value);
  }
  for (const phase of capturePhases) {
    const timing = entry.timings?.[phase];
    if (!validCount(timing?.count) || timing.count === 0) continue;
    const aggregate = (capture.timings[phase] ??= { count: 0 });
    aggregate.count += timing.count;
    // These quantiles describe separate windows. Keep only their highest bound.
    recordMaxima(aggregate, { maxMs: timing.maxMs, highestWindowP95UpperMs: timing.p95UpperMs }, [
      'maxMs',
      'highestWindowP95UpperMs',
    ]);
  }
}

function recordSample(target, group, allowedGroups, entry, fields) {
  const key = allowedGroups.includes(group) ? group : 'other';
  const sample = (target[key] ??= { samples: 0, maximaMs: {} });
  sample.samples++;
  recordMaxima(sample.maximaMs, entry, fields);
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  lines++;
  let entry;
  try {
    entry = JSON.parse(line.trim());
  } catch {
    ignoredLines++;
    continue;
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    ignoredLines++;
    continue;
  }
  const at = typeof entry.at === 'string' ? Date.parse(entry.at) : NaN;
  if (Number.isFinite(at)) {
    first = Math.min(first, at);
    last = Math.max(last, at);
  }
  const event = entry.event;
  if (typeof event !== 'string' || !Object.hasOwn(events, event)) continue;
  events[event]++;
  const requestId = entry.requestId ?? entry.reqId;
  if (correlatedEvents.includes(event) && typeof requestId === 'string' && requestId.length) {
    const matches = byRequest.get(requestId) ?? new Set();
    matches.add(event);
    byRequest.set(requestId, matches);
  }
  if (event === 'capture_polling') recordCapture(entry);
  else if (event === 'workbench_batch_timing') {
    addCounts(workbench.rows, entry);
    recordMaxima(workbench.maximaMs, entry, workbenchDurations);
    if (abortSources.includes(entry.abortSource)) workbench.cancellations[entry.abortSource]++;
  } else if (event === 'metadata_rpc_slow') {
    recordSample(slow.metadata, entry.method, metadataMethods, entry, [
      'rpcElapsedMs',
      'workerExecutionMs',
      'workerHandlerMs',
      'workerBarrierMs',
      'rpcNonExecutionMs',
    ]);
  } else if (event === 'database_pool_wait') {
    recordSample(slow.pool, entry.lane, databaseLanes, entry, ['waitMs']);
  } else if (event === 'database_query_slow') {
    recordSample(slow.sql, entry.lane, databaseLanes, entry, ['executionMs']);
  } else if (logLossEvents.includes(event) && validCount(entry.dropped)) {
    logLoss[event] += entry.dropped;
  }
}

const correlation = { workbenchWithId: 0, metadata: 0, pool: 0, sql: 0 };
for (const matches of byRequest.values()) {
  if (!matches.has('workbench_batch_timing')) continue;
  correlation.workbenchWithId++;
  if (matches.has('metadata_rpc_slow')) correlation.metadata++;
  if (matches.has('database_pool_wait')) correlation.pool++;
  if (matches.has('database_query_slow')) correlation.sql++;
}

const iso = (at) => (Number.isFinite(at) ? new Date(at).toISOString() : null);
console.log(
  JSON.stringify(
    {
      input: { lines, ignoredLines, firstAt: iso(first), lastAt: iso(last) },
      events,
      logLoss,
      capture: events.capture_polling ? capture : null,
      workbench: events.workbench_batch_timing ? workbench : null,
      slow,
      correlation,
    },
    null,
    2,
  ),
);
