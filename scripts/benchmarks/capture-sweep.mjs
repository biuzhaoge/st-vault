// Run after npm run build in the QA container. Virtual time with synthetic ports.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { setImmediate as settle } from 'node:timers/promises';
import { createSupervisor } from '../../build/apps/server/src/capture/supervisor.js';
import { StatusEvidence } from '../../build/apps/server/src/provider/status-evidence.js';
import { SyncClock } from '../../build/apps/server/src/runtime/sync-clock.js';

const monitored = 203;
const epoch = 1_700_000_000_000;
const sampleMs = 180_000;
const stepMs = 5;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const advance = async (ms) => {
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    mock.timers.tick(stepMs);
    await settle();
  }
};

async function measure({ scenario, pollMs, slots, viewers, slowSubjects, writeMs }) {
  const rows = Array.from({ length: monitored + viewers }, (_, i) => ({
    id: `stripchat:${i + 1}`,
    providerId: i + 1,
    handle: `synthetic-${i + 1}`,
    monitorEnabled: i < monitored,
    autoRecord: false,
    providerStatus: 'PUBLIC',
    observedAtMs: null,
  }));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const admitted = new Set();
  const confirmations = new Map();
  let statusCalls = 0;
  let active = 0;
  let peakActive = 0;
  let maxDurableGapMs = null;
  let minDurableLeaseSlackMs = null;
  let writing = Promise.resolve();
  const archive = {
    listSubjects: async () => rows.map((row) => ({ ...row })),
    setObservation(id, status, at, lease) {
      writing = writing.then(async () => {
        await pause(writeMs);
        const row = byId.get(id);
        Object.assign(row, { providerStatus: status, observedAtMs: at });
        if (!row.monitorEnabled || status !== 'PUBLIC') return;
        const ackAt = Date.now();
        const last = confirmations.get(id);
        if (last) {
          maxDurableGapMs = Math.max(maxDurableGapMs ?? 0, ackAt - last.ackAt);
          // The existing persisted lease's slack at the next durable acknowledgement.
          const slack = last.leaseUntil - ackAt;
          minDurableLeaseSlackMs = Math.min(minDurableLeaseSlackMs ?? Infinity, slack);
        }
        confirmations.set(id, { ackAt, leaseUntil: at + lease, count: (last?.count ?? 0) + 1 });
      });
      return writing;
    },
  };
  const provider = {
    status: async (providerId) => {
      statusCalls++;
      if (providerId <= monitored) admitted.add(providerId);
      peakActive = Math.max(peakActive, ++active);
      await pause(providerId <= slowSubjects ? 2500 : 150);
      active--;
      return 'PUBLIC';
    },
    capture: () => Promise.reject(new Error('UNEXPECTED_SYNTHETIC_CAPTURE')),
  };
  const originalInfo = console.info;
  const performanceProperty = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  let latestWindow;
  console.info = (message, ...args) => {
    if (typeof message === 'string' && message.includes('"event":"capture_polling"'))
      latestWindow = JSON.parse(message);
    else originalInfo(message, ...args);
  };
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: epoch });
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => Date.now() - epoch },
  });
  try {
    const clock = new SyncClock({ intervalMs: () => pollMs });
    const evidence = new StatusEvidence({
      provider,
      clock,
      publicConcurrency: slots,
      intervalMs: () => pollMs,
      persist: archive.setObservation,
    });
    const releases = rows.slice(monitored).map((row) => evidence.retain(row, () => undefined));
    const supervisor = createSupervisor({ archive, provider, clock, evidence, pollMs });
    try {
      await settle();
      await advance(sampleMs);
      assert(latestWindow, 'capture_polling window must settle');
      assert(peakActive <= slots, 'physical request limit');
      const visits = rows.slice(0, monitored).map((row) => confirmations.get(row.id)?.count ?? 0);
      const { admission, upstream, persist, sweep, tail, rotation } = latestWindow.timings;
      return {
        scenario,
        pollMs,
        slots,
        viewers,
        slowSubjects,
        serialWriteMs: writeMs,
        sampleMs,
        stepMs,
        monitored,
        admittedPct: Math.round((admitted.size * 1000) / monitored) / 10,
        confirmedSubjects: confirmations.size,
        confirmedObservations: visits.reduce((sum, count) => sum + count, 0),
        minVisits: Math.min(...visits),
        maxDurableGapMs,
        minDurableLeaseSlackMs,
        statusCalls,
        peakActive,
        skippedClockRuns: clock.skippedRuns('capture-status'),
        lastWindow: {
          windowMs: latestWindow.windowMs,
          sweepWorkers: latestWindow.sweepWorkers,
          counts: latestWindow.counts,
          admission,
          upstream,
          persist,
          sweep,
          tail,
          rotation,
        },
      };
    } finally {
      releases.forEach((release) => release());
      const closing = Promise.all([supervisor.close(), evidence.close(), clock.close()]);
      await advance(5000);
      await closing;
    }
  } finally {
    mock.timers.reset();
    Object.defineProperty(globalThis, 'performance', performanceProperty);
    console.info = originalInfo;
  }
}

const baseline = { pollMs: 5000, slots: 8, viewers: 4, slowSubjects: 40, writeMs: 10 };
const cases = [
  { ...baseline, scenario: 'steady', viewers: 0, slowSubjects: 0 },
  { ...baseline, scenario: 'mixed' },
  { ...baseline, scenario: 'mixed-shorter-poll', pollMs: 3000 },
  { ...baseline, scenario: 'mixed-more-slots', slots: 16 },
  { ...baseline, scenario: 'serial-writer', slowSubjects: 0, writeMs: 90 },
  { ...baseline, scenario: 'serial-writer-more-slots', slowSubjects: 0, writeMs: 90, slots: 16 },
];
for (const scenario of cases) console.log(JSON.stringify(await measure(scenario)));
