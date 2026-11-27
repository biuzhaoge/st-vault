/* eslint-disable @typescript-eslint/require-await -- Offline ports preserve their asynchronous production signatures. */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { SyncClock } from '../runtime/sync-clock.js';
import { createAccountSync, type AccountSyncOptions } from './account-sync.js';
import type { AccountSyncPort, SubjectInput } from '../ports.js';
import { ProviderError } from '../provider/http.js';
import type { ImportedAccount } from '../provider/account-profile.js';

const cleanups: AccountSyncPort[] = [];
const clocks: SyncClock[] = [];
afterEach(async () => {
  for (const service of cleanups.splice(0).reverse()) await service.close();
  for (const clock of clocks.splice(0)) await clock.close();
  vi.useRealTimers();
});
const tick = async (): Promise<void> => {
  for (let index = 0; index < 20; index++) await Promise.resolve();
};
function fixture() {
  const clock = new SyncClock({ intervalMs: () => 5000 });
  clocks.push(clock);
  let sealed: string | null = null;
  let activation: string | null = null;
  let following: SubjectInput[] = [];
  const preparations = new Map<string, SubjectInput[]>();
  const vault = {
    readSealedSecret: vi.fn(async () => sealed),
    writeSealedSecret: vi.fn(async (_purpose: 'account-sync', value: string | null) => {
      sealed = value;
    }),
  };
  const archive = {
    identity: vi.fn(async () => ({
      instanceId: '25c22e00-a0f9-4f62-a7fd-e8c4da4d717b',
      userId: 'fixture',
      timelineStartMs: 0,
    })),
    followedAccountSubjects: vi.fn(async () => following),
    archivedAccountSubjects: vi
      .fn<AccountSyncOptions['archive']['archivedAccountSubjects']>()
      .mockResolvedValue([]),
    prepareAccountSubjects: vi.fn(async (subjects: SubjectInput[], id: string) => {
      preparations.set(id, subjects);
    }),
    activateAccountSubjects: vi.fn(async (id: string) => {
      if (activation === id) return;
      const subjects = preparations.get(id);
      if (!subjects) throw Error('ACCOUNT_PREPARATION_MISSING');
      following = subjects;
      activation = id;
      preparations.delete(id);
    }),
    accountActivation: vi.fn(async () => activation),
    discardAccountPreparation: vi.fn(async (id: string) => {
      preparations.delete(id);
    }),
  };
  const provider = {
    importList: vi.fn<(cookies: string, signal?: AbortSignal) => Promise<SubjectInput[]>>(
      async () => [{ id: 'stripchat:42', providerId: 42, handle: 'Synthetic' }],
    ),
  };
  const supervisor = { reconcile: vi.fn(async () => undefined) };
  return {
    vault,
    archive,
    provider,
    supervisor,
    clock,
    saved: () => sealed,
    following: () => following,
  };
}
async function open(
  f: ReturnType<typeof fixture>,
  timeoutMs = 120000,
  transportSignal?: () => AbortSignal,
): Promise<AccountSyncPort> {
  const service = await createAccountSync({
    ...f,
    timeoutMs,
    startupDelayMs: 1000,
    transportSignal,
  });
  cleanups.push(service);
  return service;
}

