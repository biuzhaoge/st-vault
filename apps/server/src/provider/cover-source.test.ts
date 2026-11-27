import { expect, it, vi } from 'vitest';
import { broadcastCover, coverSource } from './cover-source.js';
import { createProvider } from './index.js';

it('normalizes numeric and string snapshot versions without using offline placeholder timestamps', () => {
  expect(broadcastCover(42, { isLive: true, snapshotTimestamp: '123' })).toBe(
    'https://img.doppiocdn.org/snapshot/42/123',
  );
  for (const value of [0, -1, '0', '1.5', 'bad', Number.MAX_SAFE_INTEGER + 1])
    expect(broadcastCover(42, { snapshotTimestamp: value })).toBeNull();
  expect(broadcastCover(42, { isLive: false, snapshotTimestamp: 123 })).toBeNull();
  expect(coverSource('https://user:password@static-cdn.strpst.com/a')).toBeNull();
  expect(coverSource('http://static-cdn.strpst.com/a')).toBeNull();
});

it('refreshes the broadcast snapshot from the same batched observation as live status', async () => {
  const onCoverObserved = vi.fn();
  const small = 'https://static-cdn.strpst.com/previews/fixture-thumb-small';
  let stamp = '123';
  const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.pathname).toBe('/api/front/models/list');
    expect(new Headers(init?.headers).has('cookie')).toBe(false);
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
    return Promise.resolve(
      Response.json({
        models: [
          {
            id: 42,
            isLive: true,
            status: 'public',
            snapshotTimestamp: stamp,
            previewUrlThumbSmall: small,
            previewUrlThumbBig: 'https://static-cdn.strpst.com/previews/fixture-thumb-big',
          },
        ],
      }),
    );
  });
  const provider = createProvider({ fetch, onCoverObserved });
  expect(await provider.status(42)).toBe('PUBLIC');
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(onCoverObserved).toHaveBeenCalledExactlyOnceWith(
    'stripchat:42',
    'https://img.doppiocdn.org/snapshot/42/123',
  );
  stamp = '124';
  expect(await provider.status(42)).toBe('PUBLIC');
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(onCoverObserved).toHaveBeenLastCalledWith(
    'stripchat:42',
    'https://img.doppiocdn.org/snapshot/42/124',
  );
});

it('imports the provided small cover variant for compact preview cells instead of an oversized big image', async () => {
  const avatar = 'https://static-cdn.strpst.com/avatars/fixture';
  const provider = createProvider({
    fetch: (input) => {
      const { pathname } = new URL(input instanceof Request ? input.url : input);
      if (pathname.includes('initial-dynamic'))
        return Promise.resolve(
          Response.json({ initialDynamic: { user: { id: 19, username: 'synthetic' } } }),
        );
      if (pathname === '/api/front/users/19/favorites')
        return Promise.resolve(Response.json({ modelIds: [42] }));
      if (pathname === '/api/front/v2/users')
        return Promise.resolve(Response.json({ items: [{ id: 42, username: 'synthetic' }] }));
      if (pathname === '/api/front/v2/users/profiles')
        return Promise.resolve(Response.json({ items: { 42: { avatarUrl: avatar } } }));
      if (pathname === '/api/front/models/list')
        return Promise.resolve(
          Response.json({
            models: [
              {
                id: 42,
                isInFavorites: true,
                previewUrlThumbSmall: 'https://static-cdn.strpst.com/previews/fixture-thumb-small',
                previewUrlThumbBig: 'https://static-cdn.strpst.com/previews/fixture-thumb-big',
              },
            ],
          }),
        );
      return Promise.reject(new Error('unexpected source'));
    },
  });
  const result = await provider.importList('session=synthetic');
  expect(result[0].previewSourceUrl).toBe(
    'https://static-cdn.strpst.com/previews/fixture-thumb-small',
  );
  expect(result[0].avatarSourceUrl).toBe(avatar);
});
