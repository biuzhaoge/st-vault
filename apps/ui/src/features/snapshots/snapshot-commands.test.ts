import { expect, it, vi } from 'vitest';
import { SnapshotCommands } from './snapshot-commands';
import type { request } from '../../shared/lib/api';
import type { SnapshotItem } from '@st-vault/api-schema';
import { ApiError, MutationOutcomeUnknown } from '../../shared/lib/api';
import { MAX_SNAPSHOT_SELECTION } from '@st-vault/api-schema';
// Vitest mocks erase generic response parameters; fixture responses are owned here.
function commandsUsing(transport: (...args: Parameters<typeof request>) => Promise<unknown>) {
  return new SnapshotCommands(
    <T>(...args: Parameters<typeof request>) => transport(...args) as Promise<T>,
  );
}
const shot: SnapshotItem = {
  unitId: 'first',
  atMs: 1000,
  slotFromMs: 0,
  slotToMs: 60000,
  url: '/image',
  timeBasis: 'source-pdt',
  uncertaintyMs: 0,
};
it('writes an explicit cross-page selection exactly once at the inspected revision', async () => {
  const transport = vi.fn<typeof request>().mockResolvedValue({ revision: 8, favorites: [] });
  await commandsUsing(transport).setFavorites('s', ['one', 'two', 'one'], 'toggle', 7);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(JSON.parse(transport.mock.calls[0][1]!.body as string)).toEqual({
    unitIds: ['one', 'two'],
    liked: 'toggle',
    revision: 7,
  });
});
it('prepares a larger explicit selection before one atomic favorite operation', async () => {
  const ids = Array.from(
    { length: MAX_SNAPSHOT_SELECTION + 10001 },
    (_, i) => '00000000-0000-4000-8000-' + String(i).padStart(12, '0'),
  );
  const transport = vi
    .fn<typeof request>()
    .mockResolvedValueOnce({ id: 'first', personalRevision: 7, count: 10000 })
    .mockResolvedValueOnce({ id: 'all', personalRevision: 7, count: 10001 })
    .mockResolvedValueOnce({ revision: 8, count: ids.length });
  await expect(commandsUsing(transport).setFavorites('s', ids, 'toggle', 7)).resolves.toMatchObject(
    {
      revision: 8,
    },
  );
  expect(transport.mock.calls.map(([url]) => url)).toEqual([
    '/api/subjects/s/media-selection',
    '/api/subjects/s/media-selection',
    '/api/subjects/s/media-selection/all/favorites',
  ]);
  const bodies = transport.mock.calls.map(
    ([, init]) =>
      JSON.parse(init!.body as string) as {
        includeUnitIds: string[];
        baseSelectionId?: string;
        liked?: boolean | 'toggle';
      },
  );
  expect(bodies[1].baseSelectionId).toBe('first');
  expect(bodies.map((b) => b.includeUnitIds.length)).toEqual([10000, 1, MAX_SNAPSHOT_SELECTION]);
  expect(bodies.flatMap((b) => b.includeUnitIds)).toEqual(ids);
  expect(bodies[2].liked).toBe('toggle');
  expect((transport.mock.calls[0][1]!.body as string).length).toBeLessThan(512 * 1024);
  expect((transport.mock.calls[2][1]!.body as string).length).toBeLessThan(8 * 1024 * 1024);
});
it('reads one unit for a version if the page is loading and submits the entire toggle once', async () => {
  const transport = vi
    .fn<typeof request>()
    .mockResolvedValueOnce({ revision: 11, favorites: [], truncated: false })
    .mockResolvedValueOnce({ revision: 13, favorites: [] });
  await commandsUsing(transport).setFavorites('s', ['first', 'second'], 'toggle', undefined);
  expect(
    transport.mock.calls.map(([path, init]) => [path, JSON.parse(init!.body as string) as unknown]),
  ).toEqual([
    ['/api/subjects/s/unit-favorites/query', { unitIds: ['first'] }],
    [
      '/api/subjects/s/unit-favorites',
      { unitIds: ['first', 'second'], liked: 'toggle', revision: 11 },
    ],
  ]);
});
it('cancels an oversized favorite selection before submitting its only mutation', async () => {
  const ids = Array.from({ length: MAX_SNAPSHOT_SELECTION + 1 }, (_, i) => 'u' + i);
  const controller = new AbortController();
  const transport = vi.fn<typeof request>().mockImplementation(() => {
    controller.abort();
    return Promise.resolve({ id: 'prefix', personalRevision: 7, count: 1 });
  });
  await expect(
    commandsUsing(transport).setFavorites('s', ids, true, 7, controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(transport).toHaveBeenCalledTimes(1);
});
it('rejects a stale large selection without sending a favorite mutation', async () => {
  const ids = Array.from({ length: MAX_SNAPSHOT_SELECTION + 1 }, (_, i) => 'u' + i);
  const transport = vi
    .fn<typeof request>()
    .mockResolvedValueOnce({ id: 'prefix', personalRevision: 8, count: 1 });
  await expect(commandsUsing(transport).setFavorites('s', ids, true, 7)).rejects.toMatchObject({
    status: 409,
  });
  expect(transport).toHaveBeenCalledTimes(1);
});
it('rejects a multi-page fact read if its revision changes between request chunks', async () => {
  const ids = Array.from({ length: MAX_SNAPSHOT_SELECTION + 1 }, (_, i) => 'u' + i);
  const transport = vi
    .fn<typeof request>()
    .mockResolvedValueOnce({ revision: 7, truncated: false, favorites: [] })
    .mockResolvedValueOnce({ revision: 8, truncated: false, favorites: [] });
  await expect(commandsUsing(transport).queryFavorites('s', ids)).rejects.toMatchObject({
    status: 409,
  });
  expect(
    transport.mock.calls.map(
      ([, init]) => (JSON.parse(init!.body as string) as { unitIds: string[] }).unitIds.length,
    ),
  ).toEqual([MAX_SNAPSHOT_SELECTION, 1]);
});
it('withdraws uncertain admission only on the specific missing-receipt response', async () => {
  const transport = vi
    .fn<typeof request>()
    .mockRejectedValueOnce(new ApiError('media_deletion_not_found', 404))
    .mockRejectedValueOnce(new ApiError('route not found', 404))
    .mockRejectedValueOnce(new ApiError('archive_unavailable', 503))
    .mockResolvedValueOnce({ id: 'old', state: 'completed' });
  const commands = commandsUsing(transport);
  await expect(commands.receipt('old')).resolves.toBeNull();
  await expect(commands.receipt('old')).rejects.toMatchObject({ status: 404 });
  await expect(commands.receipt('old')).rejects.toMatchObject({ status: 503 });
  await expect(commands.receipt('old')).resolves.toMatchObject({ id: 'old', state: 'completed' });
  for (const [url, init] of transport.mock.calls) {
    expect(url).toBe('/api/media-deletions/old');
    expect(init?.method ?? 'GET').toBe('GET');
  }
});
it('likes from the current exact favorite snapshot with one revision-protected write', async () => {
  const transport = vi.fn<typeof request>().mockResolvedValue({ favorites: [], revision: 5 });
  await commandsUsing(transport).setFavorite('stripchat:42', shot, true, 4);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0][0]).toBe('/api/subjects/stripchat%3A42/unit-favorites');
  expect(JSON.parse(transport.mock.calls[0][1]!.body as string)).toEqual({
    unitIds: ['first'],
    liked: true,
    revision: 4,
  });
});
it('clears favorites using one frozen full-range token, never enumerating pages', async () => {
  const transport = vi
    .fn<typeof request>()
    .mockResolvedValueOnce({ id: 'token', personalRevision: 4 })
    .mockResolvedValueOnce({ revision: 5 });
  const range = { fromMs: 0, toMs: 120000 };
  await commandsUsing(transport).unlikeRange('s', range, new AbortController().signal);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(JSON.parse(transport.mock.calls[0][1]!.body as string)).toEqual({ ...range, mode: 'all' });
  expect(transport.mock.calls[1][0]).toBe('/api/subjects/s/media-selection/token/favorites');
  expect(JSON.parse(transport.mock.calls[1][1]!.body as string)).toEqual({
    liked: false,
    revision: 4,
  });
  expect(transport.mock.calls[1][1]?.signal).toBeUndefined();
});
it('never submits range unlike after preparation is canceled', async () => {
  const controller = new AbortController();
  const transport = vi.fn<typeof request>().mockImplementation(() => {
    controller.abort();
    return Promise.resolve({ id: 'token', personalRevision: 4 });
  });
  await expect(
    commandsUsing(transport).unlikeRange('s', { fromMs: 0, toMs: 120000 }, controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(transport).toHaveBeenCalledTimes(1);
});
it('releases an uncertain operation without allowing its late completion to unlock a new operation', () => {
  const commands = new SnapshotCommands();
  const old = commands.begin('a')!;
  expect(commands.begin('a')).toBeNull();
  commands.release(old);
  const next = commands.begin('a')!;
  commands.release(old);
  expect(commands.busy).toBe(true);
  expect(commands.current(old, 'a')).toBe(false);
  expect(commands.current(next, 'b')).toBe(false);
  commands.dispose();
  expect(commands.current(next, 'a')).toBe(false);
});
it('revokes preparation admission immediately when its view scope changes', () => {
  const commands = new SnapshotCommands();
  const old = commands.begin('old')!;
  commands.cancelPreparation();
  expect(old.signal.aborted).toBe(true);
  expect(commands.busy).toBe(false);
  const next = commands.begin('new')!;
  expect(next).not.toBeNull();
  commands.release(old);
  expect(commands.current(next)).toBe(true);
  expect(commands.busy).toBe(true);
});
it('submits a durable deletion independently of canceled selection preparation', async () => {
  const transport = vi.fn<typeof request>().mockResolvedValue({});
  const commands = commandsUsing(transport),
    operation = commands.begin('s')!;
  const descriptor = {
    id: 'token',
    subjectId: 's',
    fromMs: 0,
    toMs: 60000,
    count: 1,
    personalRevision: 4,
    deletionRevision: 2,
  };
  commands.cancelPreparation();
  expect(operation.signal.aborted).toBe(true);
  await commands.admitDeletion('s', 'command', {
    kind: 'selection',
    selectionId: descriptor.id,
    fromMs: 0,
    toMs: 60000,
  });
  expect(transport.mock.calls[0][0]).toBe('/api/subjects/s/deletion-intents');
  expect(transport.mock.calls[0][1]?.signal).toBeUndefined();
  expect(transport.mock.calls[0][1]?.keepalive).toBe(true);
});
it('repeats only the same idempotent admission after a lost reply', async () => {
  const transport = vi
    .fn<typeof request>()
    .mockRejectedValueOnce(new MutationOutcomeUnknown(new Error('lost response')))
    .mockResolvedValue({ id: 'command', state: 'preparing' });
  await commandsUsing(transport).admitDeletion('s', 'command', {
    kind: 'units',
    unitIds: ['u'],
    fromMs: 0,
    toMs: 1000,
  });
  expect(transport).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls[1]).toEqual(transport.mock.calls[0]);
});
it('uses one revision-protected unit command without loading favorites for unlike', async () => {
  const transport = vi.fn<typeof request>().mockResolvedValue({ removed: 1, revision: 9 });
  const commands = commandsUsing(transport);
  await commands.setFavorite('stripchat:42', shot, false, 8);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0][0]).toBe('/api/subjects/stripchat%3A42/unit-favorites');
  expect(JSON.parse(transport.mock.calls[0][1]!.body as string)).toEqual({
    unitIds: ['first'],
    liked: false,
    revision: 8,
  });
});
it('uses the same whole-unit identity for deletion and favorites regardless of selection clipping', async () => {
  const transport = vi.fn<typeof request>().mockResolvedValue({});
  const commands = commandsUsing(transport);
  const second = { ...shot, unitId: 'second', atMs: 65000, slotFromMs: 60000, slotToMs: 120000 };
  await commands.admitDeletion('stripchat:42', 'command', {
    kind: 'units',
    unitIds: [shot.unitId, second.unitId],
    fromMs: 0,
    toMs: 120000,
  });
  expect(JSON.parse(transport.mock.calls[0][1]!.body as string)).toEqual({
    commandId: 'command',
    target: { kind: 'units', fromMs: 0, toMs: 120000, unitIds: ['first', 'second'] },
  });
  await commands.setFavorite('stripchat:42', second, false, 1);
  expect(JSON.parse(transport.mock.calls[1][1]!.body as string)).toMatchObject({
    unitIds: ['second'],
    liked: false,
    revision: 1,
  });
});
it('rejects truncated readback rather than pretending the favorite inventory is complete', async () => {
  const transport = vi
    .fn<typeof request>()
    .mockResolvedValue({ favorites: [], revision: 1, truncated: true });
  await expect(commandsUsing(transport).personal('stripchat:42', [shot])).rejects.toThrow(
    'FAVORITES_TRUNCATED',
  );
});
it('does not replay a stale batch confirmation or change its revision', async () => {
  const transport = vi
    .fn<typeof request>()
    .mockRejectedValue(new Error('synthetic stale confirmation'));
  await expect(
    commandsUsing(transport).setFavorite('stripchat:42', shot, false, 8),
  ).rejects.toThrow('stale confirmation');
  expect(transport).toHaveBeenCalledTimes(1);
});

