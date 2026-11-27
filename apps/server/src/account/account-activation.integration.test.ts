/* eslint-disable @typescript-eslint/require-await -- Offline importer fixture. */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { openArchive } from '../archive/index.js';
import { KeyVault } from '../http/key-vault.js';
import { SyncClock } from '../runtime/sync-clock.js';
import { createAccountSync } from './account-sync.js';
import { createArchiveReasons } from './archive-reasons.js';
import { createProvider } from '../provider/index.js';

function normalRoomResponse(url: URL, providerId?: number): Response {
  const model = { id: providerId, username: url.pathname.slice(1) };
  const player =
    providerId === undefined
      ? ''
      : `<script>window.__PRELOADED_STATE__ = ${JSON.stringify({ viewCam: { model, playerIsAvailable: true } })};</script>`;
  return new Response(
    `<html><head><link rel="canonical" href="${url.origin}${url.pathname}"></head><body><div class="view-cam-page"><div class="view-cam-container"></div></div>${player}</body></html>`,
    { headers: { 'content-type': 'text/html' } },
  );
}

it('recovers an encrypted accepted account against the real portable library without replaying membership', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-activation-'));
  const clock = new SyncClock({ intervalMs: () => 5000 });
  let archive = await openArchive({ root });
  let vault = await KeyVault.open(root, archive);
  const firstCookie = 'synthetic-private-account-A',
    nextCookie = 'synthetic-private-account-B';
  const provider = {
    importList: vi.fn(async (cookies: string) => [
      {
        id: cookies === firstCookie ? 'stripchat:42' : 'stripchat:84',
        providerId: cookies === firstCookie ? 42 : 84,
        handle: cookies === firstCookie ? 'AccountA-follow' : 'AccountB-follow',
      },
    ]),
  };
  const options = { clock, provider, supervisor: { reconcile: async () => undefined } };
  let service = await createAccountSync({ ...options, archive, vault });
  try {
    await service.configure({ cookiesText: firstCookie });
    const write = vault.writeSealedSecret.bind(vault);
    vi.spyOn(vault, 'writeSealedSecret')
      .mockImplementationOnce(write)
      .mockRejectedValueOnce(Error('SIMULATED_FINAL_PRIVATE_FAILURE'));
    await expect(service.configure({ cookiesText: nextCookie })).rejects.toThrow(
      'account_sync_unavailable',
    );
    const published = await archive.accountActivation();
    expect(published).toMatch(/^[a-f0-9-]{36}$/);
    expect((await archive.listSubjects()).find((row) => row.id === 'stripchat:42')?.archived).toBe(
      true,
    );
    expect((await archive.listSubjects()).find((row) => row.id === 'stripchat:84')?.archived).toBe(
      false,
    );
    const pending = JSON.parse((await vault.readSealedSecret('account-sync'))!) as unknown;
    expect(pending).toMatchObject({
      version: 2,
      active: { cookiesText: firstCookie },
      pending: { generation: published, next: { cookiesText: nextCookie } },
    });
    await service.close();
    await archive.close();
    archive = await openArchive({ root });
    vault = await KeyVault.open(root, archive);
    const replay = vi.spyOn(archive, 'activateAccountSubjects');
    service = await createAccountSync({ ...options, archive, vault });
    expect(replay).not.toHaveBeenCalled();
    expect(service.status()).toMatchObject({ connected: true, error: null });
    expect(JSON.parse((await vault.readSealedSecret('account-sync'))!) as unknown).toMatchObject({
      active: { cookiesText: nextCookie },
      pending: null,
    });
    await service.refresh();
    expect(provider.importList).toHaveBeenLastCalledWith(nextCookie, expect.any(AbortSignal));
    // Inspect only this tiny synthetic library, not any formal media directory.
    const inspect = async (directory: string): Promise<void> => {
      for (const item of await readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, item.name);
        if (item.isDirectory()) await inspect(filename);
        else {
          const bytes = await readFile(filename);
          expect(bytes.includes(Buffer.from(firstCookie))).toBe(false);
          expect(bytes.includes(Buffer.from(nextCookie))).toBe(false);
        }
      }
    };
    await inspect(path.join(root, 'media'));
  } finally {
    await service.close();
    await clock.close();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps followed offline subjects and only archives verified unfollows with footage', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-roster-activation-'));
  const clock = new SyncClock({ intervalMs: () => 5000 });
  const archive = await openArchive({ root });
  const vault = await KeyVault.open(root, archive);
  let short = false;
  const models = [
    { id: 1, username: 'listed' },
    { id: 2, username: 'offline-followed' },
    { id: 3, username: 'unfollowed' },
    { id: 4, username: 'unverified' },
    { id: 5, username: 'empty-unfollowed' },
  ];
  const provider = createProvider({
    fetch: async (input) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith('initial-dynamic'))
        return Response.json({
          initialDynamic: {
            jwtToken: 'synthetic-jwt',
            user: { id: 900, username: 'synthetic-roster' },
          },
        });
      if (url.pathname === '/api/front/users/900/favorites')
        return Response.json({ modelIds: short ? [1] : [1, 2, 3, 4, 5] });
      if (url.pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
      const ids = new Set([...url.searchParams.values()].map(Number));
      const requested = models.filter(({ id }) => ids.has(id));
      if (url.pathname === '/api/front/v2/users') return Response.json({ items: requested });
      if (url.pathname === '/api/front/models/list')
        return Response.json({
          models: requested
            .filter(({ id }) => !short || id !== 4)
            .map((model) => ({
              id: model.id,
              isInFavorites: !short || model.id < 3,
            })),
        });
      const id = Number(url.pathname.split('/').at(-1));
      if (url.pathname === '/api/front/v2/users/4') return new Response(null, { status: 503 });
      const model = models.find((row) => row.id === id);
      if (url.pathname === `/api/front/v2/users/${id}` && model)
        return Response.json({ item: { ...model, isDeleted: false } });
      if (models.some(({ username }) => url.pathname === `/${username}`))
        return normalRoomResponse(url);
      return new Response(null, { status: 404 });
    },
  });
  const service = await createAccountSync({
    archive,
    vault,
    clock,
    provider,
    supervisor: { reconcile: async () => undefined },
  });
  try {
    await service.configure({ cookiesText: 'session=synthetic-roster' });
    const tracked = 'stripchat:2';
    const policy = { archived: false, monitorEnabled: true, autoRecord: true };
    await archive.setGlobalRecording(false);
    await archive.setPolicy(tracked, { monitorEnabled: true, autoRecord: true });
    await archive.commit({
      subjectId: 'stripchat:3',
      sourceEpoch: 'existing-footage',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 1,
      wallStartMs: 60000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    short = true;
    expect(await service.refresh()).toMatchObject({
      imported: 2,
      status: { pendingMissingCount: 1 },
    });
    expect(await archive.getSubject(tracked)).toMatchObject(policy);
    expect(await archive.getSubject('stripchat:3')).toMatchObject({
      archived: true,
      archiveReason: 'unfollowed',
    });
    expect(await archive.getSubject('stripchat:4')).toMatchObject({ archived: false });
    expect(
      (await archive.listSubjects({ includeCleanup: true })).map(({ id }) => id),
    ).not.toContain('stripchat:5');
  } finally {
    await service.close();
    await clock.close();
    provider.sites.close();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('unfollows a room confirmed disabled on its page before purging only its empty archive', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-disabled-room-'));
  const clock = new SyncClock({ intervalMs: () => 300000 });
  const archive = await openArchive({ root });
  const vault = await KeyVault.open(root, archive);
  const models = [
    { id: 42, username: 'empty-room' },
    { id: 43, username: 'recorded-room' },
    { id: 44, username: 'restricted-room' },
    { id: 45, username: 'control-room' },
  ];
  let changed = false;
  const removeFavorites = vi
    .fn<(init: RequestInit) => Response>()
    .mockReturnValue(
      Response.json({ error: 'There are no favorites to delete', data: null }, { status: 400 }),
    );
  const provider = createProvider({
    fetch: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.pathname.endsWith('/initial-dynamic'))
        return Response.json({
          initialDynamic: {
            user: { id: 900, username: 'owner' },
            csrfToken: 'synthetic-token',
            csrfTimestamp: 'synthetic-timestamp',
            csrfNotifyTimestamp: 'synthetic-notify-timestamp',
          },
        });
      if (url.pathname === '/api/front/users/900/favorites') {
        if (init?.method === 'DELETE') return removeFavorites(init);
        return Response.json({ modelIds: changed ? [45] : models.map(({ id }) => id) });
      }
      const requested = new Set([...url.searchParams.values()].map(Number));
      if (url.pathname === '/api/front/v2/users')
        return Response.json({ items: models.filter(({ id }) => requested.has(id)) });
      if (url.pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
      if (url.pathname === '/api/front/models/list')
        return Response.json({
          models: models
            .filter(({ id }) => requested.has(id) && (!changed || id === 45))
            .map(({ id }) => ({ id, isInFavorites: true, status: 'off', isLive: false })),
        });
      const model = models.find(({ id }) => url.pathname === `/api/front/v2/users/${id}`);
      if (model) return Response.json({ item: { ...model, isBlocked: false, isDeleted: false } });
      if (url.pathname === '/api/front/v2/models/44/cam')
        return Response.json({ user: { user: { id: 44 }, isGeoBanned: true } });
      if (url.pathname.endsWith('/cam')) return new Response(null, { status: 403 });
      const room = models.find(({ username }) => url.pathname === `/${username}`);
      if (changed && room) {
        expect(new Headers(init?.headers).has('cookie')).toBe(false);
        return new Response(
          `<div class="deleted-wrapper"><div class="account-disabled-header">账户被禁用</div><div class="account-disabled-description">${room.username}的账户已被禁用。</div></div>`,
          { status: 404, headers: { 'content-type': 'text/html' } },
        );
      }
      throw Error(`Unexpected test source ${url.pathname}`);
    },
  });
  const service = await createAccountSync({
    archive,
    vault,
    clock,
    provider,
    supervisor: { reconcile: async () => undefined },
  });
  const recorder = createArchiveReasons({
    archive,
    clock,
    account: service.status,
    openProbe: service.openArchiveReasonProbe,
    subscribeAccount: service.subscribe,
    now: Date.now,
  });
  try {
    await service.configure({ cookiesText: 'session=synthetic' });
    const media = await archive.commit({
      subjectId: 'stripchat:43',
      sourceEpoch: 'archived-footage',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 1,
      wallStartMs: 60000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    changed = true;
    await service.refresh();
    expect(removeFavorites).not.toHaveBeenCalled();
    expect(await archive.getSubject('stripchat:43')).toMatchObject({
      archived: true,
      archiveReason: 'account_disabled',
    });
    await clock.runNow('archive-reasons');
    expect(removeFavorites).toHaveBeenCalledTimes(1);
    const init = removeFavorites.mock.calls[0][0];
    if (typeof init.body !== 'string') throw Error('Expected a JSON unfollow request');
    expect(JSON.parse(init.body) as unknown).toMatchObject({ favoriteIds: [42] });
    expect(new Headers(init?.headers).get('cookie')).toBe('session=synthetic');
    expect(await archive.getSubject('stripchat:42')).toBeNull();
    expect(await archive.getSubject('stripchat:43')).toMatchObject({
      archived: true,
      archiveReason: 'account_disabled',
    });
    expect(await archive.hasMedia([media.mediaObjectId])).toBe(true);
    expect(await archive.getSubject('stripchat:44')).toMatchObject({
      archived: true,
      archiveReason: 'region_restricted',
    });
  } finally {
    await recorder.close();
    await service.close();
    await clock.close();
    provider.sites.close();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('restores a region-archived follow and keeps its footage after the confirmed room returns', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-region-recovery-'));
  const clock = new SyncClock({ intervalMs: () => 300000 });
  const archive = await openArchive({ root });
  const vault = await KeyVault.open(root, archive);
  const models = [
    { id: 40, username: 'control' },
    { id: 44, username: 'regional' },
  ];
  let state: 'initial' | 'restricted' | 'recovered' = 'initial';
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    switch (url.pathname) {
      case '/api/front/v3/config/initial-dynamic':
        return Response.json({ initialDynamic: { user: { id: 9, username: 'owner' } } });
      case '/api/front/users/9/favorites':
        return Response.json({ modelIds: [40, 44] });
      case '/api/front/v2/users':
        return Response.json({ items: models });
      case '/api/front/v2/users/profiles':
        return Response.json({ items: {} });
      case '/api/front/models/list':
        return Response.json({
          models: [
            { id: 40, isInFavorites: true, isLive: false, status: 'off' },
            state === 'restricted'
              ? { id: 44, isInFavorites: true }
              : { id: 44, isInFavorites: true, isLive: false, status: 'off' },
          ],
        });
      case '/api/front/v2/users/44':
        return Response.json({ item: { id: 44, username: 'regional', isDeleted: false } });
      case '/api/front/v2/models/44/cam':
        return state === 'restricted'
          ? Response.json({ user: { isGeoBanned: true, user: { id: 44 } } })
          : new Response(null, { status: 403 });
      case '/regional':
        return normalRoomResponse(url, 44);
      default:
        throw Error(`Unexpected test source ${url.pathname}`);
    }
  });
  const provider = createProvider({ fetch });
  const service = await createAccountSync({
    archive,
    vault,
    clock,
    provider,
    supervisor: { reconcile: async () => undefined },
  });
  try {
    await service.configure({ cookiesText: 'session=synthetic' });
    const media = await archive.commit({
      subjectId: 'stripchat:44',
      sourceEpoch: 'region-footage',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 1,
      wallStartMs: 60000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    state = 'restricted';
    await service.refresh();
    expect(await archive.getSubject('stripchat:44')).toMatchObject({
      archived: true,
      archiveReason: 'region_restricted',
    });

    state = 'recovered';
    await service.refresh();
    const restored = await archive.getSubject('stripchat:44');
    expect(restored).toMatchObject({ archived: false, monitorEnabled: true });
    expect(restored?.archiveReason).toBeUndefined();
    expect((await archive.followedAccountSubjects()).map(({ id }) => id)).toEqual([
      'stripchat:40',
      'stripchat:44',
    ]);
    expect(await archive.hasMedia([media.mediaObjectId])).toBe(true);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toEqual([]);
  } finally {
    await service.close();
    await clock.close();
    provider.sites.close();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('restores an archive after complete follow evidence returns and keeps known restrictions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-account-restore-archived-'));
  const clock = new SyncClock({ intervalMs: () => 5000 });
  const archive = await openArchive({ root });
  const vault = await KeyVault.open(root, archive);
  const listed = { id: 'stripchat:1', providerId: 1, handle: 'listed' };
  const omitted = { id: 'stripchat:2', providerId: 2, handle: 'omitted' };
  const disabled = { id: 'stripchat:3', providerId: 3, handle: 'disabled' };
  let flagsAvailable = false;
  const provider = createProvider({
    fetch: async (input) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith('initial-dynamic'))
        return Response.json({
          initialDynamic: { user: { id: 900, username: 'fixture-owner' } },
        });
      if (url.pathname === '/api/front/users/900/favorites')
        return Response.json({ modelIds: [1] });
      if (url.pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
      const ids = new Set([...url.searchParams.values()].map(Number));
      if (url.pathname === '/api/front/v2/users')
        return Response.json({
          items: [listed, omitted, disabled]
            .filter(({ providerId }) => ids.has(providerId))
            .map(({ providerId, handle }) => ({ id: providerId, username: handle })),
        });
      if (url.pathname === '/api/front/models/list')
        return Response.json({
          models: [1, 2, 3].filter((id) => ids.has(id)).map((id) => ({ id, isInFavorites: true })),
        });
      const id = Number(url.pathname.split('/').at(-1));
      if (id === 2 && !flagsAvailable) return Response.json({ item: { id } });
      const subject = [listed, omitted, disabled].find(({ providerId }) => providerId === id);
      if (url.pathname === `/api/front/v2/users/${id}` && subject)
        return Response.json({ item: { id, username: subject.handle, isDeleted: false } });
      if ([listed, omitted, disabled].some(({ handle }) => `/${handle}` === url.pathname))
        return normalRoomResponse(url);
      return new Response(null, { status: 404 });
    },
  });
  const service = await createAccountSync({
    archive,
    vault,
    clock,
    provider,
    supervisor: { reconcile: async () => undefined },
  });
  try {
    await archive.upsertSubjects([omitted]);
    await archive.commit({
      subjectId: omitted.id,
      sourceEpoch: 'archived-footage',
      sourceSequence: '1',
      init: null,
      bytes: new Uint8Array([1]),
      durationSeconds: 1,
      wallStartMs: 60000,
      timeBasis: 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
    const previous = randomUUID();
    await archive.prepareAccountSubjects(
      [
        listed,
        { ...omitted, accountArchiveReason: 'unfollowed' },
        { ...disabled, accountArchiveReason: 'account_disabled' },
      ],
      previous,
    );
    await archive.activateAccountSubjects(previous);
    expect(await archive.getSubject(omitted.id)).toMatchObject({ archived: true });
    await service.configure({ cookiesText: 'session=archived-fixture' });
    expect(await archive.getSubject(omitted.id)).toMatchObject({ archived: true });

    flagsAvailable = true;
    await service.refresh();
    expect(await archive.getSubject(omitted.id)).toMatchObject({
      archived: false,
      monitorEnabled: true,
    });
    expect(await archive.getSubject(disabled.id)).toMatchObject({
      archived: true,
      archiveReason: 'account_disabled',
    });
    expect((await archive.followedAccountSubjects()).map(({ id }) => id)).toEqual([
      listed.id,
      omitted.id,
    ]);
  } finally {
    await service.close();
    await clock.close();
    provider.sites.close();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
