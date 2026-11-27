import { expect, it, vi } from 'vitest';
import { createProvider } from './index.js';

const origin = 'https://stripchat.com';
const unavailable = () => new Response(null, { status: 503 });
const avatar = 'https://static-cdn.strpst.com/verified-avatar.jpg';
const cover = 'https://static-cdn.strpst.com/verified-cover.jpg';

function fixture(route: (url: URL) => Response, indexed = [40, 44]) {
  const fetch = vi.fn<typeof globalThis.fetch>((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const response = url.pathname.endsWith('/initial-dynamic')
      ? Response.json({
          initialDynamic: { user: { id: 9, username: 'viewer' }, jwtToken: 'fixture' },
        })
      : url.pathname === '/api/front/users/9/favorites'
        ? Response.json({ modelIds: indexed })
        : route(url);
    return Promise.resolve(response);
  });
  return { provider: createProvider({ origin, fetch }), fetch };
}

function stored(providerId: number, handle: string) {
  return { id: `stripchat:${providerId}`, providerId, handle };
}

function roomAccess(id: number, isGeoBanned: boolean) {
  return Response.json({ user: { isGeoBanned, user: { id, status: '' } } });
}

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

function roomWithPlayer(providerId: number) {
  return new Response(
    '<html><head><link rel="canonical" href="https://stripchat.com/regional"></head><body>' +
      '<div class="view-cam-page"><div class="view-cam-container"></div></div>' +
      '<script>window.__PRELOADED_STATE__ = ' +
      JSON.stringify({
        viewCam: { model: { id: providerId, username: 'regional' }, playerIsAvailable: true },
      }) +
      '; </script></body></html>',
    { headers: { 'content-type': 'text/html' } },
  );
}

function regionalRecoveryFixture(options: {
  cam: () => Response;
  page?: () => Response;
  followed?: boolean;
}) {
  const followed = options.followed ?? true;
  const { provider, fetch } = fixture(
    (url) => {
      switch (url.pathname) {
        case '/api/front/v2/users':
          return Response.json({ items: [{ id: 44, username: 'regional' }] });
        case '/api/front/v2/users/profiles':
          return Response.json({ items: {} });
        case '/api/front/models/list':
          return Response.json({
            models: [
              { id: 40, isInFavorites: true, isLive: false, status: 'off' },
              { id: 44, isInFavorites: followed, isLive: false, status: 'off' },
            ],
          });
        case '/api/front/v2/users/44':
          return Response.json({ item: { id: 44, username: 'regional', isDeleted: false } });
        case '/api/front/v2/models/44/cam':
          return options.cam();
        case '/regional':
          return options.page?.() ?? roomPage('regional');
        default:
          return unavailable();
      }
    },
    followed ? [40, 44] : [40],
  );
  const regional = {
    ...stored(44, 'regional'),
    accountArchiveReason: 'region_restricted' as const,
  };
  return {
    regional,
    importAccount: () =>
      provider.importAccount('session=fixture', undefined, undefined, origin, () =>
        Promise.resolve([regional]),
      ),
    requests: () =>
      fetch.mock.calls.map(
        ([input]) => new URL(input instanceof Request ? input.url : input).pathname,
      ),
  };
}

it('rechecks a known regional label after valid followed status returns', async () => {
  const { importAccount, requests } = regionalRecoveryFixture({ cam: () => roomAccess(44, false) });

  const feed = await importAccount();

  expect(feed.subjects.find((row) => row.providerId === 44)).toEqual({
    ...stored(44, 'regional'),
    accountRegionCleared: true,
  });
  expect(requests()).toContain('/api/front/v2/models/44/cam');
  expect(requests()).not.toContain('/api/front/v2/models/40/cam');
});

it('clears a known regional label with positive same-ID player evidence after a plain room 403', async () => {
  const { importAccount, requests } = regionalRecoveryFixture({
    cam: () => new Response(null, { status: 403 }),
    page: () => roomWithPlayer(44),
  });

  const feed = await importAccount();

  expect(feed.subjects.find((row) => row.providerId === 44)).toEqual({
    ...stored(44, 'regional'),
    accountRegionCleared: true,
  });
  expect(requests()).toContain('/api/front/v2/models/44/cam');
  expect(requests()).toContain('/regional');
});