describe('account roster reconciliation', () => {
  it('queues an archived room confirmed disabled behind a refresh and uses its active generation', async () => {
    const f = fixture();
    const profile = { username: 'fixture-account', followingCount: 0, avatarSourceUrl: null };
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const refreshing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const importAccount = vi
      .fn<NonNullable<AccountSyncOptions['provider']['importAccount']>>()
      .mockResolvedValueOnce({ subjects: [], profile })
      .mockImplementationOnce(async () => {
        started();
        await gate;
        return { subjects: [], profile };
      });
    const removeFavorite = vi.fn(async () => undefined);
    const openArchiveReasonProbe = vi.fn(async () =>
      Object.assign(async () => 'account_disabled' as const, { unfollowBlocked: removeFavorite }),
    );
    const recordVerifiedBlocked = vi.fn(
      async (_id: string, _generation: string, remove: () => Promise<void>) => {
        await remove();
        return 'purged' as const;
      },
    );
    const service = await createAccountSync({
      ...f,
      archive: { ...f.archive, recordVerifiedBlocked },
      provider: { ...f.provider, importAccount, openArchiveReasonProbe },
    });
    cleanups.push(service);
    await service.configure({ cookiesText: 'synthetic' });
    const before = await f.archive.accountActivation();
    const signal = new AbortController().signal;
    const refresh = service.refresh();
    try {
      await refreshing;
      const probe = await service.openArchiveReasonProbe('https://stripchat.com', signal);
      expect(await probe(42, signal)).toBe('account_disabled');
      expect(probe.cleanupBlocked).toBeTypeOf('function');
      const cleanup = probe.cleanupBlocked!('stripchat:42', 42, signal);
      await tick();
      expect(recordVerifiedBlocked).not.toHaveBeenCalled();
      release();
      await refresh;
      expect(await cleanup).toBe('purged');
      const active = await f.archive.accountActivation();
      expect(active).not.toBe(before);
      expect(recordVerifiedBlocked).toHaveBeenCalledWith(
        'stripchat:42',
        active,
        expect.any(Function),
      );
      expect(removeFavorite).toHaveBeenCalledWith(42, expect.any(AbortSignal));

      const unavailable = new ProviderError('upstream-http', 429);
      removeFavorite.mockRejectedValueOnce(unavailable);
      const retry = await service.openArchiveReasonProbe('https://stripchat.com', signal);
      expect(await retry(42, signal)).toBe('account_disabled');
      await expect(retry.cleanupBlocked!('stripchat:42', 42, signal)).rejects.toBe(unavailable);
      expect(service.status().error).toBeNull();
    } finally {
      release();
      await refresh;
    }
  });

  it('publishes newly indexed IDs while a same-account refresh waits for profiles', async () => {
    const f = fixture();
    const existing = { id: 'stripchat:42', providerId: 42, handle: 'Existing' };
    const newcomer = { id: 'stripchat:43', providerId: 43, handle: 'Newcomer' };
    const profile = { username: 'fixture-account', followingCount: 2, avatarSourceUrl: null };
    let published!: () => void;
    let release!: () => void;
    const indexed = new Promise<void>((resolve) => {
      published = resolve;
    });
    const details = new Promise<void>((resolve) => {
      release = resolve;
    });
    const addIndexedAccountSubjects = vi.fn().mockResolvedValue(1);
    const importAccount = vi
      .fn<NonNullable<AccountSyncOptions['provider']['importAccount']>>()
      .mockResolvedValueOnce({ subjects: [existing], profile })
      .mockImplementationOnce(async (...args) => {
        await args[6]?.onIndexed?.({ profile, indexedIds: [42, 43] });
        published();
        await details;
        return { subjects: [existing, newcomer], profile };
      });
    const service = await createAccountSync({
      ...f,
      archive: { ...f.archive, addIndexedAccountSubjects },
      provider: { ...f.provider, importAccount },
    });
    cleanups.push(service);
    await service.configure({ cookiesText: 'synthetic' });
    const listener = vi.fn();
    service.subscribe?.(listener);
    const generation = await f.archive.accountActivation();
    const refresh = service.refresh();
    try {
      await indexed;
      expect(addIndexedAccountSubjects).toHaveBeenCalledWith(
        [42, 43],
        generation,
        expect.any(AbortSignal),
      );
      expect(listener).toHaveBeenCalledWith('subjects');
      expect(f.following()).toEqual([existing]);
    } finally {
      release();
      await refresh;
    }
    expect(f.following()).toEqual([existing, newcomer]);
  });

  it('refreshes full profiles on a slower cadence while keeping the roster heartbeat', async () => {
    vi.useFakeTimers();
    const first = 2_000_000_000_000;
    vi.setSystemTime(first);
    const f = fixture();
    const importAccount = vi
      .fn<NonNullable<AccountSyncOptions['provider']['importAccount']>>()
      .mockResolvedValue({
        subjects: [],
        profile: { username: 'fixture-account', followingCount: 0, avatarSourceUrl: null },
      });
    const service = await createAccountSync({ ...f, provider: { ...f.provider, importAccount } });
    cleanups.push(service);
    await service.configure({ cookiesText: 'synthetic' });
    expect(importAccount.mock.calls.map((args) => args[6]?.refreshProfiles)).toEqual([true]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(importAccount.mock.calls.map((args) => args[6]?.refreshProfiles)).toEqual([true, false]);
    vi.setSystemTime(first + 5 * 60_000);
    await f.clock.runNow('account-list');
    expect(importAccount.mock.calls.map((args) => args[6]?.refreshProfiles)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it('keeps the bound roster if an ordinary refresh reports a different owner', async () => {
    const f = fixture();
    const existing = { id: 'stripchat:42', providerId: 42, handle: 'Existing' };
    const profile = { username: 'fixture-account', followingCount: 1, avatarSourceUrl: null };
    const other = { ...profile, username: 'other-account' };
    const addIndexedAccountSubjects = vi.fn().mockResolvedValue(1);
    const importAccount = vi
      .fn<NonNullable<AccountSyncOptions['provider']['importAccount']>>()
      .mockResolvedValueOnce({ subjects: [existing], profile })
      .mockImplementationOnce(async (...args) => {
        await args[6]?.onIndexed?.({ profile: other, indexedIds: [43] });
        return { subjects: [], profile: other };
      });
    const service = await createAccountSync({
      ...f,
      archive: { ...f.archive, addIndexedAccountSubjects },
      provider: { ...f.provider, importAccount },
    });
    cleanups.push(service);
    await service.configure({ cookiesText: 'synthetic' });
    await expect(service.refresh()).rejects.toMatchObject({ code: 'list_import_failed' });
    expect(addIndexedAccountSubjects).not.toHaveBeenCalled();
    expect(f.following()).toEqual([existing]);
    expect(service.status().profile?.username).toBe(profile.username);
  });

  it('stages the provider-verified roster and reports any missing subjects held for verification', async () => {
    const f = fixture();
    const present = { id: 'stripchat:42', providerId: 42, handle: 'Present' };
    const held = { id: 'stripchat:43', providerId: 43, handle: 'Held' };
    const removed = { id: 'stripchat:44', providerId: 44, handle: 'Unfollowed' };
    const profile = { username: 'fixture-account', followingCount: 3, avatarSourceUrl: null };
    const importAccount =
      vi.fn<
        (
          cookies: string,
          signal?: AbortSignal,
          onValidated?: () => void,
          origin?: string,
          known?: (username: string) => Promise<readonly SubjectInput[]>,
        ) => Promise<ImportedAccount>
      >();
    importAccount.mockImplementationOnce(async (...args) => {
      expect(await args[4]!(profile.username)).toEqual([]);
      return { subjects: [present, held, removed], profile };
    });
    const service = await createAccountSync({ ...f, provider: { ...f.provider, importAccount } });
    cleanups.push(service);
    await service.configure({ cookiesText: 'synthetic-A' });
    expect(importAccount).toHaveBeenLastCalledWith(
      'synthetic-A',
      expect.any(AbortSignal),
      expect.any(Function),
      'https://stripchat.com',
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ refreshProfiles: true }),
    );

    importAccount.mockImplementationOnce(async (...args) => {
      expect(await args[4]!(profile.username)).toEqual([present, held, removed]);
      return { subjects: [present, held], profile, unverifiedMissingCount: 1 };
    });
    expect(await service.refresh()).toMatchObject({
      imported: 1,
      status: { pendingMissingCount: 1, error: null, needsReconnect: false },
    });
    expect(importAccount).toHaveBeenLastCalledWith(
      'synthetic-A',
      expect.any(AbortSignal),
      expect.any(Function),
      'https://stripchat.com',
      expect.any(Function),
      expect.any(Function),
      expect.objectContaining({ refreshProfiles: true }),
    );
    expect(f.following()).toEqual([present, held]);
    importAccount.mockResolvedValueOnce({ subjects: [present, held], profile });
    expect((await service.refresh()).status.pendingMissingCount).toBeUndefined();
    const nextProfile = { ...profile, username: 'next-owner' };
    importAccount.mockImplementationOnce(async (...args) => {
      expect(await args[4]!(nextProfile.username)).toEqual([]);
      return { subjects: [present], profile: nextProfile };
    });
    await service.configure({ cookiesText: 'synthetic-B' });
    expect(f.following()).toEqual([present]);
    await service.disconnect();
    expect(f.following()).toEqual([]);
  });

  it('rotates bounded archived candidates and starts over when the roster reaches the end', async () => {
    const f = fixture();
    const candidates = [1, 2, 3, 4, 5].map((providerId) => ({
      id: `stripchat:${providerId}`,
      providerId,
      handle: `archived-${providerId}`,
    }));
    f.archive.archivedAccountSubjects.mockImplementation(async (cursor, limit) =>
      candidates.filter(({ providerId }) => providerId > cursor).slice(0, limit),
    );
    const profile = { username: 'fixture-account', followingCount: 0, avatarSourceUrl: null };
    const importAccount = vi.fn<NonNullable<AccountSyncOptions['provider']['importAccount']>>(
      async (_cookies, _signal, _onValidated, _origin, _known, recover) => {
        await recover?.(profile.username);
        return { subjects: [], profile };
      },
    );
    const service = await createAccountSync({ ...f, provider: { ...f.provider, importAccount } });
    cleanups.push(service);
    await service.configure({ cookiesText: 'synthetic-A' });
    await service.refresh();
    await service.refresh();
    expect(f.archive.archivedAccountSubjects.mock.calls).toEqual([
      [0, 4],
      [4, 4],
      [0, 4],
    ]);
  });

  it('includes indexed archived IDs outside the rotation and publishes roster counts', async () => {
    const f = fixture();
    const old = { id: 'stripchat:1', providerId: 1, handle: 'old' };
    const indexed = { id: 'stripchat:9', providerId: 9, handle: 'indexed' };
    const pending = { id: 'stripchat:15', providerId: 15, handle: '主播 #15' };
    const importAccount = vi.fn<NonNullable<AccountSyncOptions['provider']['importAccount']>>(
      async (_cookies, _signal, _onValidated, _origin, _known, recover) => {
        expect(await recover?.('fixture-account', [9, 15])).toEqual([old, indexed]);
        return {
          subjects: [
            indexed,
            { ...pending, subjectProfilePending: true },
            { ...old, accountArchiveReason: 'region_restricted' },
          ],
          profile: { username: 'fixture-account', followingCount: 2, avatarSourceUrl: null },
          indexCount: 2,
          verifiedFollowingCount: 2,
          unresolvedProfileCount: 1,
        };
      },
    );
    f.archive.archivedAccountSubjects.mockImplementation(async (_cursor, _limit, ids) =>
      ids ? [indexed] : [old],
    );
    const service = await createAccountSync({ ...f, provider: { ...f.provider, importAccount } });
    cleanups.push(service);
    await expect(service.configure({ cookiesText: 'synthetic-A' })).resolves.toMatchObject({
      imported: 2,
      status: { favoritesIndexCount: 2, pendingProfileCount: 1 },
    });
    await service.disconnect();
    expect(service.status()).not.toHaveProperty('favoritesIndexCount');
    expect(service.status()).not.toHaveProperty('pendingProfileCount');
  });
});

describe('persistent account synchronization', () => {
  it('cancels an old transport import without treating its response as a credential failure', async () => {
    const f = fixture();
    let transport = new AbortController();
    const service = await open(f, undefined, () => transport.signal);
    await service.configure({ cookiesText: 'synthetic-A' });
    let finish!: (value: SubjectInput[]) => void;
    const oldImport = new Promise<SubjectInput[]>((resolve) => (finish = resolve));
    f.provider.importList.mockReturnValueOnce(oldImport);
    const pending = service.refresh();
    const outcome = pending.catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(f.provider.importList).toHaveBeenCalledTimes(2));
      const signal = f.provider.importList.mock.calls[1][1];
      transport.abort();
      transport = new AbortController();
      expect(signal?.aborted).toBe(true);
      finish([{ id: 'stripchat:84', providerId: 84, handle: 'old-route' }]);
      expect(await outcome).toMatchObject({ code: 'account_sync_cancelled' });
      expect(f.following().map((row) => row.id)).toEqual(['stripchat:42']);
      expect(service.status()).toMatchObject({ needsReconnect: false, error: null });
      await service.refresh();
      expect(f.provider.importList.mock.calls[2][1]?.aborted).toBe(false);
    } finally {
      finish([]);
      await outcome;
    }
  });

  it('rechecks the transport immediately before accepting prepared account membership', async () => {
    const f = fixture();
    let transport = new AbortController();
    const service = await open(f, undefined, () => transport.signal);
    await service.configure({ cookiesText: 'synthetic-A' });
    const prepare = f.archive.prepareAccountSubjects.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    f.provider.importList.mockResolvedValueOnce([
      { id: 'stripchat:84', providerId: 84, handle: 'old-route' },
    ]);
    f.archive.prepareAccountSubjects.mockImplementationOnce(async (...args) => {
      await gate;
      await prepare(...args);
    });
    const outcome = service.refresh().catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(f.archive.prepareAccountSubjects).toHaveBeenCalledTimes(2));
      transport.abort();
      transport = new AbortController();
      release();
      expect(await outcome).toMatchObject({ code: 'account_sync_cancelled' });
      expect(f.archive.activateAccountSubjects).toHaveBeenCalledOnce();
      expect(f.archive.discardAccountPreparation).toHaveBeenCalledOnce();
      expect(f.following().map((row) => row.id)).toEqual(['stripchat:42']);
      expect(service.status()).toMatchObject({ needsReconnect: false, error: null });
    } finally {
      release();
      await outcome;
    }
  });

  it('does not publish membership when cancellation arrives during preparation', async () => {
    const f = fixture(),
      service = await open(f);
    await service.configure({ cookiesText: 'synthetic-A' });
    const prepare = f.archive.prepareAccountSubjects.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.provider.importList.mockResolvedValueOnce([
      { id: 'stripchat:84', providerId: 84, handle: 'new-account' },
    ]);
    f.archive.prepareAccountSubjects.mockImplementationOnce(async (...args) => {
      await gate;
      await prepare(...args);
    });
    const controller = new AbortController();
    const pending = service.configure({ cookiesText: 'synthetic-B' }, controller.signal);
    const rejected = expect(pending).rejects.toThrow('account_sync_cancelled');
    try {
      await vi.waitFor(() => expect(f.archive.prepareAccountSubjects).toHaveBeenCalledTimes(2));
      controller.abort();
      release();
      await rejected;
      await tick();
      expect(f.following().map((row) => row.id)).toEqual(['stripchat:42']);
      expect(f.saved()).toContain('synthetic-A');
    } finally {
      release();
      await rejected;
    }
  });
  it('finishes accepted membership and credentials even when the caller stops waiting', async () => {
    const f = fixture(),
      service = await open(f);
    await service.configure({ cookiesText: 'synthetic-A' });
    const activate = f.archive.activateAccountSubjects.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.archive.activateAccountSubjects.mockImplementationOnce(async (id) => {
      await gate;
      await activate(id);
    });
    f.provider.importList.mockResolvedValueOnce([
      { id: 'stripchat:84', providerId: 84, handle: 'new-account' },
    ]);
    const controller = new AbortController();
    const work = service.configure({ cookiesText: 'synthetic-B' }, controller.signal);
    const cancelled = expect(work).rejects.toThrow('account_sync_cancelled');
    try {
      await vi.waitFor(() => expect(f.archive.activateAccountSubjects).toHaveBeenCalledTimes(2));
      controller.abort();
      await cancelled;
      expect(service.status().running).toBe(true);
      release();
      await vi.waitFor(() => expect(service.status().running).toBe(false));
      expect(f.following().map((row) => row.id)).toEqual(['stripchat:84']);
      expect(JSON.parse(f.saved()!) as unknown).toMatchObject({
        active: { cookiesText: 'synthetic-B' },
        pending: null,
      });
    } finally {
      release();
      await cancelled;
    }
  });
  it('retries finalization on the shared clock without reimporting a successfully activated account', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      service = await open(f);
    await service.configure({ cookiesText: 'synthetic-A' });
    const write = f.vault.writeSealedSecret.getMockImplementation()!;
    f.vault.writeSealedSecret
      .mockImplementationOnce(write)
      .mockRejectedValueOnce(Error('FINAL_PRIVATE_WRITE_FAILED'));
    f.provider.importList.mockResolvedValueOnce([
      { id: 'stripchat:84', providerId: 84, handle: 'new-account' },
    ]);
    await expect(service.configure({ cookiesText: 'synthetic-B' })).rejects.toThrow(
      'account_sync_unavailable',
    );
    expect(f.following().map((row) => row.id)).toEqual(['stripchat:84']);
    expect(service.status()).toMatchObject({
      connected: true,
      needsReconnect: false,
      error: 'account_sync_unavailable',
    });
    const imports = f.provider.importList.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.provider.importList).toHaveBeenCalledTimes(imports);
    expect(f.archive.activateAccountSubjects).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.saved()!) as unknown).toMatchObject({
      active: { cookiesText: 'synthetic-B' },
      pending: null,
    });
    expect(service.status().error).toBeNull();
  });
  it('recovers a sealed pending account before exposing refreshed membership after restart', async () => {
    const f = fixture(),
      service = await open(f);
    await service.configure({ cookiesText: 'synthetic-A' });
    f.archive.activateAccountSubjects.mockRejectedValueOnce(Error('MEDIA_UNAVAILABLE'));
    f.provider.importList.mockResolvedValueOnce([
      { id: 'stripchat:84', providerId: 84, handle: 'new-account' },
    ]);
    await expect(service.configure({ cookiesText: 'synthetic-B' })).rejects.toThrow(
      'account_sync_unavailable',
    );
    expect(f.following().map((row) => row.id)).toEqual(['stripchat:42']);
    await service.close();
    const restarted = await open(f);
    expect(f.following().map((row) => row.id)).toEqual(['stripchat:84']);
    expect(JSON.parse(f.saved()!) as unknown).toMatchObject({
      active: { cookiesText: 'synthetic-B' },
      pending: null,
    });
    expect(restarted.status()).toMatchObject({ connected: true, error: null });
    await restarted.refresh();
    expect(f.provider.importList).toHaveBeenLastCalledWith('synthetic-B', expect.any(AbortSignal));
  });
  it('reports a foreign pending library and can disconnect before a new connection', async () => {
    const f = fixture(),
      service = await open(f);
    await service.configure({ cookiesText: 'synthetic-A' });
    f.archive.activateAccountSubjects.mockRejectedValueOnce(Error('MEDIA_UNAVAILABLE'));
    await expect(service.configure({ cookiesText: 'synthetic-B' })).rejects.toThrow(
      'account_sync_unavailable',
    );
    await service.close();
    f.archive.identity.mockResolvedValue({
      instanceId: '4d2786bd-9b19-40db-85b7-f72dbf3d38be',
      userId: 'other',
      timelineStartMs: 0,
    });
    const restarted = await open(f);
    expect(restarted.status()).toMatchObject({
      error: 'account_library_changed',
      needsReconnect: true,
      nextAttemptMs: null,
    });
    const applied = f.archive.activateAccountSubjects.mock.calls.length;
    await restarted.disconnect();
    expect(f.saved()).toBeNull();
    expect(f.archive.activateAccountSubjects).toHaveBeenCalledTimes(applied + 1);
    expect(f.archive.discardAccountPreparation).not.toHaveBeenCalled();
    await restarted.configure({ cookiesText: 'synthetic-C' });
    expect(restarted.status()).toMatchObject({ connected: true, error: null });
  });
  it('reports cookie validation and list synchronization before the import completes', async () => {
    const f = fixture();
    let validated!: () => void;
    let finish!: (value: {
      subjects: SubjectInput[];
      profile: { username: string; followingCount: number; avatarSourceUrl: null };
    }) => void;
    const provider = {
      ...f.provider,
      importAccount: vi.fn((_cookies: string, _signal?: AbortSignal, onValidated?: () => void) => {
        validated = () => onValidated?.();
        return new Promise<Parameters<typeof finish>[0]>((resolve) => {
          finish = resolve;
        });
      }),
    };
    const service = await createAccountSync({ ...f, provider });
    cleanups.push(service);
    const phases: (string | undefined)[] = [];
    const unsubscribe = service.subscribe?.(() => phases.push(service.status().stage));
    const work = service.configure({ cookiesText: 'synthetic-cookie' });
    try {
      await vi.waitFor(() => expect(provider.importAccount).toHaveBeenCalled());
      expect(service.status()).toMatchObject({
        running: true,
        stage: 'validating',
        connected: false,
      });
      validated();
      expect(service.status()).toMatchObject({ running: true, stage: 'syncing', connected: false });
      finish({
        subjects: [],
        profile: { username: 'Fixture', followingCount: 0, avatarSourceUrl: null },
      });
      expect((await work).status).toMatchObject({ running: false, connected: true });
      expect(service.status()).not.toHaveProperty('stage');
      expect(phases).toContain('validating');
      expect(phases).toContain('syncing');
      expect(phases).toContain('saving');
    } finally {
      finish?.({
        subjects: [],
        profile: { username: 'Fixture', followingCount: 0, avatarSourceUrl: null },
      });
      await work;
      unsubscribe?.();
    }
  });
  it('acknowledges a persisted account before photographic covers finish in the background', async () => {
    const f = fixture();
    let complete!: () => void;
    const ready = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const onImported = vi.fn(() => ready);
    const service = await createAccountSync({ ...f, onImported });
    cleanups.push(service);
    const work = service.configure({
      cookiesText: 'synthetic-cookie',
    });
    try {
      await vi.waitFor(() => expect(onImported).toHaveBeenCalledWith(['stripchat:42']));
      expect(service.status().running).toBe(false);
      expect(service.status()).toMatchObject({ connected: true, warmingCovers: true });
      expect((await work).status.running).toBe(false);
      f.provider.importList.mockResolvedValueOnce([
        { id: 'stripchat:42', providerId: 42, handle: 'Synthetic' },
        { id: 'stripchat:84', providerId: 84, handle: 'New' },
      ]);
      await service.refresh();
      expect(onImported).toHaveBeenNthCalledWith(2, ['stripchat:42', 'stripchat:84']);
      complete();
      expect((await work).status.running).toBe(false);
    } finally {
      complete();
      await work;
    }
  });
  it('validates and prepares before private acceptance and schedules one refresh per shared clock interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000000000000);
    const f = fixture(),
      service = await open(f);
    let observedSaved: string | null = 'unset';
    const prepare = f.archive.prepareAccountSubjects.getMockImplementation()!;
    f.archive.prepareAccountSubjects.mockImplementation(async (...args) => {
      observedSaved = f.saved();
      await prepare(...args);
    });
    const result = await service.configure({
      cookiesText: 'synthetic-first-cookie',
    });
    await tick();
    expect(observedSaved).toBeNull();
    expect(result.imported).toBe(1);
    const preparedGeneration = f.archive.prepareAccountSubjects.mock.calls[0][1];
    expect(preparedGeneration).toMatch(/^[a-f0-9-]{36}$/);
    expect(f.archive.activateAccountSubjects).toHaveBeenCalledWith(preparedGeneration);
    expect(JSON.parse(f.vault.writeSealedSecret.mock.calls[0][1]!) as unknown).toMatchObject({
      version: 2,
      active: null,
      pending: { generation: preparedGeneration },
    });
    expect(service.status()).toMatchObject({
      connected: true,
      running: false,
      needsReconnect: false,
      lastImportedCount: 1,
      error: null,
      nextAttemptMs: Date.now() + 5000,
    });
    expect(result.status).not.toHaveProperty('cookiesText');
    expect(f.saved()).toContain('synthetic-first-cookie');
    expect(f.provider.importList).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.provider.importList).toHaveBeenCalledTimes(2);
    expect(f.supervisor.reconcile).toHaveBeenCalledTimes(2);
    expect(service.status().nextAttemptMs).toBe(Date.now() + 5000);
  });
  it('commits profile with the same credential record, exposes only a local avatar URL and removes it on disconnect', async () => {
    const f = fixture(),
      importAccount = vi.fn<() => Promise<ImportedAccount>>(async () => ({
        subjects: [{ id: 'stripchat:42', providerId: 42, handle: 'Synthetic' }],
        profile: {
          username: 'synthetic-profile',
          followingCount: 41,
          avatarSourceUrl: 'https://static-proxy.strpst.com/avatars/synthetic',
        },
      }));
    Object.assign(f.provider, { importAccount });
    const service = await open(f);
    await service.configure({
      cookiesText: 'synthetic-account-cookie',
    });
    expect(f.provider.importList).not.toHaveBeenCalled();
    expect(importAccount).toHaveBeenCalledOnce();
    expect(f.vault.writeSealedSecret).toHaveBeenCalledTimes(2);
    expect((JSON.parse(f.saved()!) as { active: unknown }).active).toMatchObject({
      cookiesText: 'synthetic-account-cookie',
      profile: { username: 'synthetic-profile', followingCount: 41 },
    });
    const status = service.status();
    expect(status.profile).toMatchObject({
      username: 'synthetic-profile',
      followingCount: 41,
    });
    expect(status.profile?.avatarUrl).toMatch(
      /^\/api\/account-sync\/avatar\?version=[a-f0-9]{16}$/,
    );
    expect(JSON.stringify(status)).not.toContain('static-proxy');
    expect(JSON.stringify(status)).not.toContain('synthetic-account-cookie');
    importAccount.mockRejectedValueOnce(new ProviderError('account-session-unavailable'));
    await expect(
      service.configure({
        cookiesText: 'synthetic-rejected-account',
      }),
    ).rejects.toThrow('cookies_expired');
    expect(service.status().profile?.username).toBe('synthetic-profile');
    await service.disconnect();
    expect(service.status().profile).toBeNull();
    expect(f.saved()).toBeNull();
  });
  it('proxies only anonymous whitelisted avatar bytes, coalesces requests and rejects stale data after disconnect', async () => {
    const f = fixture(),
      image = Buffer.from([255, 216, 255, 217]);
    Object.assign(f.provider, {
      importAccount: async (): Promise<ImportedAccount> => ({
        subjects: [],
        profile: {
          username: 'synthetic-avatar',
          followingCount: 0,
          avatarSourceUrl: 'https://static-proxy.strpst.com/avatars/synthetic',
        },
      }),
    });
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
        finish = resolve;
      }),
      fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        expect(new URL(url).origin).toBe('https://static-proxy.strpst.com');
        expect(init?.credentials).toBe('omit');
        expect(new Headers(init?.headers).has('cookie')).toBe(false);
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        await gate;
        return new Response(image);
      });
    const service = await createAccountSync({ ...f, fetch });
    cleanups.push(service);
    await service.configure({
      cookiesText: 'secret-not-forwarded',
    });
    const avatar = service.avatar(),
      second = service.avatar();
    const rejectFirst = expect(avatar).rejects.toThrow(),
      rejectSecond = expect(second).rejects.toThrow();
    await tick();
    expect(fetch).toHaveBeenCalledOnce();
    await service.disconnect();
    finish?.();
    await rejectFirst;
    await rejectSecond;
    await expect(service.avatar()).rejects.toThrow('account_sync_disconnected');
  });
  it('keeps a shared avatar read after one waiter cancels and uses its bounded cache for interval-only updates', async () => {
    const f = fixture(),
      image = Buffer.from([255, 216, 255, 217]);
    Object.assign(f.provider, {
      importAccount: async (): Promise<ImportedAccount> => ({
        subjects: [],
        profile: {
          username: 'synthetic-avatar',
          followingCount: 0,
          avatarSourceUrl: 'https://static-proxy.strpst.com/avatars/synthetic',
        },
      }),
    });
    let finish: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
        finish = resolve;
      }),
      fetch = vi.fn(async () => {
        await gate;
        return new Response(image);
      });
    const service = await createAccountSync({ ...f, fetch });
    cleanups.push(service);
    await service.configure({ cookiesText: 'synthetic' });
    const controller = new AbortController(),
      first = service.avatar(controller.signal),
      rejected = expect(first).rejects.toThrow(),
      second = service.avatar();
    await tick();
    controller.abort();
    await rejected;
    finish?.();
    expect([...(await second)]).toEqual([...image]);
    const avatarUrl = service.status().profile?.avatarUrl;
    await service.refresh();
    expect(service.status().profile?.avatarUrl).toBe(avatarUrl);
    expect([...(await service.avatar())]).toEqual([...image]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(service.status().connected).toBe(true);
  });
  it('keeps previous credentials, schedule and directory when replacement validation fails', async () => {
    const f = fixture(),
      service = await open(f);
    await service.configure({
      cookiesText: 'synthetic-old',
    });
    await tick();
    const saved = f.saved();
    f.provider.importList.mockRejectedValueOnce(new ProviderError('account-session-unavailable'));
    await expect(
      service.configure({
        cookiesText: 'synthetic-invalid',
      }),
    ).rejects.toThrow('cookies_expired');
    await tick();
    expect(f.saved()).toBe(saved);
    expect(f.archive.prepareAccountSubjects).toHaveBeenCalledTimes(1);
    expect(service.status()).toMatchObject({
      connected: true,
      needsReconnect: false,
      // Failed candidate validation is reported by configure(), not by the unchanged connection.
      error: null,
    });
    expect(service.status().nextAttemptMs).not.toBeNull();
  });
  it('stops automatic attempts for a guest or 401, retains credentials, and permits explicit reconnect refresh', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      service = await open(f);
    await service.configure({
      cookiesText: 'synthetic-valid',
    });
    await tick();
    f.provider.importList.mockRejectedValueOnce(new ProviderError('upstream-http', 401));
    await expect(service.refresh()).rejects.toThrow('cookies_expired');
    await tick();
    expect(service.status()).toMatchObject({
      connected: true,
      needsReconnect: true,
      error: 'cookies_expired',
      nextAttemptMs: null,
    });
    expect(f.saved()).toContain('synthetic-valid');
    await vi.advanceTimersByTimeAsync(30000);
    expect(f.provider.importList).toHaveBeenCalledTimes(2);
    await service.refresh();
    await tick();
    expect(service.status()).toMatchObject({
      connected: true,
      needsReconnect: false,
      error: null,
    });
    expect(service.status().nextAttemptMs).not.toBeNull();
  });
  it('keeps 403/network failures retryable only on the next configured cycle and restores attempt time across restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2000000000000);
    const f = fixture(),
      first = await open(f);
    await first.configure({
      cookiesText: 'synthetic-valid',
    });
    await tick();
    f.provider.importList.mockRejectedValueOnce(new ProviderError('upstream-http', 403));
    await expect(first.refresh()).rejects.toThrow('account_access_denied');
    await tick();
    expect(first.status()).toMatchObject({
      needsReconnect: false,
      error: 'account_access_denied',
      nextAttemptMs: Date.now() + 5000,
      consecutiveFailures: 1,
    });
    await first.close();
    await vi.advanceTimersByTimeAsync(1000);
    const resumed = await open(f);
    expect(resumed.status().nextAttemptMs).toBe(Date.now() + 4000);
    expect(f.provider.importList).toHaveBeenCalledTimes(2);
    f.provider.importList.mockRejectedValueOnce(new Error('sensitive-upstream-detail'));
    await vi.advanceTimersByTimeAsync(4000);
    expect(resumed.status()).toMatchObject({
      error: 'list_import_failed',
      needsReconnect: false,
      nextAttemptMs: Date.now() + 5000,
      consecutiveFailures: 1,
    });
    await resumed.close();
    await vi.advanceTimersByTimeAsync(6000);
    const overdue = await open(f);
    expect(overdue.status().nextAttemptMs).toBe(Date.now() + 1000);
    expect(f.provider.importList).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.provider.importList).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(3000);
    expect(f.provider.importList).toHaveBeenCalledTimes(4);
    expect(overdue.status().consecutiveFailures).toBe(0);
  });
  it('counts only completed roster refreshes and resets after a successful interval', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const service = await open(f);
    await service.configure({ cookiesText: 'synthetic-valid' });
    f.provider.importList
      .mockRejectedValueOnce(new ProviderError('upstream-http', 503))
      .mockRejectedValueOnce(new ProviderError('upstream-http', 502));
    let previousFailures = 0;
    for (const consecutiveFailures of [1, 2, 0]) {
      await vi.advanceTimersByTimeAsync(4000);
      expect(service.status().consecutiveFailures).toBe(previousFailures);
      await vi.advanceTimersByTimeAsync(1000);
      expect(service.status().consecutiveFailures).toBe(consecutiveFailures);
      previousFailures = consecutiveFailures;
    }
  });
  it('coalesces manual refresh and holds single flight through timeout and delayed importer cleanup', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      service = await open(f, 100);
    await service.configure({
      cookiesText: 'synthetic-valid',
    });
    await tick();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.provider.importList.mockImplementationOnce(async () => {
      await gate;
      return [];
    });
    const first = service.refresh(),
      second = service.refresh();
    const firstCheck = expect(first).rejects.toThrow('account_sync_timeout'),
      secondCheck = expect(second).rejects.toThrow('account_sync_timeout');
    await tick();
    expect(f.provider.importList).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    await firstCheck;
    await secondCheck;
    expect(service.status()).toMatchObject({
      running: true,
      error: 'account_sync_timeout',
    });
    await expect(service.refresh()).rejects.toThrow('account_sync_timeout');
    expect(f.provider.importList).toHaveBeenCalledTimes(2);
    release?.();
    await tick();
    expect(service.status().running).toBe(false);
    expect(f.archive.prepareAccountSubjects).toHaveBeenCalledTimes(1);
  });
  it('invalidates late refresh results before a new PUT and serializes actual importers', async () => {
    const f = fixture(),
      service = await open(f);
    await service.configure({
      cookiesText: 'synthetic-old',
    });
    await tick();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.provider.importList.mockImplementationOnce(async () => {
      await gate;
      return [{ id: 'stripchat:99', providerId: 99, handle: 'Stale' }];
    });
    const refresh = service.refresh(),
      refreshCheck = expect(refresh).rejects.toThrow('account_sync_cancelled');
    await tick();
    const configuring = service.configure({
      cookiesText: 'synthetic-new',
    });
    await refreshCheck;
    await tick();
    expect(f.provider.importList).toHaveBeenCalledTimes(2);
    release?.();
    await configuring;
    await tick();
    expect(f.provider.importList).toHaveBeenCalledTimes(3);
    expect(f.archive.prepareAccountSubjects).toHaveBeenCalledTimes(2);
    expect(
      f.archive.prepareAccountSubjects.mock.calls
        .flatMap((call) => call[0])
        .some((row) => row.id === 'stripchat:99'),
    ).toBe(false);
    expect(f.saved()).toContain('synthetic-new');
  });
  it('DELETE drains an ignored cancellation and durably clears without late resurrection', async () => {
    const f = fixture(),
      service = await open(f);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.provider.importList.mockImplementationOnce(async () => {
      await gate;
      return [{ id: 'stripchat:99', providerId: 99, handle: 'Stale' }];
    });
    const configuring = service.configure({
        cookiesText: 'synthetic-late',
      }),
      rejected = expect(configuring).rejects.toThrow('account_sync_cancelled');
    await tick();
    let deleted = false;
    const deleting = service.disconnect().then(() => {
      deleted = true;
    });
    await rejected;
    await tick();
    expect(deleted).toBe(false);
    release?.();
    await deleting;
    await tick();
    expect(f.archive.prepareAccountSubjects).toHaveBeenCalledWith([], expect.any(String), true);
    expect(f.saved()).toBeNull();
    expect(service.status()).toMatchObject({
      connected: false,
      nextAttemptMs: null,
      error: null,
    });
    const reopened = await open(f);
    expect(reopened.status().connected).toBe(false);
    await expect(service.refresh()).rejects.toThrow('account_sync_disconnected');
  });
  it('close cancels and drains an accepted PUT, even if the provider ignores cancellation', async () => {
    const f = fixture(),
      service = await open(f);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.provider.importList.mockImplementationOnce(async () => {
      await gate;
      return [];
    });
    const putting = service.configure({
        cookiesText: 'synthetic-late',
      }),
      rejected = expect(putting).rejects.toThrow('account_sync_cancelled');
    await tick();
    let drained = false;
    const closing = service.close();
    expect(service.close()).toBe(closing);
    void closing.then(() => {
      drained = true;
    });
    await rejected;
    await tick();
    expect(drained).toBe(false);
    release?.();
    await closing;
    expect(f.saved()).toBeNull();
    expect(f.archive.prepareAccountSubjects).not.toHaveBeenCalled();
    await expect(service.configure({ cookiesText: 'synthetic' })).rejects.toThrow(
      'account_sync_unavailable',
    );
  });
  it('does not schedule a reconnect-required session and requires cookies on setup', async () => {
    const f = fixture(),
      service = await open(f);
    await expect(service.configure({} as never)).rejects.toMatchObject({ name: 'ZodError' });
    expect(f.provider.importList).not.toHaveBeenCalled();
    await service.configure({ cookiesText: 'synthetic' });
    await tick();
    f.provider.importList.mockRejectedValueOnce(new ProviderError('account-session-unavailable'));
    await expect(service.refresh()).rejects.toThrow('cookies_expired');
    await tick();
    await service.close();
    const reopened = await open(f);
    expect(reopened.status()).toMatchObject({
      connected: true,
      needsReconnect: true,
      nextAttemptMs: null,
    });
  });
  it('waits another interval after metadata persistence fails instead of retrying every second', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      service = await open(f);
    await service.configure({ cookiesText: 'synthetic' });
    await tick();
    f.vault.writeSealedSecret.mockRejectedValueOnce(new Error('synthetic-storage-failure'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(service.status()).toMatchObject({
      error: 'account_sync_unavailable',
      nextAttemptMs: Date.now() + 5000,
    });
    expect(f.provider.importList).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.provider.importList).toHaveBeenCalledTimes(1);
  });
  it('adopts a committed delayed replacement before a later invalid PUT preserves the prior connection', async () => {
    const f = fixture(),
      service = await open(f);
    await service.configure({
      cookiesText: 'synthetic-A',
    });
    const write = f.vault.writeSealedSecret.getMockImplementation()!;
    let release: (() => void) | undefined, entered: (() => void) | undefined;
    const writing = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    f.vault.writeSealedSecret.mockImplementationOnce(async (purpose, value) => {
      entered?.();
      await gate;
      await write(purpose, value);
    });
    const replacing = service.configure({
        cookiesText: 'synthetic-B',
      }),
      replacementCancelled = expect(replacing).rejects.toThrow('account_sync_cancelled');
    await writing;
    f.provider.importList.mockRejectedValueOnce(new ProviderError('account-session-unavailable'));
    const invalid = service.configure({
        cookiesText: 'synthetic-C-invalid',
      }),
      invalidRejected = expect(invalid).rejects.toThrow('cookies_expired');
    await replacementCancelled;
    release?.();
    await invalidRejected;
    await tick();
    expect(service.status()).toMatchObject({
      connected: true,
      needsReconnect: false,
      // Failed candidate validation is reported by configure(), not by the unchanged connection.
      error: null,
    });
    expect((JSON.parse(f.saved()!) as { active: unknown }).active).toMatchObject({
      cookiesText: 'synthetic-B',
    });
    await service.close();
    const restarted = await open(f);
    expect(restarted.status()).toMatchObject({
      connected: true,
    });
    await restarted.refresh();
    expect(f.provider.importList).toHaveBeenLastCalledWith('synthetic-B', expect.any(AbortSignal));
  });
  it('DELETE waits for a delayed replacement commit and then removes that committed value', async () => {
    const f = fixture(),
      service = await open(f);
    await service.configure({
      cookiesText: 'synthetic-A',
    });
    const write = f.vault.writeSealedSecret.getMockImplementation()!;
    let release: (() => void) | undefined, entered: (() => void) | undefined;
    const writing = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    f.vault.writeSealedSecret.mockImplementationOnce(async (purpose, value) => {
      entered?.();
      await gate;
      await write(purpose, value);
    });
    const replacing = service.configure({
        cookiesText: 'synthetic-B',
      }),
      replacementCancelled = expect(replacing).rejects.toThrow('account_sync_cancelled');
    await writing;
    let disconnected = false;
    const disconnecting = service.disconnect().then(() => {
      disconnected = true;
    });
    await replacementCancelled;
    await tick();
    expect(disconnected).toBe(false);
    release?.();
    await disconnecting;
    expect(f.saved()).toBeNull();
    expect(service.status()).toMatchObject({
      connected: false,
      nextAttemptMs: null,
    });
    await service.close();
    const restarted = await open(f);
    expect(restarted.status().connected).toBe(false);
  });
  it('close drains a delayed accepted replacement and leaves memory and restart on the committed value', async () => {
    const f = fixture(),
      service = await open(f);
    await service.configure({
      cookiesText: 'synthetic-A',
    });
    const write = f.vault.writeSealedSecret.getMockImplementation()!;
    let release: (() => void) | undefined, entered: (() => void) | undefined;
    const writing = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    f.vault.writeSealedSecret.mockImplementationOnce(async (purpose, value) => {
      entered?.();
      await gate;
      await write(purpose, value);
    });
    const replacing = service.configure({
        cookiesText: 'synthetic-B',
      }),
      replacementCancelled = expect(replacing).rejects.toThrow('account_sync_cancelled');
    await writing;
    let drained = false;
    const closing = service.close();
    void closing.then(() => {
      drained = true;
    });
    await replacementCancelled;
    await tick();
    expect(drained).toBe(false);
    release?.();
    await closing;
    expect(service.status()).toMatchObject({
      connected: true,
      running: false,
      nextAttemptMs: null,
    });
    expect((JSON.parse(f.saved()!) as { active: unknown }).active).toMatchObject({
      cookiesText: 'synthetic-B',
    });
    const restarted = await open(f);
    expect(restarted.status()).toMatchObject({
      connected: true,
    });
  });
  it('close during a delayed DELETE commit also adopts the durable disconnected state', async () => {
    const f = fixture(),
      service = await open(f);
    await service.configure({
      cookiesText: 'synthetic-A',
    });
    const write = f.vault.writeSealedSecret.getMockImplementation()!;
    let release: (() => void) | undefined, entered: (() => void) | undefined;
    const writing = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    f.vault.writeSealedSecret.mockImplementationOnce(async (purpose, value) => {
      entered?.();
      await gate;
      await write(purpose, value);
    });
    const deleting = service.disconnect(),
      deleteCancelled = expect(deleting).rejects.toThrow('account_sync_cancelled');
    await writing;
    const closing = service.close();
    await deleteCancelled;
    release?.();
    await closing;
    expect(f.saved()).toBeNull();
    expect(service.status()).toMatchObject({
      connected: false,
      running: false,
      nextAttemptMs: null,
    });
    const restarted = await open(f);
    expect(restarted.status().connected).toBe(false);
  });
});

