import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import type { SyncClock } from '../runtime/sync-clock.js';
import { createPreviews } from './index.js';
import { accountAvatarSource } from '../provider/account-profile.js';
import type { Subject } from '@st-vault/api-schema';
import { openArchive } from '../archive/index.js';

const image = Buffer.from([255, 216, 255, 217]);
const addressOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
function fixture() {
  let source = 'https://static-cdn.strpst.com/previews/fixture-first-thumb-big';
  const settings = new Map<string, string>();
  const archive = {
    async getSubject(id: string) {
      return (await this.listSubjects()).find((row) => row.id === id) ?? null;
    },

    listSubjects: () => Promise.resolve([{ id: 'stripchat:42', providerId: 42 } as Subject]),
    subjectPreview: () => Promise.resolve(source),
    getSetting: (key: string) => Promise.resolve(settings.get(key) ?? null),
    setSetting: (key: string, value: string) => {
      settings.set(key, value);
      return Promise.resolve();
    },
    locate: vi.fn(),
    timeline: vi.fn(),
    media: vi.fn(),
    hasMedia: vi.fn(),
  };
  const fetch = vi.fn((input: string | URL | Request) =>
    Promise.resolve(
      addressOf(input).includes('/broadcasts/')
        ? Response.json({ item: { status: 'off', isLive: false, snapshotTimestamp: 0 } })
        : new Response(image),
    ),
  );
  return {
    archive,
    fetch,
    source: (value: string) => {
      source = value;
    },
  };
}
it('accepts the actual offline preview host without accepting arbitrary origins', () => {
  expect(
    accountAvatarSource('https://static-cdn.strpst.com/previews/fixture-thumb-big'),
  ).not.toBeNull();
  expect(accountAvatarSource('https://static-cdn.strpst.com.attacker.invalid/a')).toBeNull();
});
it('prefetches both roster images without a browser and keeps the default cover during live updates', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-roster-images-'));
  const f = fixture();
  const id = 'stripchat:42';
  const avatar = 'https://static-cdn.strpst.com/avatars/first';
  const nextAvatar = 'https://static-cdn.strpst.com/avatars/updated';
  const original = 'https://static-cdn.strpst.com/previews/fixture-first-thumb-big';
  const updated = 'https://static-cdn.strpst.com/previews/updated-thumb-big';
  const live = 'https://img.doppiocdn.net/snapshot/42/123';
  const liveImage = Buffer.from([255, 216, 255, 224, 255, 217]);
  const downloads = () => f.fetch.mock.calls.map(([url]) => addressOf(url));
  await f.archive.setSetting(`preview.avatar-source.${id}`, avatar);
  f.fetch.mockImplementation((url) =>
    Promise.resolve(new Response(addressOf(url) === live ? liveImage : image)),
  );
  const previews = createPreviews({ ...f, cacheRoot: root, mediaRoot: root, decoder: vi.fn() });
  try {
    previews.observeCover?.(id, live);
    await previews.warmSubjectImages!([id]);
    await previews.warmCovers?.([id]);
    expect(downloads()).toEqual(expect.arrayContaining([avatar, original, live]));
    expect(await previews.avatar!(id)).toEqual(image);
    expect([...(await previews.cover(id, undefined, true))]).toEqual([...liveImage]);
    await previews.warmSubjectImages!([id]);
    expect(downloads()).toHaveLength(3);
    f.source(updated);
    await f.archive.setSetting(`preview.avatar-source.${id}`, nextAvatar);
    await previews.warmSubjectImages!([id]);
    expect(downloads().slice(3).sort()).toEqual([nextAvatar, updated].sort());
    previews.observeCover?.(id, null);
    await previews.warmCovers?.([id]);
    expect([...(await previews.cover(id, undefined, true))]).toEqual([...image]);
    expect(downloads()).toHaveLength(5);
  } finally {
    await previews.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('recovers a failed static CDN through the image mirror and skips the cached version on the next sync', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cover-mirror-'));
  const f = fixture();
  f.fetch.mockImplementation((input) => {
    const host = new URL(addressOf(input)).hostname;
    return host === 'static-cdn.strpst.com'
      ? Promise.reject(Error('connection reset'))
      : Promise.resolve(new Response(image));
  });
  const previews = createPreviews({ ...f, cacheRoot: root, decoder: vi.fn() });
  try {
    await previews.warmCovers?.(['stripchat:42']);
    expect([...(await previews.cover('stripchat:42', undefined, true))]).toEqual([...image]);
    expect(
      (await previews.backgroundTasks?.())?.find((row) => row.id === 'cover-sync'),
    ).toMatchObject({
      state: 'idle',
      failed: 0,
      error: null,
    });
    await previews.warmCovers?.(['stripchat:42']);
    f.source('https://static-cdn.strpst.com/previews/fixture-second-thumb-big');
    await previews.warmCovers?.(['stripchat:42']);
    expect(f.fetch.mock.calls.map(([input]) => new URL(addressOf(input)).hostname)).toEqual([
      'static-cdn.strpst.com',
      'static-proxy.strpst.com',
      'static-proxy.strpst.com',
    ]);
  } finally {
    await previews.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('warms all covers, skips unchanged source versions across restarts and replaces changed sources', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cover-version-'));
  const f = fixture();
  let previews = createPreviews({ ...f, cacheRoot: root, decoder: vi.fn() });
  try {
    await previews.warmCovers?.(['stripchat:42']);
    expect([...(await previews.cover('stripchat:42', undefined, true))]).toEqual([...image]);
    const downloads = () =>
      f.fetch.mock.calls.filter(([url]) => !addressOf(url).includes('/broadcasts/')).length;
    expect(downloads()).toBe(1);
    await previews.close();
    previews = createPreviews({ ...f, cacheRoot: root, decoder: vi.fn() });
    await previews.warmCovers?.(['stripchat:42']);
    expect(downloads()).toBe(1);
    f.source('https://static-cdn.strpst.com/previews/fixture-second-thumb-big');
    await previews.warmCovers?.(['stripchat:42']);
    expect(downloads()).toBe(2);
  } finally {
    await previews.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('uses status observations to download only new live snapshot versions, preserving the last image on failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cover-status-'));
  let now = 0;
  const f = fixture(),
    previews = createPreviews({ ...f, now: () => now, cacheRoot: root, decoder: vi.fn() });
  try {
    await previews.warmCovers?.(['stripchat:42']);
    f.fetch.mockClear();
    previews.observeCover?.('stripchat:42', 'https://img.doppiocdn.net/snapshot/42/123');
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1), { timeout: 3000 });
    await previews.warmCovers?.(['stripchat:42']);
    previews.observeCover?.('stripchat:42', 'https://img.doppiocdn.net/snapshot/42/123');
    await previews.warmCovers?.(['stripchat:42']);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.fetch.mockImplementation(() => Promise.resolve(new Response('broken', { status: 503 })));
    previews.observeCover?.('stripchat:42', 'https://img.doppiocdn.net/snapshot/42/124');
    await previews.warmCovers?.(['stripchat:42']);
    expect([...(await previews.cover('stripchat:42', undefined, true))]).toEqual([...image]);
    const calls = f.fetch.mock.calls.length;
    const tasks = await previews.backgroundTasks!();
    expect(tasks.find((task) => task.id === 'cover-sync')).toMatchObject({
      state: 'retrying',
      failed: 1,
      error: 'cover_refresh_partial',
      nextRunAtMs: 5000,
    });
    await previews.backgroundTasks!();
    expect(f.fetch.mock.calls.length).toBe(calls);
    expect(JSON.stringify(tasks)).not.toContain('https:');
    f.fetch.mockImplementation(() => Promise.resolve(new Response(image)));
    f.fetch.mockClear();
    now += 5000;
    previews.observeCover?.('stripchat:42', 'https://img.doppiocdn.net/snapshot/42/124');
    await previews.warmCovers?.(['stripchat:42']);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(
      (await previews.backgroundTasks!()).find((task) => task.id === 'cover-sync'),
    ).toMatchObject({ state: 'idle', failed: 0, error: null, lastSuccessAtMs: 5000 });
  } finally {
    await previews.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('backs off the same missing source across foreground and heartbeat requests without delaying warm callers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cover-missing-'));
  const f = fixture();
  f.source('');
  let now = 0;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const previews = createPreviews({ ...f, now: () => now, cacheRoot: root, decoder: vi.fn() });
  try {
    await previews.warmCovers?.(['stripchat:42']);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 4; i++) {
      await previews.warmCovers?.(['stripchat:42']);
      await expect(previews.cover('stripchat:42')).rejects.toMatchObject({
        code: 'preview_not_found',
      });
    }
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
    expect(
      (await previews.backgroundTasks!()).find((task) => task.id === 'cover-sync'),
    ).toMatchObject({
      failed: 0,
      error: null,
    });
    now = 5000;
    await previews.warmCovers?.(['stripchat:42']);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    previews.observeCover?.('stripchat:42', 'https://img.doppiocdn.org/snapshot/42/new');
    await previews.warmCovers?.(['stripchat:42']);
    expect([...(await previews.cover('stripchat:42', undefined, true))]).toEqual([...image]);
  } finally {
    await previews.close();
    warning.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('retries an image transport failure on the clock without a second browser read', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cover-scheduled-retry-'));
  const f = fixture();
  let now = 0;
  const subscriptions = new Map<string, () => void>();
  const clock = {
    subscribe: (name: string, callback: () => void) => {
      subscriptions.set(name, callback);
      return () => subscriptions.delete(name);
    },
  } as unknown as SyncClock;
  f.fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
  const previews = createPreviews({
    ...f,
    now: () => now,
    clock,
    cacheRoot: root,
    decoder: vi.fn(),
  });
  try {
    await previews.warmCovers?.(['stripchat:42']);
    expect((await previews.backgroundTasks!())[0].error).toBe('cover_refresh_partial');
    const calls = f.fetch.mock.calls.length;
    now = 4999;
    subscriptions.get('cover-retry')!();
    expect(f.fetch).toHaveBeenCalledTimes(calls);
    now = 5000;
    subscriptions.get('cover-retry')!();
    await vi.waitFor(async () => expect((await previews.backgroundTasks!())[0].error).toBeNull());
    expect(f.fetch).toHaveBeenCalledTimes(calls + 1);
    expect([...(await previews.cover('stripchat:42', undefined, true))]).toEqual([...image]);
  } finally {
    await previews.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('treats repeated null heartbeat sources as normal until a new source appears', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cover-null-'));
  const f = fixture();
  f.source('');
  let now = 0;
  const lookup = vi.spyOn(f.archive, 'subjectPreview');
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const previews = createPreviews({ ...f, now: () => now, cacheRoot: root, decoder: vi.fn() });
  try {
    previews.observeCover?.('stripchat:42', null);
    await previews.warmCovers?.(['stripchat:42']);
    for (let i = 0; i < 10; i++) {
      previews.observeCover?.('stripchat:42', null);
      await previews.warmCovers?.(['stripchat:42']);
    }
    expect(f.fetch).not.toHaveBeenCalled();
    expect((await previews.backgroundTasks!())[0].error).toBeNull();
    now = 5000;
    await previews.warmCovers?.(['stripchat:42']);
    now = 14999;
    await previews.warmCovers?.(['stripchat:42']);
    now = 15000;
    await previews.warmCovers?.(['stripchat:42']);
    expect(warning).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalled();
    f.source('https://static-cdn.strpst.com/previews/new');
    await previews.warmCovers?.(['stripchat:42']);
    expect(f.fetch).toHaveBeenCalledTimes(1);
  } finally {
    await previews.close();
    warning.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not cool down or diagnose caller-cancelled cover requests', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cover-cancel-'));
  const f = fixture();
  const controller = new AbortController();
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  f.fetch.mockImplementation(() => new Promise(() => undefined));
  const previews = createPreviews({
    ...f,
    archive: {
      ...f.archive,
      listSubjects: () => Promise.resolve([]),
      getSubject: () => Promise.resolve({ id: 'stripchat:42', providerId: 42 } as Subject),
      getSetting: undefined,
      setSetting: undefined,
    },
    cacheRoot: root,
    decoder: vi.fn(),
  });
  try {
    const request = previews
      .cover('stripchat:42', controller.signal)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.fetch).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await request).toMatchObject({ code: 'preview_cancelled' });
    f.fetch.mockImplementation(() => Promise.resolve(new Response(image)));
    await previews.warmCovers?.(['stripchat:42']);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(warning).not.toHaveBeenCalled();
  } finally {
    controller.abort();
    await previews.close();
    warning.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps a failed primary source cooling down even when the first list fallback succeeds', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cover-fallback-retry-'));
  const f = fixture();
  let now = 0;
  f.fetch.mockImplementation((url) =>
    Promise.resolve(
      addressOf(url).includes('/snapshot/')
        ? new Response('not ready', { status: 503 })
        : new Response(image),
    ),
  );
  const previews = createPreviews({ ...f, now: () => now, cacheRoot: root, decoder: vi.fn() });
  try {
    previews.observeCover?.('stripchat:42', 'https://img.doppiocdn.org/snapshot/42/bad');
    await previews.warmCovers?.(['stripchat:42']);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 3; i++) {
      previews.observeCover?.('stripchat:42', 'https://img.doppiocdn.org/snapshot/42/bad');
      await previews.warmCovers?.(['stripchat:42']);
    }
    expect(f.fetch).toHaveBeenCalledTimes(2);
    now = 5000;
    await previews.warmCovers?.(['stripchat:42']);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    previews.observeCover?.('stripchat:42', 'https://img.doppiocdn.org/snapshot/42/new');
    await previews.warmCovers?.(['stripchat:42']);
    expect(f.fetch).toHaveBeenCalledTimes(4);
  } finally {
    await previews.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('diagnoses subject lookup failures outside the source download boundary without duplicating source failures', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cover-rpc-'));
  const f = fixture();
  vi.spyOn(f.archive, 'getSubject').mockRejectedValue(
    Object.assign(new Error('metadata unavailable'), { code: 'METADATA_READ_BUSY' }),
  );
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const previews = createPreviews({ ...f, cacheRoot: root, decoder: vi.fn() });
  try {
    await previews.warmCovers?.(['stripchat:42']);
    expect(warning).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warning.mock.calls[0][0] as string)).toMatchObject({
      event: 'cover_background_failed',
      code: 'METADATA_READ_BUSY',
    });
    await expect(previews.cover('stripchat:42')).rejects.toMatchObject({
      code: 'preview_failed',
      cause: { code: 'METADATA_READ_BUSY' },
    });
    expect(f.fetch).not.toHaveBeenCalled();
  } finally {
    await previews.close();
    warning.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('persists versions through the real archive settings contract and serves offline covers after reopening', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cover-archive-'));
  const archive = await openArchive({ root: path.join(root, 'archive') });
  const fetch = vi.fn(() => Promise.resolve(new Response(image)));
  let previews;
  try {
    await archive.upsertSubjects([
      {
        id: 'stripchat:42',
        providerId: 42,
        handle: 'Synthetic',
        previewSourceUrl: 'https://static-cdn.strpst.com/previews/fixture-thumb-big',
      },
    ]);
    const options = { archive, fetch, cacheRoot: path.join(root, 'cache'), decoder: vi.fn() };
    previews = createPreviews(options);
    await previews.warmCovers?.(['stripchat:42']);
    expect(await archive.getSetting('preview.cover-source.42')).toBe(
      'https://static-cdn.strpst.com/previews/fixture-thumb-big',
    );
    await previews.close();
    previews = createPreviews(options);
    await previews.warmCovers?.(['stripchat:42']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect([...(await previews.cover('stripchat:42', undefined, true))]).toEqual([...image]);
  } finally {
    await previews?.close();
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('primes the first cover from the real list preview when the live CDN has no valid image yet', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cover-first-'));
  const f = fixture();
  f.fetch.mockImplementation((url) =>
    Promise.resolve(
      addressOf(url).includes('/snapshot/')
        ? new Response('not ready', { status: 503 })
        : new Response(image),
    ),
  );
  const previews = createPreviews({ ...f, cacheRoot: root, decoder: vi.fn() });
  try {
    previews.observeCover?.('stripchat:42', 'https://img.doppiocdn.org/snapshot/42/123');
    await previews.warmCovers?.(['stripchat:42']);
    expect([...(await previews.cover('stripchat:42', undefined, true))]).toEqual([...image]);
    expect(f.fetch.mock.calls.map(([url]) => addressOf(url))).toContain(
      'https://static-cdn.strpst.com/previews/fixture-first-thumb-big',
    );
  } finally {
    await previews.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps an already scheduled background timer alive while an explicit synchronization awaits it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cover-wait-'));
  const timeout = vi.spyOn(globalThis, 'setTimeout');
  const previews = createPreviews({ ...fixture(), cacheRoot: root, decoder: vi.fn() });
  try {
    previews.observeCover?.('stripchat:42', 'https://img.doppiocdn.org/snapshot/42/123');
    const timer = timeout.mock.results[0].value as ReturnType<typeof setTimeout>;
    expect(timer.hasRef()).toBe(false);
    const done = previews.warmCovers?.(['stripchat:42']);
    expect(timer.hasRef()).toBe(true);
    await done;
  } finally {
    await previews.close();
    timeout.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not let repeated live revisions overtake subjects still awaiting their first cached image', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cover-fair-'));
  const f = fixture();
  const ids = [42, 43, 44, 45];
  const archive = {
    ...f.archive,
    listSubjects: () =>
      Promise.resolve(ids.map((id) => ({ id: `stripchat:${id}`, providerId: id }) as Subject)),
    subjectPreview: (id: string) =>
      Promise.resolve(`https://static-cdn.strpst.com/previews/${id.slice(10)}`),
  };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = addressOf(input);
    calls.push(url);
    if (/\/previews\/(42|43)$/.test(url)) await gate;
    return new Response(image);
  });
  const previews = createPreviews({ archive, fetch, cacheRoot: root, decoder: vi.fn() });
  const done = previews.warmCovers?.(ids.map((id) => `stripchat:${id}`));
  try {
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    previews.observeCover?.('stripchat:42', 'https://img.doppiocdn.org/snapshot/42/123');
    previews.observeCover?.('stripchat:43', 'https://img.doppiocdn.org/snapshot/43/123');
    release();
    await done;
    expect(calls.slice(0, 4)).toEqual(
      ids.map((id) => `https://static-cdn.strpst.com/previews/${id}`),
    );
  } finally {
    release();
    await done;
    await previews.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('does not overwrite a cached live cover with the unchanged list image during startup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-cover-restart-'));
  const f = fixture();
  let previews = createPreviews({ ...f, cacheRoot: root, decoder: vi.fn() });
  try {
    previews.observeCover?.('stripchat:42', 'https://img.doppiocdn.org/snapshot/42/123');
    await previews.warmCovers?.(['stripchat:42']);
    await previews.close();
    f.fetch.mockClear();
    previews = createPreviews({ ...f, cacheRoot: root, decoder: vi.fn() });
    await previews.warmCovers?.();
    expect(f.fetch).not.toHaveBeenCalled();
    await expect(f.archive.getSetting('preview.cover-source.42')).resolves.toBe(
      'https://img.doppiocdn.org/snapshot/42/123',
    );
  } finally {
    await previews.close();
    await rm(root, { recursive: true, force: true });
  }
});