it.each([
  { evidence: 'explicit region ban', cam: () => roomAccess(44, true), fetchesPage: false },
  { evidence: 'a mismatched room ID', cam: () => roomAccess(45, false), fetchesPage: false },
  {
    evidence: 'a challenged 403',
    cam: () => new Response(null, { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
    fetchesPage: false,
  },
  {
    evidence: 'a structured 403',
    cam: () => Response.json({ error: 'geo_restricted' }, { status: 403 }),
    fetchesPage: false,
  },
  {
    evidence: 'a problem JSON 403',
    cam: () =>
      new Response('{"type":"urn:problem:geo-restricted"}', {
        status: 403,
        headers: { 'content-type': 'application/problem+json' },
      }),
    fetchesPage: false,
  },
  { evidence: 'a 401', cam: () => new Response(null, { status: 401 }), fetchesPage: false },
  { evidence: 'a 429', cam: () => new Response(null, { status: 429 }), fetchesPage: false },
  {
    evidence: 'a public shell after a plain 403',
    cam: () => new Response(null, { status: 403 }),
    page: () => roomPage('regional'),
    fetchesPage: true,
  },
  {
    evidence: 'a mismatched public player ID after a plain 403',
    cam: () => new Response(null, { status: 403 }),
    page: () => roomWithPlayer(45),
    fetchesPage: true,
  },
])('keeps the known label with $evidence', async ({ cam, page, fetchesPage }) => {
  const { regional, importAccount, requests } = regionalRecoveryFixture({
    cam,
    page: page ?? (() => roomWithPlayer(44)),
  });

  const feed = await importAccount();

  expect(feed.subjects.find((row) => row.providerId === 44)).toEqual(regional);
  expect(requests()).toContain('/api/front/v2/models/44/cam');
  expect(requests().includes('/regional')).toBe(fetchesPage);
});

it('keeps the known regional label after a plain 403 without current membership', async () => {
  const { regional, importAccount, requests } = regionalRecoveryFixture({
    followed: false,
    cam: () => new Response(null, { status: 403 }),
    page: () => roomWithPlayer(44),
  });

  const feed = await importAccount();

  expect(feed.subjects.find((row) => row.providerId === 44)).toEqual({
    ...regional,
    accountArchivePending: true,
  });
  expect(requests()).toContain('/api/front/v2/models/44/cam');
  expect(requests()).not.toContain('/regional');
});

it('uses selected profile fields and keeps stored membership and cause when sources omit records', async () => {
  const { provider } = fixture((url) => {
    switch (url.pathname) {
      case '/api/front/v2/users':
        return Response.json({ items: [{ id: 40, username: 'chosen-name' }] });
      case '/api/front/v2/users/profiles':
        return Response.json({ items: { 40: { avatarUrl: avatar } } });
      case '/api/front/models/list':
        return Response.json({
          models: [
            {
              id: 40,
              username: 'card-name',
              avatarUrl: cover,
              previewUrlThumbSmall: cover,
              isInFavorites: true,
            },
          ],
        });
      default:
        return unavailable();
    }
  });
  const retained = stored(41, 'retained');
  const restricted = {
    ...stored(44, 'regional'),
    accountArchiveReason: 'region_restricted' as const,
  };
  const output = await provider.importAccount(
    'session=fixture',
    undefined,
    undefined,
    origin,
    () => Promise.resolve([retained]),
    () => Promise.resolve([restricted]),
  );
  expect(output.subjects.find((row) => row.providerId === 40)).toEqual({
    ...stored(40, 'chosen-name'),
    avatarSourceUrl: avatar,
    previewSourceUrl: cover,
  });
  expect(output.subjects.find((row) => row.providerId === 41)).toEqual(retained);
  expect(output.subjects.find((row) => row.providerId === 44)).toEqual({
    ...restricted,
    accountArchivePending: true,
  });
  expect(output.recoveredArchivedCount).toBeUndefined();
});

it('does not apply explicit negative membership across a failed user account check', async () => {
  const { provider } = fixture(
    (url) =>
      url.pathname === '/api/front/models/list'
        ? Response.json({
            models: [
              { id: 40, isInFavorites: true },
              { id: 42, isInFavorites: false },
            ],
          })
        : unavailable(),
    [40],
  );
  const original = stored(42, 'kept');
  const feed = await provider.importAccount('session=fixture', undefined, undefined, origin, () =>
    Promise.resolve([original]),
  );
  expect(feed.subjects.find((row) => row.providerId === 42)).toEqual(original);
  const signal = new AbortController().signal;
  const reason = await provider.openArchiveReasonProbe('session=fixture', origin, 'viewer', signal);
  await expect(reason(42, signal)).rejects.toMatchObject({ status: 503 });
});

it.each([
  { roomDisabled: true, isInFavorites: true, expected: 'account_disabled' },
  { roomDisabled: false, isInFavorites: false, expected: 'unfollowed' },
] as const)(
  'reconciles a previously region-limited account when the evidence confirms $expected',
  async ({ roomDisabled, isInFavorites, expected }) => {
    const { provider } = fixture(
      (url) => {
        if (url.pathname === '/api/front/models/list')
          return Response.json({
            models: [
              { id: 40, isInFavorites: true },
              { id: 44, isInFavorites },
            ],
          });
        if (url.pathname === '/api/front/v2/users/44')
          return Response.json({
            item: { id: 44, username: 'regional', isDeleted: false, isBlocked: !roomDisabled },
          });
        if (url.pathname === '/api/front/v2/models/44/cam') return roomAccess(44, false);
        if (url.pathname === '/regional') return roomPage('regional', roomDisabled);
        return unavailable();
      },
      isInFavorites ? [40, 44] : [40],
    );
    const regional = {
      ...stored(44, 'regional'),
      accountArchiveReason: 'region_restricted' as const,
    };

    const feed = await provider.importAccount('session=fixture', undefined, undefined, origin, () =>
      Promise.resolve([regional]),
    );

    expect(feed.subjects.find((row) => row.providerId === 44)).toEqual({
      ...regional,
      accountArchiveReason: expected,
      accountRegionCleared: true,
      ...(roomDisabled ? { accountBlockedConfirmed: true } : { accountUnfollowConfirmed: true }),
    });
  },
);

it('accepts exact unfollow proof against a historic disabled label and preserves a deletion', async () => {
  const { provider } = fixture(
    (url) => {
      if (url.pathname === '/api/front/models/list')
        return Response.json({
          models: [
            { id: 40, isInFavorites: true },
            { id: 44, isInFavorites: false },
            { id: 45, isInFavorites: false },
          ],
        });
      if (/\/api\/front\/v2\/users\/(?:44|45)$/.test(url.pathname)) {
        const id = Number(url.pathname.split('/').at(-1));
        return Response.json({
          item: { id, username: id === 44 ? 'disabled' : 'deleted', isDeleted: false },
        });
      }
      if (url.pathname === '/disabled' || url.pathname === '/deleted')
        return roomPage(url.pathname.slice(1));
      return unavailable();
    },
    [40],
  );
  const disabled = { ...stored(44, 'disabled'), accountArchiveReason: 'account_disabled' as const };
  const deleted = { ...stored(45, 'deleted'), accountArchiveReason: 'account_deleted' as const };

  const feed = await provider.importAccount(
    'session=fixture',
    undefined,
    undefined,
    origin,
    undefined,
    () => Promise.resolve([disabled, deleted]),
  );

  expect(feed.subjects.find((row) => row.providerId === 44)).toEqual({
    ...disabled,
    accountArchiveReason: 'unfollowed',
    accountUnfollowConfirmed: true,
  });
  expect(feed.subjects.find((row) => row.providerId === 45)).toEqual(deleted);
});

it.each([
  { username: 'current_room', expectedPage: '/current_room' },
  { username: undefined, expectedPage: undefined },
])(
  'does not use the old room to decide disabled evidence when the exact user reports $username',
  async ({ username, expectedPage }) => {
    const { provider, fetch } = fixture(
      (url) => {
        if (url.pathname === '/api/front/models/list')
          return Response.json({
            models: [
              { id: 40, isInFavorites: true, status: 'off', isLive: false },
              { id: 44, status: 'off', isLive: false },
            ],
          });
        if (url.pathname === '/api/front/v2/users/44')
          return Response.json({
            item: { id: 44, username, isDeleted: false, isBlocked: true },
          });
        if (url.pathname === '/old_room') return roomPage('old_room', true);
        if (url.pathname === '/current_room') return roomPage('current_room');
        return unavailable();
      },
      [40, 44],
    );
    const known = stored(44, 'old_room');
    const feed = await provider.importAccount('session=fixture', undefined, undefined, origin, () =>
      Promise.resolve([known]),
    );
    expect(feed.subjects.find((row) => row.providerId === 44)).toEqual(known);
    const pages = fetch.mock.calls
      .map(([url]) => new URL(url instanceof Request ? url.url : url).pathname)
      .filter((route) => route === '/current_room' || route === '/old_room');
    expect(pages).toEqual(expectedPage ? [expectedPage] : []);
  },
);

it.each([
  { condition: 'an invalid handle', username: '../current_room', pageStatus: undefined },
  { condition: 'an unrelated 200 page', username: 'current_room', pageStatus: 200 },
  { condition: 'a generic 404 page', username: 'current_room', pageStatus: 404 },
])(
  'keeps the record when a corroborated negative has $condition',
  async ({ username, pageStatus }) => {
    const { provider, fetch } = fixture(
      (url) => {
        if (url.pathname === '/api/front/models/list')
          return Response.json({
            models: [
              { id: 40, isInFavorites: true, status: 'off', isLive: false },
              { id: 44, isInFavorites: false, status: 'off', isLive: false },
            ],
          });
        if (url.pathname === '/api/front/v2/users/44')
          return Response.json({ item: { id: 44, username, isDeleted: false } });
        if (url.pathname === '/current_room' && pageStatus)
          return new Response('<html><body>Browse the site</body></html>', {
            status: pageStatus,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
        if (!url.pathname.startsWith('/api/')) throw new Error('unexpected room request');
        return unavailable();
      },
      [40],
    );
    const known = stored(44, 'old_room');
    const feed = await provider.importAccount('session=fixture', undefined, undefined, origin, () =>
      Promise.resolve([known]),
    );

    expect(feed.subjects.find((row) => row.providerId === 44)).toEqual(known);
    expect(feed.unverifiedMissingCount).toBe(1);
    const pages = fetch.mock.calls
      .map(([input]) => new URL(input instanceof Request ? input.url : input).pathname)
      .filter((pathname) => !pathname.startsWith('/api/'));
    expect(pages).toEqual(pageStatus ? ['/current_room'] : []);
  },
);

it('keeps a former account region archived without current membership proof even when status is available', async () => {
  const { provider, fetch } = fixture(
    (url) => {
      if (url.pathname === '/api/front/models/list')
        return Response.json({
          models: [
            { id: 40, status: 'off', isLive: false, isInFavorites: true },
            { id: 44, status: 'p2p', isLive: true, isInFavorites: false },
          ],
        });
      if (url.pathname === '/api/front/v2/users/44')
        return Response.json({ item: { id: 44, isDeleted: false, isBlocked: false } });
      return unavailable();
    },
    [40],
  );
  const saved = { ...stored(44, 'regional'), accountArchiveReason: 'region_restricted' as const };
  const feed = await provider.importAccount(
    'session=fixture',
    undefined,
    undefined,
    origin,
    undefined,
    () => Promise.resolve([saved]),
  );
  expect(feed.subjects.find((row) => row.providerId === 44)).toEqual({
    ...saved,
    accountArchivePending: true,
  });
  const requests = fetch.mock.calls.map(
    ([input]) => new URL(input instanceof Request ? input.url : input).pathname,
  );
  expect(requests).toContain('/api/front/v2/models/44/cam');
  expect(requests).not.toContain('/regional');
});

it('archives exact same-ID geo evidence without taking live status from the room', async () => {
  const { provider, fetch } = fixture((url) => {
    if (url.pathname === '/api/front/models/list')
      return Response.json({
        models: [{ id: 40, isInFavorites: true, status: 'off', isLive: false }],
      });
    if (url.pathname === '/api/front/v2/users/44')
      return Response.json({ item: { id: 44, isDeleted: false, isBlocked: true } });
    if (url.pathname === '/api/front/v2/models/44/cam') return roomAccess(44, true);
    return unavailable();
  });
  const real = stored(44, 'regional');

  const feed = await provider.importAccount('session=fixture', undefined, undefined, origin, () =>
    Promise.resolve([real]),
  );

  expect(feed.subjects.find((row) => row.providerId === 44)).toEqual({
    ...real,
    accountArchiveReason: 'region_restricted',
    accountArchivePending: true,
  });
  expect(
    fetch.mock.calls.map(([url]) => new URL(url instanceof Request ? url.url : url).pathname),
  ).not.toContain('/api/front/v2/models/40/cam');
});

it.each([() => new Response(null, { status: 403 }), () => roomAccess(45, true)])(
  'keeps an archived regional label through incomplete or mismatched room evidence',
  async (room) => {
    const { provider } = fixture(
      (url) => {
        if (url.pathname === '/api/front/models/list')
          return Response.json({
            models: [
              { id: 40, isInFavorites: true, status: 'off', isLive: false },
              { id: 44, isInFavorites: false },
            ],
          });
        if (url.pathname === '/api/front/v2/users/44')
          return Response.json({ item: { id: 44, isDeleted: false, isBlocked: false } });
        if (url.pathname === '/api/front/v2/models/44/cam') return room();
        return unavailable();
      },
      [40],
    );
    const saved = { ...stored(44, 'regional'), accountArchiveReason: 'region_restricted' as const };
    const feed = await provider.importAccount(
      'session=fixture',
      undefined,
      undefined,
      origin,
      undefined,
      () => Promise.resolve([saved]),
    );

    expect(feed.subjects.find((row) => row.providerId === 44)).toEqual({
      ...saved,
      accountArchivePending: true,
    });
  },
);