describe('account restart scheduling', () => {
  async function restart(intervalMs: () => number = () => 1000) {
    vi.useFakeTimers();
    vi.setSystemTime(2000000000000);
    const f = fixture();
    await f.clock.close();
    const clock = new SyncClock({ intervalMs });
    clocks.push(clock);
    const initial = await createAccountSync({ ...f, clock });
    cleanups.push(initial);
    await initial.configure({ cookiesText: 'synthetic-cookie' });
    await initial.close();
    await vi.advanceTimersByTimeAsync(5000);
    const service = await createAccountSync({ ...f, clock, startupDelayMs: 10000 });
    cleanups.push(service);
    return { ...f, service };
  }
  it('honors the advertised startup grace for an overdue persisted account', async () => {
    const f = await restart();
    expect(f.service.status().nextAttemptMs).toBe(Date.now() + 10000);
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.provider.importList).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.provider.importList).toHaveBeenCalledTimes(2);
  });
  it.each([1000, 20000])(
    'preserves startup grace when the shared interval changes to %i',
    async (nextInterval) => {
      let interval = 5000;
      const f = await restart(() => interval);
      interval = nextInterval;
      await vi.advanceTimersByTimeAsync(9999);
      expect(f.provider.importList).toHaveBeenCalledTimes(1);
      // A longer heartbeat may admit the due work on its next business tick.
      await vi.advanceTimersByTimeAsync(nextInterval === 1000 ? 1 : 10001);
      expect(f.provider.importList).toHaveBeenCalledTimes(2);
    },
  );
  it('allows a manual refresh during startup grace and resumes the normal interval', async () => {
    const f = await restart();
    await f.service.refresh();
    expect(f.provider.importList).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.provider.importList).toHaveBeenCalledTimes(3);
  });
});

