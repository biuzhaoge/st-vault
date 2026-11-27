/* eslint-disable @typescript-eslint/require-await -- Asynchronous source fixtures. */
import { expect, it, vi } from 'vitest';
import type { PublicStatus, Subject } from '@st-vault/api-schema';
import { StatusEvidence, type StatusObservationTiming } from './status-evidence.js';
import { ProviderError } from './http.js';
import { SyncClock } from '../runtime/sync-clock.js';

const subject: Subject = {
  id: 'stripchat:42',
  providerId: 42,
  handle: 'fixture',
  monitorEnabled: true,
  autoRecord: true,
  providerStatus: 'UNKNOWN',
  observedAtMs: null,
};
const observationTiming = (): StatusObservationTiming => ({
  upstreamCalls: 0,
  upstreamRetries: 0,
  admissionDeadlines: 0,
  upstreamDeadlines: 0,
});

it('requires new public evidence after the outbound route changes', async () => {
  let now = 1000;
  let finish: ((status: PublicStatus) => void) | undefined;
  const status = vi
    .fn<() => Promise<PublicStatus>>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue('OFFLINE');
  const evidence = new StatusEvidence({ provider: { status }, now: () => now });
  let pending: ReturnType<StatusEvidence['observe']> | undefined;
  try {
    evidence.seedPublic(subject, now);
    expect(evidence.public(subject.id)).toBe(true);
    pending = evidence.observe(subject);
    await vi.waitFor(() => expect(status).toHaveBeenCalledOnce());
    now += 1;
    evidence.resetTransport();
    evidence.seedPublic(subject, 1000);
    expect(evidence.public(subject.id)).toBe(false);
    const renewed = evidence.observe(subject);
    finish?.('PUBLIC');
    expect(await pending).toMatchObject({ status: 'UNKNOWN' });
    expect(await renewed).toMatchObject({ status: 'OFFLINE' });
    expect(evidence.public(subject.id)).toBe(false);
  } finally {
    finish?.('PUBLIC');
    if (pending) await Promise.allSettled([pending]);
    await evidence.close();
  }
});

