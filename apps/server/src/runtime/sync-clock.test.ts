import { expect, it, vi } from 'vitest';
import { SyncClock } from './sync-clock.js';
it('uses one clock for every job and applies the shared interval without overlapping slow work', async () => {
  vi.useFakeTimers();
  let interval = 1000,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const clock = new SyncClock({ intervalMs: () => interval }),
    fast = vi.fn(),
    slow = vi.fn(() => gate);
  clock.subscribe('fast', fast);
  clock.subscribe('slow', slow);
  try {
    await vi.advanceTimersByTimeAsync(3000);
    expect(fast).toHaveBeenCalledTimes(3);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(clock.skippedRuns('fast')).toBe(0);
    expect(clock.skippedRuns('slow')).toBe(2);
    release();
    await Promise.resolve();
    interval = 2000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(fast).toHaveBeenCalledTimes(4);
  } finally {
    release();
    await clock.close();
    vi.useRealTimers();
  }
});
it('cancels detached jobs and retains only the clock timer', async () => {
  vi.useFakeTimers();
  const clock = new SyncClock({ intervalMs: () => 1000 }),
    work = vi.fn();
  const detach = clock.subscribe('job', work);
  try {
    expect(vi.getTimerCount()).toBe(1);
    detach();
    await vi.advanceTimersByTimeAsync(2000);
    expect(work).not.toHaveBeenCalled();
  } finally {
    await clock.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  }
});
it('observes slow execution, failure and recovery without altering job admission', async () => {
  vi.useFakeTimers();
  const clock = new SyncClock({ intervalMs: () => 1000 });
  let reject!: () => void;
  let shouldFail = true;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const detach = clock.subscribe('observed', () =>
    shouldFail
      ? new Promise<void>((_resolve, fail) => {
          reject = () => fail(Error('not exposed'));
        })
      : undefined,
  );
  try {
    expect(clock.status()[0]).toMatchObject({
      running: false,
      lastStartedAtMs: null,
      failed: false,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(clock.status()[0]).toMatchObject({ running: true, lastStartedAtMs: Date.now() });
    const before = clock.status()[0];
    before.name = 'mutated';
    expect(clock.status()[0].name).toBe('observed');
    await vi.advanceTimersByTimeAsync(2000);
    expect(clock.status()[0].lastStartedAtMs).toBe(before.lastStartedAtMs);
    reject();
    await vi.advanceTimersByTimeAsync(0);
    expect(clock.status()[0]).toMatchObject({
      running: false,
      failed: true,
      consecutiveFailures: 1,
    });
    expect(clock.status()[0]).not.toHaveProperty('error');
    await vi.advanceTimersByTimeAsync(1000);
    expect(clock.status()[0]).toMatchObject({ running: true, consecutiveFailures: 1 });
    reject();
    await vi.advanceTimersByTimeAsync(0);
    expect(clock.status()[0]).toMatchObject({
      running: false,
      failed: true,
      consecutiveFailures: 2,
    });
    shouldFail = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(clock.status()[0]).toMatchObject({
      failed: false,
      running: false,
      consecutiveFailures: 0,
    });
  } finally {
    detach();
    await clock.close();
    warning.mockRestore();
    vi.useRealTimers();
  }
});