it('bounds unit-favorite preparation and never submits a write after its read expires', async () => {
  vi.useFakeTimers();
  try {
    const transport = vi.fn<typeof request>().mockImplementation(
      (_path, init) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve({ favorites: [], revision: 1, truncated: false }),
            16000,
          );
          init?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(
                init.signal?.reason instanceof Error ? init.signal.reason : new Error('cancelled'),
              );
            },
            { once: true },
          );
        }),
    );
    const commands = commandsUsing(transport);
    const items = Array.from({ length: 28 }, (_, i) => ({
      ...shot,
      unitId: `unit-${i}`,
      atMs: i * 21600000 + 1000,
      slotFromMs: i * 21600000,
      slotToMs: i * 21600000 + 60000,
    }));
    const result = commands.personal('stripchat:42', items).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15000);
    const error: unknown = await result;
    expect(error).toMatchObject({ name: 'TimeoutError' });
    expect(error).not.toBeInstanceOf(MutationOutcomeUnknown);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0]).toContain('/unit-favorites/query');
    expect(transport.mock.calls[0][1]?.operation).toBe('session');
  } finally {
    vi.useRealTimers();
  }
});
it('cancels preparation on scope disposal even when a late transport ignores abort', async () => {
  let finish!: (value: unknown) => void;
  const transport = vi.fn<typeof request>().mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const commands = commandsUsing(transport),
    operation = commands.begin('old')!;
  const result = commands
    .personal('stripchat:42', [shot], operation.signal)
    .catch((error: unknown) => error);
  commands.cancelPreparation();
  finish({ favorites: [], revision: 1, truncated: false });
  expect(await result).toMatchObject({ name: 'AbortError' });
  expect(transport).toHaveBeenCalledTimes(1);
  commands.release(operation);
  const next = commands.begin('new')!;
  commands.release(operation);
  expect(commands.current(next)).toBe(true);
  expect(commands.busy).toBe(true);
  commands.dispose();
  expect(next.signal.aborted).toBe(true);
});
it('queues different units and carries the committed global revision across subjects', async () => {
  let resolveFirst!: (value: unknown) => void;
  const transport = vi
    .fn<typeof request>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    )
    .mockResolvedValueOnce({ favorites: [], revision: 6 });
  const commands = commandsUsing(transport);
  const first = commands.setFavorite('stripchat:42', shot, true, 4);
  const second = commands.setFavorite('stripchat:43', { ...shot, unitId: 'second' }, false, 4);
  expect(commands.hasFavoriteWrites).toBe(true);
  expect(transport).toHaveBeenCalledTimes(1);
  commands.cancelPreparation();
  resolveFirst({ favorites: [], revision: 5 });
  await Promise.all([first, second]);
  expect(transport).toHaveBeenCalledTimes(2);
  expect(JSON.parse(transport.mock.calls[1][1]!.body as string)).toEqual({
    unitIds: ['second'],
    liked: false,
    revision: 5,
  });
  expect(transport.mock.calls[1][1]?.signal).toBeUndefined();
});

it('refreshes the revision for a queued click after rejection without replaying the failed click', async () => {
  const transport = vi
    .fn<typeof request>()
    .mockRejectedValueOnce(new MutationOutcomeUnknown(new Error('lost response')))
    .mockResolvedValueOnce({ favorites: [], revision: 7 })
    .mockResolvedValueOnce({ favorites: [], revision: 8 });
  const commands = commandsUsing(transport);
  const first = commands.setFavorite('stripchat:42', shot, true, 4);
  const second = commands.setFavorite('stripchat:42', { ...shot, unitId: 'second' }, true, 4);
  await expect(first).rejects.toBeInstanceOf(MutationOutcomeUnknown);
  await expect(second).resolves.toMatchObject({ revision: 8 });
  expect(transport).toHaveBeenCalledTimes(3);
  expect(transport.mock.calls[1][0]).toContain('/unit-favorites/query');
  expect(JSON.parse(transport.mock.calls[2][1]!.body as string)).toMatchObject({
    unitIds: ['second'],
    revision: 7,
  });
});
