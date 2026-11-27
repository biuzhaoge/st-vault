import { describe, expect, it, vi } from 'vitest';
import { createProvider } from './index.js';

const origin = 'https://stripchat.com';
const signal = new AbortController().signal;
const modelId = 42;
const controlId = 43;
const userPath = '/api/front/v2/users/42';
const cardPath = '/api/front/models/list';
const room = 'current_room';
const requestUrl = (value: Request | URL | string) =>
  new URL(value instanceof Request ? value.url : value);
const healthy = () =>
  Response.json({ item: { id: modelId, username: room, isDeleted: false, isBlocked: false } });
const roomPage = (disabled = false) =>
  new Response(
    disabled
      ? `<html lang="zh"><body><div class="deleted-wrapper"><div class="account-disabled-header">账户被禁用</div><div class="account-disabled-description">${room}的账户已被禁用。</div></div></body></html>`
      : `<html><head><link rel="canonical" href="${origin}/${room}"></head><body><div class="view-cam-page"><div class="view-cam-container"></div></div></body></html>`,
    { status: disabled ? 404 : 200, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
const cards = (control = true) =>
  Response.json({
    models: [
      { id: modelId, isInFavorites: false },
      { id: controlId, isInFavorites: control },
    ],
  });

function fixture(get: (url: URL) => Response, index = [controlId]) {
  const route = (url: URL) => {
    if (url.pathname.endsWith('/initial-dynamic'))
      return Response.json({ initialDynamic: { user: { id: 17, username: 'viewer' } } });
    if (url.pathname === '/api/front/users/17/favorites') return Response.json({ modelIds: index });
    return get(url);
  };
  const fetch = vi.fn<typeof globalThis.fetch>((input) =>
    Promise.resolve(route(requestUrl(input))),
  );
  const provider = createProvider({ origin, fetch });
  return {
    fetch,
    provider,
    check: async () =>
      (await provider.openArchiveReasonProbe('session=fixture', origin, 'viewer', signal))(
        modelId,
        signal,
      ),
  };
}

describe('archive membership corroboration', () => {
  it.each([
    [true, 'unfollowed'],
    [false, null],
  ])(
    'only accepts an explicit negative with a known favorite in the same response (%s)',
    async (control, reason) => {
      const { fetch, check } = fixture((url) => {
        if (url.pathname === userPath) return healthy();
        if (url.pathname === `/${room}`) return roomPage();
        if (url.pathname === cardPath) return cards(control);
        if (url.pathname.endsWith('/cam')) return new Response(null, { status: 403 });
        throw new Error('unexpected evidence source');
      });
      await expect(check()).resolves.toBe(reason);
      const request = fetch.mock.calls.find(([url]) => requestUrl(url).pathname === cardPath);
      expect(new Headers(request?.[1]?.headers).get('cookie')).toBe('session=fixture');
      expect(new Headers(request?.[1]?.headers).has('authorization')).toBe(false);
    },
  );

  it('keeps regional evidence distinct from an otherwise explicit unfollow', async () => {
    const { check } = fixture((url) => {
      if (url.pathname === userPath) return healthy();
      if (url.pathname === `/${room}`) return roomPage();
      if (url.pathname === cardPath) return cards();
      if (url.pathname.endsWith('/cam'))
        return Response.json({ user: { isGeoBanned: true, user: { id: modelId } } });
      throw new Error('unexpected evidence source');
    });

    await expect(check()).resolves.toBe('region_restricted');
  });

  it('ignores missing cards and preserves an indexed subject even if a card could report false', async () => {
    const omitted = fixture((url) => {
      if (url.pathname === userPath) return healthy();
      if (url.pathname === `/${room}`) return roomPage();
      if (url.pathname === cardPath)
        return Response.json({ models: [{ id: controlId, isInFavorites: true }] });
      throw new Error('unexpected evidence source');
    });
    await expect(omitted.check()).resolves.toBeNull();

    const indexed = fixture(
      (url) => {
        if (url.pathname === userPath) return healthy();
        if (url.pathname === `/${room}`) return roomPage();
        if (url.pathname === cardPath) return cards();
        throw new Error('unexpected evidence source');
      },
      [modelId, controlId],
    );
    await expect(indexed.check()).resolves.toBeNull();
    expect(indexed.fetch.mock.calls.some(([url]) => requestUrl(url).pathname === cardPath)).toBe(
      false,
    );
  });

  it('keeps a restriction confirmed by the room independently of an unavailable card', async () => {
    const { fetch, check } = fixture((url) => {
      if (url.pathname === userPath) return healthy();
      if (url.pathname === `/${room}`) return roomPage(true);
      if (url.pathname.endsWith('/cam')) return new Response(null, { status: 403 });
      if (url.pathname === cardPath) return new Response(null, { status: 429 });
      throw new Error('unexpected evidence source');
    });
    await expect(check()).resolves.toBe('account_disabled');
    expect(fetch.mock.calls.some(([url]) => requestUrl(url).pathname === cardPath)).toBe(false);
  });

  it('cannot use an explicit negative when the account flags are missing', async () => {
    const { fetch, check } = fixture((url) => {
      if (url.pathname === userPath)
        return Response.json({ item: { id: modelId, isBlocked: false } });
      if (url.pathname === cardPath) return cards();
      throw new Error('unexpected evidence source');
    });
    await expect(check()).resolves.toBeNull();
    expect(fetch.mock.calls.some(([url]) => requestUrl(url).pathname === cardPath)).toBe(false);
  });

  it('applies the same confirmed account evidence when reconciling missing followed IDs', async () => {
    const { provider } = fixture((url) => {
      if (url.pathname === '/api/front/v2/users') return Response.json({ items: [] });
      if (url.pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
      if (url.pathname === userPath) return healthy();
      if (url.pathname === `/${room}`) return roomPage();
      if (url.pathname === cardPath) return cards();
      throw new Error('unexpected evidence source');
    });
    const result = await provider.importAccount('session=fixture', signal, undefined, origin, () =>
      Promise.resolve([{ id: 'stripchat:42', providerId: modelId, handle: 'old-room' }]),
    );
    expect(result.subjects.find((row) => row.providerId === modelId)).toMatchObject({
      id: 'stripchat:42',
      handle: 'old-room',
      accountArchiveReason: 'unfollowed',
      accountUnfollowConfirmed: true,
    });
  });
});
