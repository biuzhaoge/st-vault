import { describe, expect, it, vi } from 'vitest';
import { createProvider } from './index.js';

const origin = 'https://stripchat.com';
const identity = { initialDynamic: { user: { id: 42, username: 'owner' } } };
const model = (id: number, handle: string) => ({ id: `stripchat:${id}`, providerId: id, handle });

function roomPage(handle: string, disabled = false) {
  const content = disabled
    ? `<div class="deleted-wrapper"><div class="account-disabled-header">账户被禁用</div><div class="account-disabled-description">${handle}的账户已被禁用。</div></div>`
    : '<div class="view-cam-page"><div class="view-cam-container"></div></div>';
  return new Response(
    `<html lang="zh"><head><link rel="canonical" href="${origin}/${handle}"></head><body>${content}</body></html>`,
    {
      status: disabled ? 404 : 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  );
}

function setup(response: (url: URL, headers: Headers) => Response) {
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) =>
    Promise.resolve(
      response(new URL(input instanceof Request ? input.url : input), new Headers(init?.headers)),
    ),
  );
  return { provider: createProvider({ origin, fetch }), fetch };
}

describe('account favorite ID index', () => {
  it('imports every indexed ID even where a selected profile source omits the row', async () => {
    const ids = Array.from({ length: 101 }, (_, index) => index + 100);
    const first = ids[0];
    const stored = model(ids[1], 'known-profile');
    const userBatchSizes: number[] = [];
    const { provider } = setup((url, headers) => {
      if (url.pathname.endsWith('initial-dynamic')) return Response.json(identity);
      if (url.pathname === '/api/front/users/42/favorites') {
        expect(headers.get('cookie')).toBe('session=test');
        expect(headers.has('authorization')).toBe(false);
        return Response.json({ modelIds: ids });
      }
      if (url.pathname === '/api/front/v2/users') {
        const size = [...url.searchParams].length;
        userBatchSizes.push(size);
        return Response.json({
          items:
            url.searchParams.get('userIds[0]') === String(first)
              ? [{ id: first, username: 'current-name' }]
              : [],
        });
      }
      if (url.pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
      if (url.pathname === '/api/front/models/list') {
        return Response.json({
          models: [...url.searchParams.values()].map((value) => ({
            id: Number(value),
            isInFavorites: true,
          })),
        });
      }
      throw new Error('unexpected source');
    });
    const result = await provider.importAccount(
      'session=test',
      undefined,
      undefined,
      undefined,
      () => Promise.resolve([stored]),
    );
    expect(userBatchSizes.sort((a, b) => a - b)).toEqual([7, 47, 47]);
    expect(result).toMatchObject({
      indexCount: ids.length,
      unresolvedProfileCount: ids.length - 2,
      profile: { followingCount: ids.length },
    });
    expect(result.subjects.map(({ providerId }) => providerId)).toEqual(ids);
    expect(result.subjects.slice(0, 3)).toEqual([
      model(first, 'current-name'),
      stored,
      { ...model(ids[2], `主播 #${ids[2]}`), subjectProfilePending: true },
    ]);
  });

  it.each([
    { name: 'duplicate', modelIds: [12, 12] },
    { name: 'zero', modelIds: [0] },
    { name: 'string', modelIds: ['12'] },
    { name: 'nonfinite', modelIds: [Infinity] },
    { name: 'not an array', modelIds: {} },
    { name: 'oversized', modelIds: Array.from({ length: 10_001 }, (_, i) => i + 1) },
  ])('rejects an invalid index ($name) before querying profiles', async ({ modelIds }) => {
    const { provider, fetch } = setup((url) => {
      if (url.pathname.endsWith('initial-dynamic')) return Response.json(identity);
      if (url.pathname === '/api/front/users/42/favorites') return Response.json({ modelIds });
      throw new Error('unexpected fallback source');
    });
    const onIndexed = vi.fn(() => Promise.resolve());
    await expect(
      provider.importAccount('session=test', undefined, undefined, origin, undefined, undefined, {
        onIndexed,
      }),
    ).rejects.toMatchObject({ code: 'invalid-account-list' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onIndexed).not.toHaveBeenCalled();
  });

  it('publishes the validated index before reading local rows or requesting enrichment', async () => {
    const steps: string[] = [];
    const { provider } = setup((url) => {
      if (url.pathname.endsWith('initial-dynamic')) return Response.json(identity);
      if (url.pathname === '/api/front/users/42/favorites') {
        steps.push('favorites');
        return Response.json({ modelIds: [12] });
      }
      steps.push('enrichment');
      if (url.pathname === '/api/front/v2/users')
        return Response.json({ items: [{ id: 12, username: 'resolved' }] });
      if (url.pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
      if (url.pathname === '/api/front/models/list')
        return Response.json({
          models: [{ id: 12, status: 'off', isLive: false, isInFavorites: true }],
        });
      throw new Error('unexpected source');
    });
    const onIndexed = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          setImmediate(() => {
            steps.push('index published');
            resolve();
          });
        }),
    );
    const result = await provider.importAccount(
      'session=test',
      undefined,
      undefined,
      origin,
      () => {
        steps.push('local rows');
        return Promise.resolve([]);
      },
      undefined,
      { onIndexed },
    );
    expect(onIndexed).toHaveBeenCalledOnce();
    expect(onIndexed).toHaveBeenCalledWith({
      indexedIds: [12],
      profile: { username: 'owner', followingCount: 1, avatarSourceUrl: null },
    });
    expect(steps.slice(0, 4)).toEqual(['favorites', 'index published', 'local rows', 'enrichment']);
    expect(result.subjects).toEqual([model(12, 'resolved')]);
  });

  it('queries names and avatars selectively while preserving restriction and unfollow evidence', async () => {
    const ids = [10, 11, 12, 13, 14, 16];
    const avatar = 'https://static-cdn.strpst.com/found.jpg';
    const requests = new Map<string, number[]>();
    const { provider } = setup((url) => {
      if (url.pathname.endsWith('initial-dynamic')) return Response.json(identity);
      if (url.pathname === '/api/front/users/42/favorites') return Response.json({ modelIds: ids });
      const requested = [...url.searchParams.values()].map(Number);
      requests.set(url.pathname, requested);
      if (url.pathname === '/api/front/v2/users')
        return Response.json({
          items: requested.map((id) => ({ id, username: `resolved-${id}` })),
        });
      if (url.pathname === '/api/front/v2/users/profiles')
        return Response.json({
          items: Object.fromEntries(requested.map((id) => [id, { avatarUrl: avatar }])),
        });
      if (url.pathname === '/api/front/models/list')
        return Response.json({
          models: requested.map((id) => ({
            id,
            status: 'off',
            isLive: false,
            ...(id === 16 ? {} : { isInFavorites: id !== 15 }),
          })),
        });
      if (url.pathname === '/api/front/v2/users/15')
        return Response.json({ item: { id: 15, username: 'unfollowed', isDeleted: false } });
      if (url.pathname === '/api/front/v2/users/16')
        return Response.json({
          item: { id: 16, username: 'blocked', isDeleted: false, isBlocked: false },
        });
      if (url.pathname === '/unfollowed') return roomPage('unfollowed');
      if (url.pathname === '/blocked') return roomPage('blocked', true);
      return new Response(null, { status: 503 });
    });
    const result = await provider.importAccount(
      'session=test',
      undefined,
      undefined,
      origin,
      () =>
        Promise.resolve([
          { ...model(10, 'complete'), avatarSourceUrl: avatar },
          model(11, 'has-no-avatar'),
          { ...model(12, '主播 #12'), subjectProfilePending: true, avatarSourceUrl: avatar },
          { ...model(13, '主播 #13'), subjectProfilePending: true },
          model(15, 'unfollowed'),
          model(16, 'blocked'),
        ]),
      undefined,
      { refreshProfiles: false },
    );
    expect(requests).toEqual(
      new Map([
        ['/api/front/v2/users', [12, 13, 14]],
        ['/api/front/v2/users/profiles', [13, 14]],
        ['/api/front/models/list', [10, 11, 12, 13, 14, 16, 15]],
        ['/api/front/v2/users/15', []],
        ['/api/front/v2/users/16', []],
        ['/unfollowed', []],
        ['/blocked', []],
      ]),
    );
    expect(result.subjects).toEqual([
      model(10, 'complete'),
      model(11, 'has-no-avatar'),
      model(12, 'resolved-12'),
      { ...model(13, 'resolved-13'), avatarSourceUrl: avatar },
      { ...model(14, 'resolved-14'), avatarSourceUrl: avatar },
      {
        ...model(16, 'blocked'),
        accountArchiveReason: 'account_disabled',
        accountBlockedConfirmed: true,
      },
      {
        ...model(15, 'unfollowed'),
        accountArchiveReason: 'unfollowed',
        accountUnfollowConfirmed: true,
      },
    ]);
  });

  it('preserves indexed membership and stored names across identity mismatches', async () => {
    const { provider } = setup((url) => {
      if (url.pathname.endsWith('initial-dynamic')) return Response.json(identity);
      if (url.pathname === '/api/front/users/42/favorites')
        return Response.json({ modelIds: [12, 13] });
      if (url.pathname === '/api/front/v2/users')
        return Response.json({ items: [{ id: 19, username: 'someone-else' }] });
      if (url.pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
      if (url.pathname === '/api/front/models/list')
        return Response.json({
          models: [
            { id: 12, username: 'unverified-rename', isInFavorites: false },
            { id: 13, isInFavorites: true },
          ],
        });
      if (url.pathname === '/api/front/v2/users/12')
        return Response.json({ item: { id: 19, isDeleted: true } });
      if (url.pathname === '/api/front/v2/users/13')
        return Response.json({ item: { id: 13, isBlocked: true } });
      throw new Error('unexpected source');
    });
    const known = [model(12, 'known-name')];
    const archived = [
      { ...model(13, 'known-disabled'), accountArchiveReason: 'account_disabled' as const },
    ];
    const recover = vi.fn(() => Promise.resolve(archived));
    const result = await provider.importAccount(
      'session=test',
      undefined,
      undefined,
      undefined,
      () => Promise.resolve(known),
      recover,
    );
    expect(recover).toHaveBeenCalledWith('owner', [12, 13]);
    expect(result.subjects).toEqual([...known, ...archived]);
  });

  it('retains prior follows on an empty index with uncorroborated negative cards', async () => {
    const { provider } = setup((url) => {
      if (url.pathname.endsWith('initial-dynamic')) return Response.json(identity);
      if (url.pathname === '/api/front/users/42/favorites') return Response.json({ modelIds: [] });
      if (url.pathname === '/api/front/v2/users') return Response.json({ items: [] });
      if (url.pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
      if (url.pathname === '/api/front/models/list')
        return Response.json({ models: [{ id: 12, isInFavorites: false }] });
      return Response.json({ item: { id: 12, isDeleted: false, isBlocked: false } });
    });
    const known = model(12, 'retained');
    const result = await provider.importAccount(
      'session=test',
      undefined,
      undefined,
      undefined,
      () => Promise.resolve([known]),
    );
    expect(result.subjects).toEqual([known]);
    expect(result.unverifiedMissingCount).toBe(1);
    expect(result.profile.followingCount).toBe(0);
  });

  it.each([
    { blockedPrefix: 0, rounds: 2, firstAttempt: 48 },
    { blockedPrefix: 8, rounds: 3, firstAttempt: 4 },
  ])(
    'advances bounded account checks through a blocked prefix of $blockedPrefix',
    async ({ blockedPrefix, rounds, firstAttempt }) => {
      const ids = Array.from({ length: 49 }, (_, index) => index + 100);
      const calls: number[] = [];
      const roomCalls: number[] = [];
      const { provider } = setup((url) => {
        if (url.pathname.endsWith('initial-dynamic')) return Response.json(identity);
        if (url.pathname === '/api/front/users/42/favorites')
          return Response.json({ modelIds: ids });
        if (url.pathname === '/api/front/v2/users') return Response.json({ items: [] });
        if (url.pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
        if (url.pathname === '/api/front/models/list') return Response.json({ models: [] });
        const room = /^\/api\/front\/v2\/models\/(\d+)\/cam$/.exec(url.pathname);
        if (room) {
          roomCalls.push(Number(room[1]));
          return new Response(null, { status: 403 });
        }
        const id = Number(url.pathname.split('/').at(-1));
        calls.push(id);
        if (id < 100 + blockedPrefix)
          return new Response(null, { status: 403, headers: { 'cf-mitigated': 'challenge' } });
        return Response.json({ item: { id } });
      });
      for (let round = 0; round < rounds; round++) {
        await provider.importList('session=test');
        if (round === 0) {
          expect(calls).toHaveLength(firstAttempt);
          expect(roomCalls).toHaveLength(blockedPrefix === 0 ? firstAttempt : 0);
        }
      }
      expect(new Set(calls)).toEqual(new Set(ids));
      expect(calls[firstAttempt]).toBe(ids[firstAttempt]);
    },
  );

  it('keeps account check rotation isolated across two account IDs on the same origin', async () => {
    const ids = Array.from({ length: 49 }, (_, index) => index + 100);
    const starts = new Map<string, number>();
    const { provider } = setup((url, headers) => {
      const cookie = headers.get('cookie') ?? '';
      if (url.pathname.endsWith('initial-dynamic'))
        return Response.json({
          initialDynamic: { user: { username: cookie, id: cookie === 'session=first' ? 42 : 43 } },
        });
      if (url.pathname.startsWith('/api/front/users/')) return Response.json({ modelIds: ids });
      if (url.pathname === '/api/front/v2/users') return Response.json({ items: [] });
      if (url.pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
      if (url.pathname === '/api/front/models/list') return Response.json({ models: [] });
      const id = Number(url.pathname.split('/').at(-1));
      if (!starts.has(cookie)) starts.set(cookie, id);
      return new Response(null, { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    });
    await provider.importList('session=first');
    await provider.importList('session=second');
    expect([...starts.values()]).toEqual([100, 100]);
    starts.clear();
    await provider.importList('session=first');
    expect([...starts.values()]).toEqual([104]);
  });
});
