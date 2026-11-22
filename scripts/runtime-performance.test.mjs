import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./diagnostics/runtime-performance.mjs', import.meta.url));

function report(...lines) {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    input: lines
      .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
      .join('\r\n'),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /private-fixture|a-request-id|b-request-id/);
  return JSON.parse(result.stdout);
}

test('summarizes capture windows without recomputing a percentile across windows', () => {
  const base = { event: 'capture_polling', sweepBudgetMs: 5000, sweepWorkers: 4 };
  const summary = report(
    {
      ...base,
      at: '2026-11-19T10:00:00Z',
      monitored: 80,
      counts: { sweeps: 5, skippedClockRuns: 1 },
      timings: { sweep: { count: 5, maxMs: 890, p95UpperMs: 890 } },
    },
    {
      ...base,
      at: '2026-11-19T10:01:00Z',
      monitored: 84,
      counts: { sweeps: 7, deadlineLimitedSweeps: 2, skippedClockRuns: 3 },
      timings: { sweep: { count: 7, maxMs: 5100, p95UpperMs: 5100 } },
    },
  );
  assert.equal(summary.events.capture_polling, 2);
  assert.equal(summary.capture.totals.sweeps, 12);
  assert.equal(summary.capture.totals.skippedClockRuns, 4);
  assert.equal(summary.capture.totals.deadlineLimitedSweeps, 2);
  assert.deepEqual(summary.capture.endOfWindow.monitored, { min: 80, max: 84 });
  assert.deepEqual(summary.capture.timings.sweep, {
    count: 12,
    maxMs: 5100,
    highestWindowP95UpperMs: 5100,
  });
  assert.equal(summary.input.firstAt, '2026-11-19T10:00:00.000Z');
  assert.equal(summary.input.lastAt, '2026-11-19T10:01:00.000Z');
});

test('links sampled workbench events by exact request ID and emits only known fields', () => {
  const summary = report(
    {
      event: 'database_query_slow',
      requestId: 'b-request-id',
      lane: 'background',
      executionMs: 700,
    },
    { event: 'database_pool_wait', requestId: 'a-request-id', lane: 'interactive', waitMs: 130 },
    {
      event: 'metadata_rpc_slow',
      requestId: 'a-request-id',
      method: 'coverage',
      rpcElapsedMs: 812.5,
      query: 'private-fixture',
    },
    {
      event: 'workbench_batch_timing',
      reqId: 'a-request-id',
      rowsRequested: 24,
      rowsAdmitted: 1,
      rowsCancelledWhileWaiting: 2,
      elapsedMs: 850,
      abortSource: 'client',
      drainMs: 161,
    },
    { event: 'metadata_rpc_slow', method: 'private-fixture', rpcElapsedMs: 500 },
  );
  assert.deepEqual(summary.correlation, { workbenchWithId: 1, metadata: 1, pool: 1, sql: 0 });
  assert.equal(summary.workbench.rows.rowsRequested, 24);
  assert.equal(summary.workbench.rows.rowsAdmitted, 1);
  assert.equal(summary.workbench.rows.rowsCancelledWhileWaiting, 2);
  assert.equal(summary.workbench.cancellations.client, 1);
  assert.equal(summary.workbench.maximaMs.drainMs, 161);
  assert.equal(summary.slow.metadata.coverage.maximaMs.rpcElapsedMs, 812.5);
  assert.equal(summary.slow.metadata.other.samples, 1);
  assert.equal(summary.slow.sql.background.samples, 1);
});

test('reports legacy samples when current capture and workbench records are absent', () => {
  const summary = report(
    'postgres startup message private-fixture',
    '{"truncated":',
    { event: 'metadata_rpc_slow', method: 'list', rpcElapsedMs: 550, workerHandlerMs: '600' },
    { event: 'log_stdout_overflow', dropped: 4 },
  );
  assert.equal(summary.input.lines, 4);
  assert.equal(summary.input.ignoredLines, 2);
  assert.equal(summary.events.metadata_rpc_slow, 1);
  assert.equal(summary.logLoss.log_stdout_overflow, 4);
  assert.equal(summary.capture, null);
  assert.equal(summary.workbench, null);
  assert.equal(summary.correlation.workbenchWithId, 0);
  assert.deepEqual(summary.slow.metadata.list.maximaMs, { rpcElapsedMs: 550 });
});
