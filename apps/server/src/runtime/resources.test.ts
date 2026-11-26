import { describe, expect, it, vi } from 'vitest';
import { ResourceMonitor } from './resources.js';
import { defaultRuntimeSettings } from './settings.js';
import { SyncClock } from './sync-clock.js';
describe('storage budgets and retention ownership', () => {
  it('resumes empty date cleanup on its own schedule even with keep-forever recordings', async () => {
    let now = 200000000,
      freeBytes = 50;
    const pruneEmptyDays = vi.fn().mockResolvedValueOnce(86400000).mockResolvedValue(null);
    const pruneBefore = vi.fn();
    const monitor = new ResourceMonitor({
      root: '/media',
      databaseRoot: '/data',
      archive: { pruneBefore, pruneEmptyDays },
      cleanEmptyDays: true,
      settings: () => ({ ...defaultRuntimeSettings, minFreeBytes: 100, retentionDays: 0 }),
      readDisk: () => Promise.resolve({ freeBytes, totalBytes: 1000 }),
      writeProbe: () => Promise.resolve(),
      now: () => now,
    });
    try {
      await monitor.check();
      expect(pruneEmptyDays).not.toHaveBeenCalled();
      const task = () => monitor.backgroundTasks().find(({ id }) => id === 'empty-day-cleanup');
      expect(task()?.state).toBe('paused');
      freeBytes = 500;
      await monitor.check();
      expect(pruneEmptyDays).toHaveBeenNthCalledWith(1, now, undefined);
      expect(task()?.nextRunAtMs).toBe(now + 5000);
      now += 4999;
      await monitor.check();
      expect(pruneEmptyDays).toHaveBeenCalledOnce();
      now += 1;
      await monitor.check();
      expect(pruneEmptyDays).toHaveBeenNthCalledWith(2, now, 86400000);
      expect(task()?.nextRunAtMs).toBe(now + 3600000);
      expect(pruneBefore).not.toHaveBeenCalled();
    } finally {
      await monitor.close();
    }
  });
  it('checks at deployment midnight plus the recording grace even when the hourly sweep is later', async () => {
    let now = Date.parse('2026-11-26T23:55:00+08:00');
    const midnight = Date.parse('2026-11-27T00:00:00+08:00');
    vi.stubEnv('TZ', 'Asia/Shanghai');
    const pruneEmptyDays = vi.fn().mockResolvedValue(null);
    const monitor = new ResourceMonitor({
      root: '/media',
      archive: { pruneBefore: vi.fn(), pruneEmptyDays },
      cleanEmptyDays: true,
      settings: () => ({ ...defaultRuntimeSettings, minFreeBytes: 100, retentionDays: 0 }),
      readDisk: () => Promise.resolve({ freeBytes: 500, totalBytes: 1000 }),
      writeProbe: () => Promise.resolve(),
      now: () => now,
    });
    try {
      await monitor.check();
      const task = () => monitor.backgroundTasks().find(({ id }) => id === 'empty-day-cleanup');
      expect(task()?.nextRunAtMs).toBe(midnight + 60000);
      now = midnight + 59999;
      await monitor.check();
      expect(pruneEmptyDays).toHaveBeenCalledOnce();
      now = midnight + 60000;
      await monitor.check();
      expect(pruneEmptyDays).toHaveBeenNthCalledWith(2, now, undefined);
      expect(task()?.nextRunAtMs).toBe(now + 3600000);
    } finally {
      await monitor.close();
      vi.unstubAllEnvs();
    }
  });
  it('rechecks on the shared clock after completed deletions and retains notices during a batch', async () => {
    vi.useFakeTimers();
    let now = Date.parse('2026-11-26T12:00:00Z'),
      releaseBatch!: (cursor: number | null) => void;
    const clock = new SyncClock({ intervalMs: () => 1000, now: () => now });
    const batch = new Promise<number | null>((resolve) => {
      releaseBatch = resolve;
    });
    const pruneEmptyDays = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockReturnValueOnce(batch)
      .mockResolvedValue(null);
    const listeners = new Set<() => void>();
    const subscribeDeletionComplete = vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    const monitor = new ResourceMonitor({
      root: '/media',
      clock,
      archive: { pruneBefore: vi.fn(), pruneEmptyDays, subscribeDeletionComplete },
      cleanEmptyDays: true,
      settings: () => ({ ...defaultRuntimeSettings, minFreeBytes: 100, retentionDays: 0 }),
      readDisk: () => Promise.resolve({ freeBytes: 500, totalBytes: 1000 }),
      writeProbe: () => Promise.resolve(),
      now: () => now,
    });
    try {
      monitor.start();
      monitor.start();
      await monitor.check();
      const completed = () => {
        for (const listener of listeners) listener();
      };
      completed();
      completed();
      now += 1000;
      await vi.advanceTimersByTimeAsync(1000);
      expect(pruneEmptyDays).toHaveBeenNthCalledWith(2, now, undefined);
      expect(subscribeDeletionComplete).toHaveBeenCalledOnce();
      completed();
      releaseBatch(86400000);
      await clock.runNow('resources');
      now += 4999;
      await clock.runNow('resources');
      expect(pruneEmptyDays).toHaveBeenCalledTimes(2);
      now += 1;
      await clock.runNow('resources');
      expect(pruneEmptyDays).toHaveBeenNthCalledWith(3, now, undefined);
      now += 1000;
      await clock.runNow('resources');
      expect(pruneEmptyDays).toHaveBeenCalledTimes(3);
    } finally {
      releaseBatch(null);
      await monitor.close();
      await clock.close();
      vi.useRealTimers();
    }
    expect(listeners.size).toBe(0);
  });
  it.each([true, false])(
    'admits cleanup according to free space on the database volume (shared=%s)',
    async (shared) => {
      const pruneBefore = vi.fn().mockResolvedValue({ deletedSegments: 0, reclaimedBytes: 0 });
      const monitor = new ResourceMonitor({
        root: '/media',
        dataRoot: '/data',
        databaseRoot: '/data/postgres',
        archive: { pruneBefore },
        settings: () => ({ ...defaultRuntimeSettings, minFreeBytes: 100, retentionDays: 1 }),
        readDisk: (root) =>
          Promise.resolve({
            freeBytes: shared || root === '/media' ? 50 : 500,
            totalBytes: 1000,
          }),
        now: () => 200000000,
      });
      try {
        await monitor.check();
        expect(monitor.canRecord()).toBe(false);
        if (shared) {
          await expect(monitor.retry('retention')).rejects.toThrow('STORAGE_UNAVAILABLE');
          expect(pruneBefore).not.toHaveBeenCalled();
        } else {
          expect(pruneBefore).toHaveBeenCalledOnce();
        }
      } finally {
        await monitor.close();
      }
    },
  );
  it.each(['dataRoot', 'databaseRoot'] as const)(
    'blocks recording when the %s volume alone is full',
    async (volume) => {
      let dataFree = 0;
      const writeProbe = vi.fn(() => Promise.resolve());
      const monitor = new ResourceMonitor({
        root: '/media',
        [volume]: '/data',
        archive: { pruneBefore: () => Promise.resolve({ deletedSegments: 0, reclaimedBytes: 0 }) },
        settings: () => defaultRuntimeSettings,
        readDisk: (root) =>
          Promise.resolve({
            freeBytes: root === '/data' ? dataFree : 10 ** 12,
            totalBytes: 2 * 10 ** 12,
          }),
        writeProbe,
      });
      try {
        await monitor.checkDisk();
        expect(monitor.canRecord()).toBe(false);
        expect(monitor.get().error).toBe('data_disk_low_space');
        expect(writeProbe).toHaveBeenCalledWith('/media');
        expect(writeProbe).toHaveBeenCalledWith('/data');
        dataFree = 10 ** 12;
        await monitor.checkDisk();
        expect(monitor.canRecord()).toBe(true);
      } finally {
        await monitor.close();
      }
    },
  );
  it('rechecks write access immediately after an operator fixes a read-only volume', async () => {
    let writable = false;
    const monitor = new ResourceMonitor({
      root: '/media',
      archive: { pruneBefore: () => Promise.resolve({ deletedSegments: 0, reclaimedBytes: 0 }) },
      settings: () => defaultRuntimeSettings,
      readDisk: () => Promise.resolve({ freeBytes: 10 ** 12, totalBytes: 2 * 10 ** 12 }),
      writeProbe: () =>
        writable
          ? Promise.resolve()
          : Promise.reject(Object.assign(Error('readonly'), { code: 'EROFS' })),
      now: () => 100000,
    });
    try {
      await monitor.check();
      expect(monitor.get().error).toBe('disk_read_only');
      writable = true;
      await monitor.retry('disk-check');
      expect(monitor.canRecord()).toBe(true);
    } finally {
      await monitor.close();
    }
  });
  it('keeps recording disk admission independent of a blocked retention sweep', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pruneBefore = vi.fn(async () => {
      await gate;
      return { deletedSegments: 0, reclaimedBytes: 0 };
    });
    const monitor = new ResourceMonitor({
      root: '.',
      archive: { pruneBefore },
      settings: () => ({ ...defaultRuntimeSettings, retentionDays: 1 }),
      readDisk: () => Promise.resolve({ freeBytes: 10 ** 12, totalBytes: 2 * 10 ** 12 }),
      writeProbe: () => Promise.resolve(),
      now: () => 100000,
    });
    const maintenance = monitor.check();
    try {
      await vi.waitFor(() => expect(pruneBefore).toHaveBeenCalledTimes(1));
      await monitor.checkDisk();
      expect(monitor.canRecord()).toBe(true);
    } finally {
      release();
      await maintenance;
      await monitor.close();
    }
  });
  it('pauses recording when storage checks are stale and resumes after a fresh successful check', async () => {
    let now = 100000;
    const monitor = new ResourceMonitor({
      root: '.',
      archive: { pruneBefore: () => Promise.resolve({ deletedSegments: 0, reclaimedBytes: 0 }) },
      settings: () => defaultRuntimeSettings,
      readDisk: () => Promise.resolve({ freeBytes: 10 ** 12, totalBytes: 2 * 10 ** 12 }),
      writeProbe: () => Promise.resolve(),
      now: () => now,
    });
    await monitor.check();
    expect(monitor.canRecord()).toBe(true);
    now += 30001;
    expect(monitor.get().error).toBe('disk_check_stale');
    expect(monitor.canRecord()).toBe(false);
    await monitor.check();
    expect(monitor.canRecord()).toBe(true);
    await monitor.close();
  });
  it('detects a read-only volume despite readable space statistics and recovers on the next write probe', async () => {
    let now = 100000,
      writable = false;
    const monitor = new ResourceMonitor({
      root: '.',
      archive: { pruneBefore: () => Promise.resolve({ deletedSegments: 0, reclaimedBytes: 0 }) },
      settings: () => defaultRuntimeSettings,
      readDisk: () => Promise.resolve({ freeBytes: 10 ** 12, totalBytes: 2 * 10 ** 12 }),
      writeProbe: () =>
        writable
          ? Promise.resolve()
          : Promise.reject(Object.assign(new Error('readonly'), { code: 'EROFS' })),
      now: () => now,
    });
    await monitor.check();
    expect(monitor.get().error).toBe('disk_read_only');
    expect(monitor.canRecord()).toBe(false);
    writable = true;
    now += 30000;
    await monitor.check();
    expect(monitor.get().error).toBeNull();
    expect(monitor.canRecord()).toBe(true);
    await monitor.close();
  });
  it('clears obsolete retention errors when retention is disabled', async () => {
    let retentionDays = 1;
    const monitor = new ResourceMonitor({
      root: '.',
      archive: { pruneBefore: () => Promise.reject(new Error('denied')) },
      settings: () => ({ ...defaultRuntimeSettings, retentionDays }),
      readDisk: () => Promise.resolve({ freeBytes: 10 ** 12, totalBytes: 2 * 10 ** 12 }),
      writeProbe: () => Promise.resolve(),
      now: () => 100000,
    });
    await monitor.check();
    expect(monitor.maintenanceError()).toBe('retention_cleanup_failed');
    retentionDays = 0;
    await monitor.check();
    expect(monitor.maintenanceError()).toBeNull();
    await monitor.close();
  });
  it('blocks capture on low disk, recovers after cleanup, and prunes only by the configured cutoff', async () => {
    let freeBytes = 10;
    const changed = vi.fn();
    const pruneBefore = vi.fn(() => Promise.resolve({ deletedSegments: 0, reclaimedBytes: 0 }));
    const monitor = new ResourceMonitor({
      root: '.',
      archive: { pruneBefore },
      settings: () => ({ ...defaultRuntimeSettings, minFreeBytes: 100, retentionDays: 1 }),
      readDisk: () => Promise.resolve({ freeBytes, totalBytes: 1000 }),
      changed,
      now: () => 200000000,
    });
    await monitor.check();
    expect(monitor.canRecord()).toBe(false);
    expect(pruneBefore).toHaveBeenCalledWith(200000000 - 86400000, 1);
    freeBytes = 200;
    await monitor.check();
    expect(monitor.canRecord()).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(pruneBefore).toHaveBeenCalledTimes(1);
    await monitor.close();
    expect(monitor.canRecord()).toBe(false);
  });
  it('coalesces checks and reports disk errors without allowing capture or overlapping cleanup', async () => {
    let finish: ((value: { freeBytes: number; totalBytes: number }) => void) | undefined;
    const readDisk = vi.fn(
      () =>
        new Promise<{ freeBytes: number; totalBytes: number }>((resolve) => {
          finish = resolve;
        }),
    );
    const monitor = new ResourceMonitor({
      root: '.',
      archive: { pruneBefore: () => Promise.resolve({ deletedSegments: 0, reclaimedBytes: 0 }) },
      settings: () => defaultRuntimeSettings,
      readDisk,
    });
    const first = monitor.check();
    expect(monitor.check()).toBe(first);
    expect(readDisk).toHaveBeenCalledTimes(1);
    finish!({ freeBytes: -1, totalBytes: 10 });
    await first;
    expect(monitor.get().error).toBe('disk_unavailable');
    expect(monitor.canRecord()).toBe(false);
    await monitor.close();
  });
  it('clears a repaired integrity warning independently of retention failures', async () => {
    let broken = true;
    const pruneBefore = vi.fn(() => Promise.reject(new Error('unavailable')));
    const scrub = vi.fn(() =>
      broken
        ? Promise.reject(new Error('corrupt'))
        : Promise.resolve({ checked: 0, nextCursor: null }),
    );
    const monitor = new ResourceMonitor({
      root: '.',
      archive: { pruneBefore, scrub },
      settings: () => ({ ...defaultRuntimeSettings, retentionDays: 1 }),
      readDisk: () => Promise.resolve({ freeBytes: 10 ** 12, totalBytes: 2 * 10 ** 12 }),
      now: () => 100000,
    });
    await monitor.check();
    expect(monitor.maintenanceError()).toBe('archive_integrity_check_failed');
    broken = false;
    await monitor.retry('integrity-scan');
    expect(scrub).toHaveBeenCalledTimes(2);
    expect(pruneBefore).toHaveBeenCalledOnce();
    expect(monitor.maintenanceError()).toBe('retention_cleanup_failed');
    await monitor.retry('retention');
    expect(pruneBefore).toHaveBeenCalledTimes(2);
    expect(scrub).toHaveBeenCalledTimes(2);
    await monitor.close();
  });
});

