import { getEventListeners } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { Metadata } from './metadata.js';
import { openArchive } from './index.js';

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it('retains completed index readiness across later reads without control RPCs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unit-ready-'));
  const calls = vi.spyOn(Metadata.prototype, 'call');
  const archive = await openArchive({ root });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'fixture' }]);
    await archive.snapshotUnit!('stripchat:42', 0);
    calls.mockClear();
    await archive.snapshotUnit!('stripchat:42', 0);
    await archive.unitSource!('stripchat:42', '00000000-0000-4000-8000-000000000042', 0);
    expect(calls.mock.calls.filter(([method]) => method === 'buildRecordingUnits')).toHaveLength(0);
  } finally {
    await archive.close();
    calls.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('retries failed startup index construction and then retains its successful readiness', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unit-retry-'));
  const original = Metadata.prototype.call;
  const failure = gate();
  const reason = Error('SYNTHETIC_INDEX_FAILURE');
  let builds = 0;
  const calls = vi.spyOn(Metadata.prototype, 'call').mockImplementation(function <T>(
    this: Metadata,
    method: string,
    input: unknown = {},
  ): Promise<T> {
    if (method === 'buildRecordingUnits') {
      builds++;
      if (builds === 1)
        return failure.promise.then(() => {
          throw reason;
        });
      if (builds === 2) return Promise.resolve(true as T);
    }
    return original.call(this, method, input) as Promise<T>;
  });
  const archive = await openArchive({ root });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'fixture' }]);
    const { signal } = new AbortController();
    const failed = Promise.allSettled([
      archive.coverage('stripchat:42', 0, 1000, 5, false, signal),
      archive.snapshotUnit!('stripchat:42', 0),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    failure.release();
    expect(await failed).toEqual([
      { status: 'rejected', reason },
      { status: 'rejected', reason },
    ]);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    await archive.snapshotUnit!('stripchat:42', 0);
    await archive.snapshotUnit!('stripchat:42', 0);
    expect(builds).toBe(3);
  } finally {
    failure.release();
    await archive.close();
    calls.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('drains an in-flight index batch during close', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unit-drain-'));
  const original = Metadata.prototype.call;
  const build = gate();
  const calls = vi.spyOn(Metadata.prototype, 'call').mockImplementation(function <T>(
    this: Metadata,
    method: string,
    input: unknown = {},
  ): Promise<T> {
    if (method === 'buildRecordingUnits')
      return build.promise.then(() => original.call(this, method, input)) as Promise<T>;
    return original.call(this, method, input) as Promise<T>;
  });
  const archive = await openArchive({ root });
  try {
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'fixture' }]);
    const controller = new AbortController();
    const reason = new DOMException('Fixture request cancelled', 'AbortError');
    const reads = Promise.allSettled([
      archive.coverage('stripchat:42', 0, 1000, 5),
      archive.coverage('stripchat:42', 0, 1000, 5, false, controller.signal),
    ]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    let closed = false;
    const closing = archive.close().then(() => {
      closed = true;
    });
    controller.abort(reason);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    build.release();
    await closing;
    expect(await reads).toMatchObject([
      { status: 'fulfilled', value: { subjectId: 'stripchat:42' } },
      { status: 'rejected', reason },
    ]);
  } finally {
    build.release();
    await archive.close();
    calls.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('releases cancelled coverage waiting for the shared index and never posts its read', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-unit-cancel-'));
  const original = Metadata.prototype.call;
  const build = gate();
  const builds = vi.spyOn(Metadata.prototype, 'call').mockImplementation(function <T>(
    this: Metadata,
    method: string,
    input: unknown = {},
  ): Promise<T> {
    if (method === 'buildRecordingUnits')
      return build.promise.then(() => original.call(this, method, input)) as Promise<T>;
    return original.call(this, method, input) as Promise<T>;
  });
  const reads = vi.spyOn(Metadata.prototype, 'read');
  const archive = await openArchive({ root });
  const { unitIndex } = archive as unknown as {
    unitIndex: { work: Promise<void>; waiters: Set<unknown> };
  };
  const subscribe = vi.spyOn(unitIndex.work, 'then');
  const controllers = Array.from({ length: 24 }, () => new AbortController());
  const aborted = new DOMException('Fixture request cancelled', 'AbortError');
  const drained = Promise.allSettled(
    controllers.map(({ signal }) => archive.coverage('stripchat:42', 0, 1000, 5, false, signal)),
  );
  try {
    await archive.upsertSubjects([{ id: 'stripchat:42', providerId: 42, handle: 'fixture' }]);
    for (const controller of controllers) controller.abort(aborted);
    await expect(drained).resolves.toEqual(
      controllers.map(() => ({ status: 'rejected', reason: aborted })),
    );
    expect(reads.mock.calls.filter(([method]) => method === 'coverage')).toHaveLength(0);
    expect(subscribe).not.toHaveBeenCalled();
    expect(unitIndex.waiters.size).toBe(0);
    const { signal } = new AbortController();
    const kept = Promise.all([
      archive.coverage('stripchat:42', 0, 1000, 5, false, signal),
      archive.coverage('stripchat:42', 0, 1000, 5),
    ]);
    build.release();
    expect(await kept).toMatchObject(
      Array.from({ length: 2 }, () => ({ subjectId: 'stripchat:42' })),
    );
    expect(unitIndex.waiters.size).toBe(0);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    expect(reads.mock.calls.filter(([method]) => method === 'coverage')).toHaveLength(2);
  } finally {
    build.release();
    await drained;
    await archive.close();
    subscribe.mockRestore();
    builds.mockRestore();
    reads.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