it('uses the injected observation capacity and derives active permission leases from its rotation', async () => {
  const releases: ((status: PublicStatus) => void)[] = [];
  const status = vi.fn(() => new Promise<PublicStatus>((resolve) => releases.push(resolve)));
  const evidence = new StatusEvidence({
    provider: { status },
    publicConcurrency: 32,
    monitorConcurrency: 16,
  });
  const observations = Array.from({ length: 32 }, (_, index) =>
    evidence.observe({ ...subject, id: `stripchat:${index + 1}`, providerId: index + 1 }),
  );
  try {
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(32));
    const releaseInterest = evidence.retain(subject, () => undefined);
    expect(evidence.monitorCapacity).toBe(16);
    releaseInterest();
    expect(evidence.monitorCapacity).toBe(32);
  } finally {
    const closed = evidence.close();
    releases.forEach((release) => release('PUBLIC'));
    await closed;
    await Promise.allSettled(observations);
  }
});
it('accounts for the configured active batch rather than a hard-coded four in its lease', async () => {
  const evidence = new StatusEvidence({
    provider: { status: () => Promise.resolve('PUBLIC') },
    now: () => 1000,
    publicConcurrency: 16,
    monitorConcurrency: 8,
    intervalMs: () => 1000,
    leaseMs: () => 1000,
  });
  const releases = Array.from({ length: 24 }, (_, index) =>
    evidence.retain(
      { ...subject, id: `stripchat:${index + 1}`, providerId: index + 1 },
      () => undefined,
    ),
  );
  try {
    evidence.seedPublic(subject, 1000);
    expect(evidence.snapshot(subject.id).publicUntilMs).toBe(10000);
  } finally {
    releases.forEach((release) => release());
    await evidence.close();
  }
});
it('shares an in-flight observation and its confirmation between media and monitoring', async () => {
  let release!: (status: PublicStatus) => void;
  const status = vi.fn(
    () =>
      new Promise<PublicStatus>((resolve) => {
        release = resolve;
      }),
  );
  const evidence = new StatusEvidence({ provider: { status } });
  try {
    const monitoring = evidence.observe(subject);
    const media = evidence.observe(subject);
    await vi.waitFor(() => expect(status).toHaveBeenCalledOnce());
    release('PUBLIC');
    expect(await monitoring).toMatchObject({ status: 'PUBLIC' });
    expect(await media).toMatchObject({ status: 'PUBLIC' });
    expect(evidence.public(subject.id)).toBe(true);
    expect(status).toHaveBeenCalledOnce();
  } finally {
    await evidence.close();
  }
});
it('separates retry time from evidence persistence and leaves cached observations without timings', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const status = vi
    .fn<() => Promise<PublicStatus>>()
    .mockImplementationOnce(async () => {
      await pause(400);
      throw new ProviderError('upstream-request');
    })
    .mockImplementation(async () => {
      await pause(100);
      return 'PUBLIC';
    });
  const evidence = new StatusEvidence({ provider: { status }, persist: () => pause(50) });
  const timing = observationTiming();
  try {
    evidence.seedPublic(subject, Date.now());
    const pending = evidence.observe(subject, undefined, 0, 'monitor', timing);
    await vi.advanceTimersByTimeAsync(550);
    expect(await pending).toMatchObject({ status: 'PUBLIC' });
    expect(timing).toEqual({
      source: 'upstream',
      upstreamCalls: 2,
      upstreamRetries: 1,
      admissionDeadlines: 0,
      upstreamDeadlines: 0,
      admissionMs: 0,
      upstreamMs: 500,
      persistMs: 50,
    });
    const cached = observationTiming();
    expect(await evidence.observe(subject, undefined, 1000, 'monitor', cached)).toMatchObject({
      status: 'PUBLIC',
    });
    expect(cached).toEqual({ ...observationTiming(), source: 'cache' });
  } finally {
    await evidence.close();
    vi.useRealTimers();
  }
});
it('records a logical upstream deadline and a failed persist without mixing their durations', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] });
  let finish!: (status: PublicStatus) => void;
  const late = new Promise<PublicStatus>((resolve) => {
    finish = resolve;
  });
  const status = vi
    .fn<() => Promise<PublicStatus>>()
    .mockReturnValueOnce(late)
    .mockResolvedValue('PUBLIC');
  const persist = vi.fn(async (): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    throw new Error('synthetic persist failure');
  });
  const evidence = new StatusEvidence({
    provider: { status },
    timeoutMs: 100,
    publicConcurrency: 1,
    persist,
  });
  try {
    const deadline = observationTiming();
    const first = evidence.observe(subject, undefined, 0, 'monitor', deadline);
    await vi.advanceTimersByTimeAsync(100);
    expect(await first).toMatchObject({ status: 'UNKNOWN' });
    expect(deadline).toMatchObject({ upstreamCalls: 1, upstreamDeadlines: 1, upstreamMs: 100 });
    expect(deadline).not.toHaveProperty('persistMs');
    expect(persist).not.toHaveBeenCalled();
    expect(evidence.pending).toBe(1);

    const admission = observationTiming();
    const blocked = evidence.observe(
      { ...subject, id: 'stripchat:43', providerId: 43 },
      undefined,
      0,
      'monitor',
      admission,
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await blocked).toMatchObject({ status: 'UNKNOWN' });
    expect(admission).toMatchObject({ upstreamCalls: 0, admissionDeadlines: 1, admissionMs: 100 });
    expect(admission).not.toHaveProperty('upstreamMs');

    finish('PUBLIC');
    await vi.advanceTimersByTimeAsync(0);
    const persistence = observationTiming();
    const failed = expect(
      evidence.observe(subject, undefined, 0, 'monitor', persistence),
    ).rejects.toThrow('synthetic persist failure');
    await vi.advanceTimersByTimeAsync(30);
    await failed;
    expect(persistence).toMatchObject({
      upstreamCalls: 1,
      upstreamDeadlines: 0,
      upstreamMs: 0,
      persistMs: 30,
      persistenceFailed: true,
    });
  } finally {
    finish('PUBLIC');
    await evidence.close();
    vi.useRealTimers();
  }
});
it('backdates confirmed changes, and does not renew PUBLIC permission on UNKNOWN', async () => {
  let now = 1000;
  const persist = vi.fn(async () => undefined);
  const status = vi
    .fn<() => Promise<PublicStatus>>()
    .mockResolvedValueOnce('PUBLIC')
    .mockImplementationOnce(async () => {
      now = 2000;
      return 'OFFLINE';
    })
    .mockImplementationOnce(async () => {
      now = 2400;
      return 'UNKNOWN';
    })
    .mockImplementationOnce(async () => {
      now = 5000;
      return 'OFFLINE';
    });
  const evidence = new StatusEvidence({
    provider: { status },
    now: () => now,
    persist,
    leaseMs: () => 15000,
  });
  try {
    await evidence.observe(subject);
    const deadline = evidence.snapshot(subject.id).publicUntilMs;
    await evidence.observe(subject);
    expect(evidence.snapshot(subject.id).publicUntilMs).toBe(deadline);
    await evidence.observe(subject);
    expect(persist.mock.calls.at(-1)).toEqual([subject.id, 'OFFLINE', 5000, 15000, 2000]);
  } finally {
    await evidence.close();
  }
});
it('revokes public media on the first PRIVATE response before confirmation completes', async () => {
  let confirm!: (value: PublicStatus) => void;
  const status = vi
    .fn<() => Promise<PublicStatus>>()
    .mockResolvedValueOnce('PUBLIC')
    .mockResolvedValueOnce('PRIVATE')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
  const evidence = new StatusEvidence({ provider: { status } });
  try {
    await evidence.observe(subject);
    const changed = vi.fn();
    const release = evidence.retain(subject, changed);
    const observing = evidence.observe(subject);
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(3));
    expect(evidence.public(subject.id)).toBe(false);
    expect(evidence.snapshot(subject.id).revocation).toBe('PRIVATE');
    expect(changed).toHaveBeenCalled();
    confirm('PRIVATE');
    await observing;
    release();
  } finally {
    await evidence.close();
  }
});
it('pauses new starts while an OFFLINE transition is being rechecked', async () => {
  let confirm!: (value: PublicStatus) => void;
  const status = vi
    .fn<() => Promise<PublicStatus>>()
    .mockResolvedValueOnce('PUBLIC')
    .mockResolvedValueOnce('OFFLINE')
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
  const evidence = new StatusEvidence({ provider: { status } });
  try {
    await evidence.observe(subject);
    expect(evidence.publicForStart(subject.id)).toBe(true);
    const observing = evidence.observe(subject);
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(3));
    expect(evidence.public(subject.id)).toBe(true);
    expect(evidence.publicForStart(subject.id)).toBe(false);
    confirm('PUBLIC');
    await observing;
    expect(evidence.publicForStart(subject.id)).toBe(true);
  } finally {
    confirm?.('PUBLIC');
    await evidence.close();
  }
});

