import type { PublicStatus } from '@st-vault/api-schema';
import { expect, it, vi } from 'vitest';
import {
  createBatchedModelStatus,
  modelBatchStatuses,
  modelStatusPath,
} from './batched-model-status.js';
import { ProviderError } from './http.js';

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

it('coalesces same-turn reads, caps the ID list and preserves missing status as unknown', async () => {
  const read = vi.fn((ids: readonly number[]) =>
    Promise.resolve(
      new Map<number, PublicStatus>(
        ids.filter((id) => id !== 60).map((id) => [id, id % 2 ? 'PUBLIC' : 'OFFLINE']),
      ),
    ),
  );
  const status = createBatchedModelStatus(read);
  const result = await Promise.all(
    Array.from({ length: 65 }, (_, index) => status(index + 1)).concat(status(1)),
  );
  expect(read.mock.calls.map(([ids]) => ids.length)).toEqual([50, 15]);
  expect(result[0]).toBe('PUBLIC');
  expect(result[1]).toBe('OFFLINE');
  expect(result[59]).toBe('UNKNOWN');
  expect(result.at(-1)).toBe('PUBLIC');
  await status(1);
  expect(read).toHaveBeenCalledTimes(3);
});

it('cancels one waiter without issuing a read for its unused ID or aborting its siblings', async () => {
  let resolve!: (statuses: ReadonlyMap<number, PublicStatus>) => void;
  const read = vi.fn(
    (_ids: readonly number[], signal: AbortSignal) =>
      new Promise<ReadonlyMap<number, PublicStatus>>((done, reject) => {
        resolve = done;
        signal.addEventListener('abort', () => reject(new ProviderError('cancelled')), {
          once: true,
        });
      }),
  );
  const status = createBatchedModelStatus(read);
  const queued = new AbortController();
  const running = new AbortController();
  const omitted = expect(status(1, queued.signal)).rejects.toMatchObject({ code: 'cancelled' });
  const detached = expect(status(2, running.signal)).rejects.toMatchObject({ code: 'cancelled' });
  const healthy = status(3);
  queued.abort();
  await tick();
  running.abort();
  expect(read.mock.calls[0]?.[0]).toEqual([2, 3]);
  expect(read.mock.calls[0]?.[1].aborted).toBe(false);
  resolve(new Map([[3, 'PRIVATE']]));
  await omitted;
  await detached;
  await expect(healthy).resolves.toBe('PRIVATE');
});

it('aborts transport on route retirement and rejects later work on that route', async () => {
  const binding = new AbortController();
  const read = vi.fn(
    (_ids: readonly number[], signal: AbortSignal) =>
      new Promise<ReadonlyMap<number, PublicStatus>>((_, reject) =>
        signal.addEventListener('abort', () => reject(new ProviderError('cancelled')), {
          once: true,
        }),
      ),
  );
  const status = createBatchedModelStatus(read, binding.signal);
  const pending = expect(status(1)).rejects.toMatchObject({ code: 'cancelled' });
  await tick();
  binding.abort();
  await pending;
  expect(read.mock.calls[0]?.[1].aborted).toBe(true);
  await expect(status(2)).rejects.toMatchObject({ code: 'cancelled' });
  expect(read).toHaveBeenCalledTimes(1);
});

it('preserves an upstream failure and allows a subsequent read', async () => {
  const reason = new ProviderError('upstream-http', 403);
  const read = vi
    .fn<() => Promise<ReadonlyMap<number, PublicStatus>>>()
    .mockRejectedValueOnce(reason)
    .mockResolvedValueOnce(new Map([[1, 'PUBLIC']]));
  const status = createBatchedModelStatus(read);
  await expect(status(1)).rejects.toBe(reason);
  await expect(status(1)).resolves.toBe('PUBLIC');
});

it('requests indexed IDs and decodes only unique exact IDs from the requested batch', () => {
  const path = new URL(modelStatusPath([5, 2]), 'https://stripchat.test');
  expect(path.pathname).toBe('/api/front/models/list');
  expect([...path.searchParams]).toEqual([
    ['modelIds[0]', '5'],
    ['modelIds[1]', '2'],
  ]);
  const classify = vi.fn((_row: Record<string, unknown>, id: number): PublicStatus =>
    id === 5 ? 'PUBLIC' : 'OFFLINE',
  );
  expect(modelBatchStatuses('{"models":[{"id":5}]}', [2, 5], classify)).toEqual(
    new Map([[5, 'PUBLIC']]),
  );
  expect(classify).toHaveBeenCalledWith({ id: 5 }, 5);
  expect(() => modelBatchStatuses('{"models":[{"id":5},{"id":5}]}', [5], classify)).toThrow(
    'upstream-identity-mismatch',
  );
  expect(() => modelBatchStatuses('{"models":[{"id":2}]}', [5], classify)).toThrow(
    'upstream-identity-mismatch',
  );
  expect(() => modelBatchStatuses('{"models":[{"id":"5"}]}', [5], classify)).toThrow(
    'upstream-item-unavailable',
  );
});