it('uses only the shared clock and adopts its interval changes', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(2000000000000);
  let interval = 5000;
  const clock = new SyncClock({ intervalMs: () => interval }),
    f = fixture();
  await f.clock.close();
  const service = await createAccountSync({ ...f, clock });
  cleanups.push(service);
  try {
    await service.configure({
      cookiesText: 'synthetic-cookie',
    });
    expect(f.provider.importList).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.provider.importList).toHaveBeenCalledTimes(2);
    interval = 1000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.provider.importList).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
  } finally {
    await service.close();
    await clock.close();
  }
});

it('pins a validated account source across refreshes and restarts', async () => {
  const f = fixture();
  const importer = vi.fn(async () => ({
    subjects: [],
    profile: { username: 'Fixture', followingCount: 0, avatarSourceUrl: null },
  }));
  const service = await createAccountSync({
    ...f,
    provider: { ...f.provider, importAccount: importer },
  });
  cleanups.push(service);
  await service.configure({ cookiesText: 'session=synthetic', origin: 'https://stripchat.org' });
  expect(service.status()).toMatchObject({ origin: 'https://stripchat.org', connected: true });
  expect((JSON.parse(f.saved()!) as { active: unknown }).active).toMatchObject({
    origin: 'https://stripchat.org',
  });
  await service.refresh();
  expect(importer).toHaveBeenLastCalledWith(
    'session=synthetic',
    expect.any(AbortSignal),
    expect.any(Function),
    'https://stripchat.org',
    expect.any(Function),
    expect.any(Function),
    expect.objectContaining({ refreshProfiles: true }),
  );
  await service.close();
  const restarted = await createAccountSync({
    ...f,
    provider: { ...f.provider, importAccount: importer },
    origin: 'https://stripchat.com',
  });
  cleanups.push(restarted);
  expect(restarted.status().origin).toBe('https://stripchat.org');
});
it('reports a domain mismatch distinctly and preserves existing subjects on failed refresh', async () => {
  const f = fixture(),
    service = await open(f);
  await service.configure({ cookiesText: 'synthetic' });
  f.archive.prepareAccountSubjects.mockClear();
  f.provider.importList.mockRejectedValueOnce(new ProviderError('cookies-domain-mismatch'));
  await expect(service.refresh()).rejects.toThrow('cookies_domain_mismatch');
  expect(service.status()).toMatchObject({
    connected: true,
    needsReconnect: true,
    error: 'cookies_domain_mismatch',
    nextAttemptMs: null,
  });
  expect(f.archive.prepareAccountSubjects).not.toHaveBeenCalled();
});

