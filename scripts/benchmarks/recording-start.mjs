// Deterministic admission benchmark; synthetic data only, no network or NAS data.
import { performance } from 'node:perf_hooks';
import { createSupervisor } from '../../build/apps/server/src/capture/supervisor.js';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const rows = Array.from({ length: 203 }, (_, index) => ({
  id: `stripchat:${index + 1}`,
  providerId: index + 1,
  handle: `synthetic-${index}`,
  monitorEnabled: true,
  autoRecord: false,
  providerStatus: 'PUBLIC',
  observedAtMs: Date.now(),
}));
const byId = new Map(rows.map((row) => [row.id, row]));
const simulatedStatusDelayMs = 150;
const simulatedCommitDelayMs = 20;
let committed, resolveCommit, deadline;
const ready = new Promise((resolve) => {
  resolveCommit = resolve;
});
let dispatchMs;
let statusCalls = 0;
const archive = {
  getSubject: async (id) => {
    const row = byId.get(id);
    return row ? { ...row } : null;
  },
  listSubjects: async () => rows.map((row) => ({ ...row })),
  setObservation: async (id, status, at) => {
    Object.assign(byId.get(id), { providerStatus: status, observedAtMs: at });
  },
  commit: async (input) => {
    await delay(simulatedCommitDelayMs);
    committed = performance.now();
    resolveCommit();
    return { ...input, id: 'synthetic' };
  },
};
const provider = {
  status: async () => {
    statusCalls++;
    await delay(simulatedStatusDelayMs);
    return 'PUBLIC';
  },
  capture: async (_subject, sink, signal) => {
    dispatchMs = performance.now();
    await sink.commit({});
    if (!signal.aborted)
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
  },
};
const supervisor = createSupervisor({ archive, provider, autoStart: false });
const started = performance.now();
rows[0].autoRecord = true;
try {
  if (supervisor.requestRecording) await supervisor.requestRecording([rows[0].id]);
  else await supervisor.reconcile();
  await Promise.race([
    ready,
    new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('benchmark-deadline')), 10000);
    }),
  ]);
  console.log(
    JSON.stringify({
      subjects: rows.length,
      simulatedStatusDelayMs,
      simulatedCommitDelayMs,
      statusCalls,
      dispatchMs: Math.round(dispatchMs - started),
      firstCommitMs: Math.round(committed - started),
      targeted: !!supervisor.requestRecording,
    }),
  );
} finally {
  clearTimeout(deadline);
  await supervisor.close();
}