it('reports domain work and failures without starting maintenance from observation', async () => {
  let now = 100000,
    retentionDays = 1,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pruneBefore = vi.fn(async () => {
    await gate;
    throw Error('private filesystem path');
  });
  const scrub = vi.fn(() => Promise.resolve({ checked: 16, nextCursor: 'opaque-private-cursor' }));
  const monitor = new ResourceMonitor({
    root: '.',
    archive: { pruneBefore, scrub },
    settings: () => ({ ...defaultRuntimeSettings, retentionDays }),
    now: () => now,
    readDisk: () => Promise.resolve({ freeBytes: 1e12, totalBytes: 2e12 }),
    writeProbe: () => Promise.resolve(),
  });
  try {
    expect(monitor.backgroundTasks().find((task) => task.id === 'retention')?.state).toBe('paused');
    expect(pruneBefore).not.toHaveBeenCalled();
    const work = monitor.check();
    await vi.waitFor(() => expect(pruneBefore).toHaveBeenCalledOnce());
    expect(monitor.backgroundTasks().find((task) => task.id === 'retention')?.state).toBe(
      'running',
    );
    release();
    await work;
    const rows = monitor.backgroundTasks();
    expect(rows.find((task) => task.id === 'retention')).toMatchObject({
      state: 'retrying',
      lastSuccessAtMs: null,
      error: 'retention_cleanup_failed',
      nextRunAtMs: 160000,
    });
    expect(rows.find((task) => task.id === 'integrity-scan')).toMatchObject({
      processed: 16,
      lastSuccessAtMs: 100000,
    });
    expect(JSON.stringify(rows)).not.toContain('private');
    expect(JSON.stringify(rows)).not.toContain('opaque');
    retentionDays = 0;
    now++;
    expect(monitor.backgroundTasks().find((task) => task.id === 'retention')?.state).toBe(
      'disabled',
    );
    expect(pruneBefore).toHaveBeenCalledOnce();
  } finally {
    release();
    await monitor.close();
  }
});