it.each([
  [new ProviderError('upstream-request'), 'account_network_unavailable', false],
  [new ProviderError('incomplete-account-list'), 'list_import_failed', false],
  [new ProviderError('request-deadline'), 'account_sync_timeout', false],
  [
    new ProviderError('upstream-http', 403, false, undefined, true),
    'account_verification_required',
    true,
  ],
  [new ProviderError('account-redirect-denied'), 'account_origin_redirect', true],
] as const)(
  'classifies login source failures without touching following membership',
  async (error, code, needsReconnect) => {
    const f = fixture(),
      service = await open(f);
    await service.configure({ cookiesText: 'synthetic' });
    f.archive.prepareAccountSubjects.mockClear();
    f.provider.importList.mockRejectedValueOnce(error);
    await expect(service.refresh()).rejects.toThrow(code);
    expect(service.status()).toMatchObject({ error: code, needsReconnect, connected: true });
    expect(f.archive.prepareAccountSubjects).not.toHaveBeenCalled();
    expect(service.status().nextAttemptMs === null).toBe(needsReconnect);
  },
);
it('rejects unreviewed login origins before replacing a healthy connection', async () => {
  const f = fixture(),
    service = await open(f);
  await service.configure({ cookiesText: 'synthetic' });
  const saved = f.saved(),
    calls = f.provider.importList.mock.calls.length;
  await expect(
    service.configure({ cookiesText: 'do-not-send', origin: 'https://attacker.invalid' }),
  ).rejects.toThrow('account_origin_invalid');
  expect(f.saved()).toBe(saved);
  expect(f.provider.importList).toHaveBeenCalledTimes(calls);
});