it('keeps one shared offline recovery window instead of tearing media down on a second raw response', async () => {
  let now = 1000;
  const status = vi.fn<() => Promise<PublicStatus>>().mockResolvedValue('PUBLIC');
  const evidence = new StatusEvidence({
    provider: { status },
    now: () => now,
    leaseMs: () => 60000,
  });
  try {
    await evidence.observe(subject);
    status.mockResolvedValue('OFFLINE');
    now = 2000;
    await evidence.observe(subject);
    expect(evidence.public(subject.id)).toBe(true);
    now = 18000;
    await evidence.observe(subject);
    expect(evidence.public(subject.id)).toBe(false);
    expect(evidence.snapshot(subject.id).revocation).toBe('OFFLINE');
  } finally {
    await evidence.close();
  }
});
it('caps actual requests across all consumers even after logical timeouts', async () => {
  const releases: ((value: PublicStatus) => void)[] = [];
  const status = vi.fn(
    () =>
      new Promise<PublicStatus>((resolve) => {
        releases.push(resolve);
      }),
  );
  const evidence = new StatusEvidence({ provider: { status }, timeoutMs: 10 });
  try {
    const pending = Array.from({ length: 9 }, (_, index) =>
      evidence.observe({
        ...subject,
        id: `stripchat:${index + 1}`,
        providerId: index + 1,
      }),
    );
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(8));
    await Promise.all(pending);
    expect(evidence.pending).toBe(8);
    await evidence.observe({ ...subject, id: 'stripchat:1', providerId: 1 });
    expect(status).toHaveBeenCalledTimes(8);
  } finally {
    releases.forEach((release) => release('PUBLIC'));
    await evidence.close();
  }
});
it('keeps failed evidence rounds through idle pulses and clears them after successful work', async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const clock = new SyncClock({ intervalMs: () => 1000 });
  const persist = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  for (let attempt = 0; attempt < 3; attempt++)
    persist.mockRejectedValueOnce(Error('failed to persist evidence'));
  const evidence = new StatusEvidence({
    clock,
    intervalMs: () => 1000,
    provider: { status: () => Promise.resolve('PUBLIC') },
    persist,
  });
  const release = evidence.retain(subject, () => undefined);
  try {
    await vi.advanceTimersByTimeAsync(250);
    expect(clock.status()[0]?.consecutiveFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(clock.status()[0]?.consecutiveFailures).toBe(1);
    await vi.advanceTimersByTimeAsync(1750);
    expect(clock.status()[0]?.consecutiveFailures).toBe(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(persist).toHaveBeenCalledTimes(4);
    expect(clock.status()[0]?.consecutiveFailures).toBe(0);
  } finally {
    release();
    await evidence.close();
    await clock.close();
    warning.mockRestore();
    vi.useRealTimers();
  }
});

it('rotates active viewers on the common clock and reserves monitoring capacity', async () => {
  vi.useFakeTimers();
  const clock = new SyncClock({ intervalMs: () => 1000 });
  const visited: number[] = [];
  const evidence = new StatusEvidence({
    clock,
    intervalMs: () => 1000,
    provider: {
      status: async (id) => {
        visited.push(id);
        return 'PUBLIC';
      },
    },
  });
  const releases = Array.from({ length: 6 }, (_, index) =>
    evidence.retain(
      {
        ...subject,
        id: `stripchat:${index + 1}`,
        providerId: index + 1,
      },
      () => undefined,
    ),
  );
  try {
    expect(evidence.monitorCapacity).toBe(4);
    await vi.advanceTimersByTimeAsync(1300);
    expect(new Set(visited)).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    releases.forEach((release) => release());
    expect(evidence.monitorCapacity).toBe(8);
    const count = visited.length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(visited).toHaveLength(count);
  } finally {
    await evidence.close();
    await clock.close();
    vi.useRealTimers();
  }
});
