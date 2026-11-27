import { describe, expect, it, vi } from 'vitest';
import { createProvider } from './index.js';

const origin = 'https://stripchat.com';
const bound = 'https://zh.stripchat.com';
const modelId = 42;
const toUrl = (input: string | URL | Request) =>
  new URL(input instanceof Request ? input.url : input);
const roomHandle = 'fixture';
const roomPath = `/${roomHandle}`;
const disabledRoom = () =>
  new Response(
    `<html lang="zh"><body><div class="deleted-wrapper"><div class="account-disabled-header">账户被禁用</div><div class="account-disabled-description">${roomHandle}的账户已被禁用。</div></div></body></html>`,
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
const normalRoom = () =>
  new Response(
    `<html><head><link rel="canonical" href="${bound}${roomPath}"></head><body><div class="view-cam-page"><div class="view-cam-container"></div></div></body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );

function fixture(read: (url: URL) => Response | Promise<Response>, indexed = [99]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = toUrl(input);
    if (url.pathname.endsWith('/initial-dynamic'))
      return Response.json({ initialDynamic: { user: { id: 17, username: 'test-owner' } } });
    if (url.pathname === '/api/front/users/17/favorites')
      return Response.json({ modelIds: indexed });
    return await read(url);
  });
  const provider = createProvider({ fetch, origin });
  const signal = new AbortController().signal;
  const open = (site = bound, username = 'TEST-OWNER') =>
    provider.openArchiveReasonProbe('session=archived-test', site, username, signal);
  return { fetch, open, verify: async (id = modelId) => (await open())(id, signal) };
}

describe('archive reason evidence', () => {
  it.each([
    { isBlocked: false, room: disabledRoom, expected: 'account_disabled' },
    { isBlocked: true, room: normalRoom, expected: null },
  ])(
    'takes disabled evidence from the exact public room, irrespective of API isBlocked=$isBlocked',
    async ({ isBlocked, room, expected }) => {
      const { fetch, verify } = fixture(
        (url) => {
          if (url.pathname === roomPath) return room();
          if (url.pathname.endsWith('/cam')) return new Response(null, { status: 403 });
          return Response.json({
            item: { id: modelId, username: roomHandle, isDeleted: false, isBlocked },
          });
        },
        [modelId, 99],
      );

      await expect(verify()).resolves.toBe(expected);
      const page = fetch.mock.calls.find(([url]) => toUrl(url).pathname === roomPath);
      expect(page).toBeDefined();
      expect(new Headers(page?.[1]?.headers).has('cookie')).toBe(false);
      expect(new Headers(page?.[1]?.headers).has('authorization')).toBe(false);
    },
  );

  it('uses the selected origin without forwarding the bound session to the room page', async () => {
    const { fetch, open } = fixture((url) => {
      if (url.pathname.endsWith('/cam')) return new Response(null, { status: 403 });
      if (url.pathname === roomPath) return disabledRoom();
      const id = Number(url.pathname.split('/').at(-1));
      return Response.json({ item: { id, username: roomHandle, isDeleted: id === 42 } });
    });
    const probe = await open();
    const signal = new AbortController().signal;
    await expect(probe(42, signal)).resolves.toBe('account_deleted');
    await expect(probe(43, signal)).resolves.toBe('account_disabled');
    const requested = fetch.mock.calls.map(([url]) => toUrl(url).href);
    expect(requested.slice(0, 4)).toEqual([
      `${bound}/api/front/v3/config/initial-dynamic?requestPath=/`,
      `${bound}/api/front/users/17/favorites`,
      `${bound}/api/front/v2/users/42`,
      `${bound}/api/front/v2/users/43`,
    ]);
    expect(requested.slice(4).sort()).toEqual([
      `${bound}/api/front/v2/models/43/cam`,
      `${bound}${roomPath}`,
    ]);
    for (const [input, init] of fetch.mock.calls) {
      expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual' });
      expect(new Headers(init?.headers).get('cookie')).toBe(
        toUrl(input).pathname === roomPath ? null : 'session=archived-test',
      );
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
    }
  });

  it('returns exact regional evidence before a potentially destructive blocked classification', async () => {
    const { verify } = fixture((url) => {
      if (url.pathname.endsWith('/cam'))
        return Response.json({ user: { isGeoBanned: true, user: { id: modelId, status: '' } } });
      if (url.pathname === roomPath) return disabledRoom();
      return Response.json({ item: { id: modelId, username: roomHandle, isDeleted: false } });
    });
    await expect(verify()).resolves.toBe('region_restricted');
  });

  it.each([
    { isApprovedModel: false, isBlocked: false, isDeleted: false },
    { isBlocked: 'true', isDeleted: false },
    { isDeleted: 'true', isBlocked: false },
    { isGeoBanned: true, isBlocked: false, isDeleted: false },
    { status: 'off', isBlocked: false, isDeleted: false },
  ])('requires explicit selected user flags instead of unrelated markers', async (flags) => {
    const { verify } = fixture(() => Response.json({ item: { id: modelId, ...flags } }), [modelId]);
    await expect(verify()).resolves.toBeNull();
  });

  it('rejects a conflicting user identity without reading the claimed room', async () => {
    const { fetch, verify } = fixture((url) => {
      if (url.pathname === roomPath) return disabledRoom();
      return Response.json({ item: { id: 43, username: roomHandle, isDeleted: false } });
    });
    await expect(verify()).rejects.toMatchObject({ code: 'upstream-identity-mismatch' });
    expect(fetch.mock.calls.map(([url]) => toUrl(url).pathname)).not.toContain(roomPath);
  });

  it('does not assign a block when the exact user has no current room handle', async () => {
    const { fetch, verify } = fixture(
      (url) => {
        if (url.pathname === roomPath) return disabledRoom();
        return Response.json({ item: { id: modelId, isDeleted: false, isBlocked: true } });
      },
      [modelId, 99],
    );
    await expect(verify()).resolves.toBeNull();
    expect(fetch.mock.calls.map(([url]) => toUrl(url).pathname)).not.toContain(roomPath);
  });

  it.each([undefined, null, [], { isDeleted: true }])(
    'rejects unavailable or malformed user data',
    async (item) => {
      const { verify } = fixture(() => Response.json({ item }));
      await expect(verify()).rejects.toMatchObject({ code: 'upstream-item-unavailable' });
    },
  );

  it('discards credentials that validate as a different account before reading the index', async () => {
    const { fetch, open } = fixture(() => Response.json({}));
    await expect(open(bound, 'different-owner')).rejects.toMatchObject({
      code: 'upstream-identity-mismatch',
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('keeps request errors separate and rejects an unlisted origin before fetching', async () => {
    const { fetch, open, verify } = fixture(() => Promise.reject(new Error('network error')));
    await expect(open('https://unlisted.invalid')).rejects.toThrow('INVALID_ACCOUNT_ORIGIN');
    expect(fetch).not.toHaveBeenCalled();
    await expect(verify()).rejects.toMatchObject({ code: 'upstream-request' });
  });

  it.each([`${origin}/elsewhere`, `${bound}/elsewhere`])(
    'rejects a redirect from the selected user source without following it (%s)',
    async (location) => {
      const { fetch, verify } = fixture(
        () => new Response(null, { status: 302, headers: { location } }),
      );
      await expect(verify()).rejects.toMatchObject({ code: 'redirect-denied' });
      expect(fetch).toHaveBeenCalledTimes(3);
    },
  );

  it.each([403, 404, 429, 503])('keeps HTTP %i separate from account evidence', async (status) => {
    const { fetch, verify } = fixture(() =>
      Response.json({ item: { id: modelId, isDeleted: true } }, { status }),
    );
    await expect(verify()).rejects.toMatchObject({ code: 'upstream-http', status });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([200, 403])(
    'keeps a Cloudflare challenge with HTTP %i separate from evidence',
    async (status) => {
      const { verify } = fixture(
        () =>
          new Response('<title>Just a moment...</title>', {
            status,
            headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' },
          }),
      );
      await expect(verify()).rejects.toMatchObject({ code: 'upstream-http', challenge: true });
    },
  );
});