it('does not attribute rejected replacement credentials to the currently connected domain', async () => {
  const f = fixture();
  const importer = vi.fn(async () => ({
    subjects: [],
    profile: { username: 'Fixture', followingCount: 0, avatarSourceUrl: null },
  }));
  const service = await createAccountSync({
    ...f,
    provider: { ...f.provider, importAccount: importer },
  });
  cleanups.push(service);
  await service.configure({ cookiesText: 'session=old', origin: 'https://stripchat.com' });
  const saved = f.saved();
  importer.mockRejectedValueOnce(new ProviderError('account-session-unavailable'));
  await expect(
    service.configure({ cookiesText: 'session=rejected', origin: 'https://stripchat.com' }),
  ).rejects.toThrow('cookies_expired');
  expect(service.status()).toMatchObject({
    origin: 'https://stripchat.com',
    error: null,
    needsReconnect: false,
    connected: true,
  });
  expect(f.saved()).toBe(saved);
});

it('locks the account origin until explicit disconnect, archives membership and reconciles capture', async () => {
  const f = fixture(),
    service = await open(f);
  await service.configure({ cookiesText: 'session=first', origin: 'https://stripchat.com' });
  await expect(
    service.configure({ cookiesText: 'session=other', origin: 'https://stripchat.org' }),
  ).rejects.toThrow('account_origin_locked');
  expect(service.status().origin).toBe('https://stripchat.com');
  f.supervisor.reconcile.mockClear();
  expect(await service.disconnect()).toEqual({
    cookiesText: 'session=first',
    origin: 'https://stripchat.com',
  });
  expect(f.saved()).toBeNull();
  expect(JSON.stringify(service.status())).not.toContain('session=first');
  expect(f.following()).toEqual([]);
  expect(f.supervisor.reconcile).toHaveBeenCalled();
  await service.configure({ cookiesText: 'session=new', origin: 'https://stripchat.org' });
  expect(service.status().origin).toBe('https://stripchat.org');
});
