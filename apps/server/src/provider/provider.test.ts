/* eslint-disable @typescript-eslint/require-await -- Injected async ports intentionally return immediate fixture responses. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createProvider } from './index.js';
import { createHttp } from './http.js';
import { decryptAddress } from './mouflon.js';
import { parseMaster, parsePdt, parsePlaylist } from './hls.js';
import { parseAccountCookies } from './account.js';
function encodeToken(component: string, secret: string): string {
  const hash = createHash('sha256').update(secret).digest();
  return [
    ...Buffer.from(
      [...Buffer.from(component)].map((byte, index) => byte ^ hash[index % hash.length]),
    ).toString('base64'),
  ]
    .reverse()
    .join('');
}
function fixtureProvider(
  request: typeof fetch,
  extra: Parameters<typeof createProvider>[0] = {},
): ReturnType<typeof createProvider> {
  return createProvider({
    fetch: request,
    origin: 'https://site.invalid',
    ...extra,
  });
}
function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function roomPage(url: URL, disabled = false) {
  const handle = url.pathname.slice(1);
  const content = disabled
    ? `<div class="deleted-wrapper"><div class="account-disabled-header">账户被禁用</div><div class="account-disabled-description">${handle}的账户已被禁用。</div></div>`
    : '<div class="view-cam-page"><div class="view-cam-container"></div></div>';
  return new Response(
    `<html lang="zh"><head><link rel="canonical" href="${url.href}"></head><body>${content}</body></html>`,
    {
      status: disabled ? 404 : 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  );
}

describe('public and one-shot account separation', () => {
  it('rejects an unavailable model response without switching the account-bound site', async () => {
    const provider = fixtureProvider(
      async (input) =>
        Response.json(
          requestUrl(input).startsWith('https://site.invalid')
            ? { error: 'model-unavailable' }
            : { models: [{ id: 12, isLive: true, status: 'public' }] },
        ),
      { publicOrigins: ['https://site.invalid', 'https://backup.invalid'] },
    );
    await expect(provider.status(12)).rejects.toMatchObject({ code: 'upstream-item-unavailable' });
    expect(provider.sites.status().candidates[0].failures).toBe(0);
    provider.sites.close();
  });
  it('does not accept a different model ID in a status batch', async () => {
    const provider = fixtureProvider(
      async (input) =>
        Response.json({
          models: [
            {
              id: requestUrl(input).startsWith('https://site.invalid') ? 999 : 12,
              isLive: true,
              status: 'public',
            },
          ],
        }),
      { publicOrigins: ['https://site.invalid', 'https://backup.invalid'] },
    );
    await expect(provider.status(12)).rejects.toMatchObject({ code: 'upstream-identity-mismatch' });
    // Identity mismatch remains a model error; the valid JSON proved connectivity.
    expect(provider.sites.status().candidates[0].failures).toBe(0);
    provider.sites.close();
  });
  it('keeps anonymous status and account cookies on the same bound host without failover', async () => {
    const calls: { origin: string; cookie: string | null }[] = [];
    const provider = fixtureProvider(
      async (input, init) => {
        const url = new URL(requestUrl(input)),
          cookie = new Headers(init?.headers).get('cookie');
        calls.push({ origin: url.origin, cookie });
        if (url.pathname === '/api/front/models/list')
          return url.origin === 'https://site.invalid'
            ? new Response(null, { status: 503 })
            : Response.json({ models: [{ id: 12, isLive: true, status: 'public' }] });
        return new Response(null, { status: 503 });
      },
      { publicOrigins: ['https://site.invalid', 'https://backup.invalid'] },
    );
    await expect(provider.status(12)).rejects.toMatchObject({ status: 503 });
    await expect(provider.importAccount('session=synthetic')).rejects.toMatchObject({
      status: 503,
    });
    expect(calls).toEqual([
      { origin: 'https://site.invalid', cookie: null },
      { origin: 'https://site.invalid', cookie: 'session=synthetic' },
    ]);
    provider.sites.close();
  });
  it('returns account profile and targets from one initial request and counts index IDs', async () => {
    let initial = 0;
    const provider = fixtureProvider(async (input) => {
      const { pathname } = new URL(requestUrl(input));
      if (pathname.includes('initial-dynamic')) {
        initial++;
        return Response.json({
          initialDynamic: {
            user: {
              id: 9,
              username: 'synthetic-owner',
              avatarUrl: 'https://static-proxy.strpst.com/avatars/synthetic',
              followingCount: 31,
            },
          },
        });
      }
      if (pathname === '/api/front/users/9/favorites') return Response.json({ modelIds: [12] });
      if (pathname === '/api/front/v2/users')
        return Response.json({ items: [{ id: 12, username: 'fixture' }] });
      if (pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
      if (pathname === '/api/front/models/list')
        return Response.json({ models: [{ id: 12, isInFavorites: true }] });
      throw new Error('unexpected source');
    });
    const result = await provider.importAccount('session=synthetic');
    expect(provider.sites.status().access).toMatchObject({
      origin: 'https://site.invalid',
      error: null,
    });
    expect(provider.sites.status().access?.checkedAtMs).not.toBeNull();
    expect(initial).toBe(1);
    expect(result).toEqual({
      subjects: [{ id: 'stripchat:12', providerId: 12, handle: 'fixture' }],
      profile: {
        username: 'synthetic-owner',
        followingCount: 1,
        avatarSourceUrl: 'https://static-proxy.strpst.com/avatars/synthetic',
      },
      indexCount: 1,
      verifiedFollowingCount: 1,
      unresolvedProfileCount: 0,
    });
    expect(await provider.importList('session=synthetic')).toEqual(result.subjects);
    expect(initial).toBe(2);
  });
  it('keeps concurrent profile results bound to their own cookie invocation and rejects avatar SSRF', async () => {
    const provider = fixtureProvider(async (input, init) => {
      const owner = new Headers(init?.headers).get('cookie')?.endsWith('A') ? 'A' : 'B';
      const userId = owner === 'A' ? 9 : 10;
      const modelId = owner === 'A' ? 12 : 13;
      const { pathname } = new URL(requestUrl(input));
      if (pathname.includes('initial-dynamic'))
        return Response.json({
          initialDynamic: {
            user: {
              id: userId,
              username: 'synthetic-' + owner,
              avatarUrl:
                owner === 'A'
                  ? 'https://127.0.0.1/private'
                  : 'https://static-proxy.strpst.com/avatars/B',
            },
          },
        });
      if (pathname === `/api/front/users/${userId}/favorites`)
        return Response.json({ modelIds: [modelId] });
      if (pathname === '/api/front/v2/users')
        return Response.json({ items: [{ id: modelId, username: 'fixture-' + owner }] });
      if (pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
      if (pathname === '/api/front/models/list')
        return Response.json({ models: [{ id: modelId, isInFavorites: true }] });
      throw new Error('unexpected source');
    });
    const [a, b] = await Promise.all([
      provider.importAccount('session=A'),
      provider.importAccount('session=B'),
    ]);
    expect(a.profile).toEqual({
      username: 'synthetic-A',
      followingCount: 1,
      avatarSourceUrl: null,
    });
    expect(a.subjects[0].providerId).toBe(12);
    expect(b.profile.username).toBe('synthetic-B');
    expect(b.profile.followingCount).toBe(1);
    expect(b.subjects[0].providerId).toBe(13);
  });
  it('retains previously followed IDs unless the selected sources confirm an archive reason', async () => {
    const requested: number[] = [];
    const provider = fixtureProvider(async (input, init) => {
      const url = new URL(requestUrl(input));
      const headers = new Headers(init?.headers);
      expect(url.origin).toBe('https://site.invalid');
      if (/^\/known-\d+$/.test(url.pathname)) {
        expect(headers.has('cookie')).toBe(false);
        expect(headers.has('authorization')).toBe(false);
        return roomPage(url, url.pathname === '/known-18');
      }
      expect(headers.get('cookie')).toBe('session=synthetic');
      expect(headers.has('authorization')).toBe(false);
      if (url.pathname.includes('initial-dynamic'))
        return Response.json({ initialDynamic: { user: { id: 9, username: 'fixture-owner' } } });
      if (url.pathname === '/api/front/users/9/favorites') return Response.json({ modelIds: [12] });
      if (url.pathname === '/api/front/models/list')
        return Response.json({
          models: [
            { id: 12, isInFavorites: true, status: 'off', isLive: false },
            { id: 13, isInFavorites: true },
            { id: 14, isInFavorites: false },
            { id: 16, isInFavorites: false },
            { id: 19, isInFavorites: 'false' },
            { id: 20, isInFavorites: false },
          ],
        });
      if (url.pathname === '/api/front/v2/users') return Response.json({ items: [] });
      if (url.pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
      if (url.pathname.endsWith('/cam')) return new Response(null, { status: 403 });
      const id = Number(url.pathname.split('/').at(-1));
      requested.push(id);
      return Response.json({
        item: {
          id: id === 16 ? 999 : id,
          username: id === 20 ? undefined : `known-${id}`,
          isDeleted: id === 17,
          isBlocked: id === 14,
        },
      });
    });
    const known = Array.from({ length: 9 }, (_value, index) => ({
      id: `stripchat:${index + 12}`,
      providerId: index + 12,
      handle: `known-${index + 12}`,
    }));
    const result = await provider.importAccount(
      'session=synthetic',
      undefined,
      undefined,
      undefined,
      async (username) => {
        expect(username).toBe('fixture-owner');
        return known;
      },
    );
    expect(requested.sort((a, b) => a - b)).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
    expect(result.subjects).toEqual(
      known.map((row) => {
        if (row.providerId === 14)
          return { ...row, accountArchiveReason: 'unfollowed', accountUnfollowConfirmed: true };
        if (row.providerId === 17) return { ...row, accountArchiveReason: 'account_deleted' };
        if (row.providerId === 18)
          return {
            ...row,
            accountArchiveReason: 'account_disabled',
            accountBlockedConfirmed: true,
          };
        return row;
      }),
    );
    expect(result.unverifiedMissingCount).toBe(4);
    expect(result.verifiedFollowingCount).toBe(2);
    expect(result.profile.followingCount).toBe(1);
  });
  it('recovers confirmed follows and reclassifies regional archives with their evidence intact', async () => {
    const indexed = [12, 20, 21, 22, 23, 24, 25];
    const provider = fixtureProvider(async (input) => {
      const url = new URL(requestUrl(input));
      const { pathname } = url;
      if (pathname.includes('initial-dynamic'))
        return Response.json({ initialDynamic: { user: { id: 9, username: 'fixture-owner' } } });
      if (pathname === '/api/front/users/9/favorites') return Response.json({ modelIds: indexed });
      if (pathname === '/api/front/v2/users') return Response.json({ items: [] });
      if (pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
      if (pathname === '/api/front/models/list')
        return Response.json({
          models: indexed.map((id) => ({
            id,
            isInFavorites: true,
            ...(id === 24 ? { status: 'off', isLive: false } : {}),
          })),
        });
      if (/^\/archived-\d+$/.test(pathname)) return roomPage(url);
      const id = Number(pathname.split('/').at(-1));
      return Response.json({
        item: {
          id: id === 23 ? 999 : id,
          username: `archived-${id}`,
          isDeleted: id === 22 ? undefined : false,
        },
      });
    });
    const subject = (providerId: number) => ({
      id: `stripchat:${providerId}`,
      providerId,
      handle: `archived-${providerId}`,
    });
    const archived = [
      { ...subject(20), accountArchiveReason: 'unfollowed' as const },
      { ...subject(21), accountArchiveReason: 'account_disabled' as const },
      subject(22),
      { ...subject(23), accountArchiveReason: 'unfollowed' as const },
      { ...subject(24), accountArchiveReason: 'region_restricted' as const },
      subject(25),
    ];
    const result = await provider.importAccount(
      'session=synthetic',
      undefined,
      undefined,
      undefined,
      async () => [subject(12)],
      async (username) => {
        expect(username).toBe('fixture-owner');
        return archived;
      },
    );
    expect(result.subjects).toEqual([
      subject(12),
      subject(20),
      archived[1],
      { ...subject(22), accountArchivePending: true },
      { ...subject(23), accountArchivePending: true },
      archived[4],
      subject(25),
    ]);
    expect(result.recoveredArchivedCount).toBe(3);
    expect(result.unverifiedMissingCount).toBeUndefined();
    expect(result.profile.followingCount).toBe(indexed.length);
  });
  it('preserves known models when account evidence is blocked by a challenge', async () => {
    let probes = 0;
    const provider = fixtureProvider(async (input) => {
      const { pathname } = new URL(requestUrl(input));
      if (pathname.includes('initial-dynamic'))
        return Response.json({ initialDynamic: { user: { id: 9, username: 'fixture-owner' } } });
      if (pathname === '/api/front/users/9/favorites') return Response.json({ modelIds: [12] });
      if (pathname === '/api/front/v2/users') return Response.json({ items: [] });
      if (pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
      if (pathname === '/api/front/models/list')
        return Response.json({ models: [{ id: 12, isInFavorites: true }] });
      probes++;
      return Response.json(
        { item: { id: Number(pathname.split('/').at(-1)), isDeleted: true } },
        { status: 403, headers: { 'cf-mitigated': 'challenge' } },
      );
    });
    const known = Array.from({ length: 9 }, (_value, index) => ({
      id: `stripchat:${index + 12}`,
      providerId: index + 12,
      handle: `known-${index + 12}`,
    }));
    const result = await provider.importAccount(
      'session=synthetic',
      undefined,
      undefined,
      undefined,
      async () => known,
    );
    expect(probes).toBe(4);
    expect(result.subjects).toEqual(known);
    expect(result.unverifiedMissingCount).toBe(known.length - 1);
  });
  it('cancels the import when its transport is withdrawn during account verification', async () => {
    let started!: (signal?: AbortSignal | null) => void;
    const checked = new Promise<AbortSignal | null | undefined>((resolve) => {
      started = resolve;
    });
    const provider = fixtureProvider(async (input, init) => {
      const { pathname } = new URL(requestUrl(input));
      if (pathname.includes('initial-dynamic'))
        return Response.json({ initialDynamic: { user: { id: 9, username: 'fixture-owner' } } });
      if (pathname === '/api/front/users/9/favorites') return Response.json({ modelIds: [] });
      if (pathname === '/api/front/v2/users') return Response.json({ items: [] });
      if (pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
      if (pathname === '/api/front/models/list') return Response.json({ models: [] });
      started(init?.signal);
      return new Promise<Response>(() => undefined);
    });
    const controller = new AbortController();
    const result = provider.importAccount(
      'session=synthetic',
      controller.signal,
      undefined,
      undefined,
      async () => [{ id: 'stripchat:12', providerId: 12, handle: 'known' }],
    );
    const verification = await checked;
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
    expect(verification?.aborted).toBe(true);
  });
  it('rejects guests before requesting the account index', async () => {
    let calls = 0;
    const provider = fixtureProvider(async () => {
      calls++;
      return Response.json({ initialDynamic: { jwtToken: 'guest-token', user: null } });
    });
    await expect(provider.importList('guest=synthetic')).rejects.toMatchObject({
      code: 'account-session-unavailable',
    });
    expect(calls).toBe(1);
  });
  it('imports JSON cookie exports with domain, path, expiry and HttpOnly filtering', () => {
    const rows = [
      {
        domain: '.stripchat.com',
        path: '/',
        name: 'session',
        value: 'synthetic',
        httpOnly: true,
        session: true,
      },
      { domain: '.stripchat.com', path: '/', name: 'expired', value: 'x', expirationDate: 1 },
      { domain: 'stripchat.com.evil.invalid', path: '/', name: 'foreign', value: 'x' },
      { domain: '.stripchat.com', path: '/other', name: 'scoped', value: 'x' },
    ];
    expect(parseAccountCookies(JSON.stringify(rows), 'stripchat.com', 10000)).toBe(
      'session=synthetic',
    );
    for (const expiry of [
      { expirationDate: 0, session: false },
      { expirationDate: -1, session: false },
      { expires: 1 },
      { expires: -1, session: false },
    ]) {
      expect(() =>
        parseAccountCookies(
          JSON.stringify([{ domain: '.stripchat.com', name: 'expired', value: 'x', ...expiry }]),
          'stripchat.com',
          10000,
        ),
      ).toThrow();
    }
    expect(
      parseAccountCookies(
        JSON.stringify([{ domain: '.stripchat.com', name: 'session', value: 'x', expires: -1 }]),
        'stripchat.com',
        10000,
      ),
    ).toBe('session=x');
    for (const text of [
      '[',
      '[]',
      '[{"name":"x","value":"x"}]',
      JSON.stringify([{ domain: '.stripchat.com', name: 'x', value: 'x\r\ninjected' }]),
    ])
      expect(() => parseAccountCookies(text, 'stripchat.com', 10000)).toThrow();
  });
  it.each([
    { status: 'public', isLive: false },
    { status: 'off', isLive: true },
    { status: 'private', isLive: false },
    { status: 'upstream-unavailable', isLive: false },
    { isLive: false },
    { status: 'off' },
  ])('does not invent OFFLINE from contradictory model status fields %j', async (item) => {
    const provider = fixtureProvider(async () => Response.json({ models: [{ id: 12, ...item }] }));
    expect(await provider.status(12)).toBe('UNKNOWN');
  });
  it('GETs model status batches with zero account headers or profile/JWT requests', async () => {
    const calls: {
      url: string;
      headers: Headers;
      credentials: NonNullable<Parameters<typeof fetch>[1]>['credentials'];
    }[] = [];
    const provider = fixtureProvider(async (input, init) => {
      calls.push({
        url: requestUrl(input),
        headers: new Headers(init?.headers),
        credentials: init?.credentials,
      });
      return Response.json({ models: [{ id: 12, status: 'public', isLive: true }] });
    });
    expect(await provider.status(12)).toBe('PUBLIC');
    expect(calls).toHaveLength(1);
    const request = new URL(calls[0].url);
    expect(request.origin + request.pathname).toBe('https://site.invalid/api/front/models/list');
    expect(request.searchParams.get('modelIds[0]')).toBe('12');
    expect(calls[0].headers.has('cookie')).toBe(false);
    expect(calls[0].headers.has('authorization')).toBe(false);
    expect(calls[0].credentials).toBe('omit');
  });
  it('keeps account cookies separate from anonymous status and returns only directory fields', async () => {
    const headers: Headers[] = [];
    const provider = fixtureProvider(async (input, init) => {
      const current = new Headers(init?.headers);
      headers.push(current);
      const { pathname } = new URL(requestUrl(input));
      if (pathname === '/api/front/models/list' && !current.has('cookie'))
        return Response.json({ models: [{ id: 12, status: 'private', isLive: true }] });
      if (pathname.includes('initial-dynamic'))
        return Response.json({
          initialDynamic: { user: { id: 9, username: 'synthetic-account' }, jwtToken: 'one-shot' },
        });
      if (pathname === '/api/front/users/9/favorites') return Response.json({ modelIds: [12] });
      if (pathname === '/api/front/v2/users')
        return Response.json({ items: [{ id: 12, username: 'fixture' }] });
      if (pathname === '/api/front/v2/users/profiles') return Response.json({ items: {} });
      return Response.json({
        models: [
          { id: 12, status: 'public', isLive: true, snapshotTimestamp: 111, isInFavorites: true },
        ],
      });
    });
    expect(await provider.importList('fixture=one-shot')).toEqual([
      { id: 'stripchat:12', providerId: 12, handle: 'fixture' },
    ]);
    expect(await provider.status(12)).toBe('PRIVATE');
    expect(headers).toHaveLength(6);
    expect(
      headers.slice(0, -1).every((header) => header.get('cookie') === 'fixture=one-shot'),
    ).toBe(true);
    expect(headers.at(-1)?.has('cookie')).toBe(false);
    expect(headers.every((header) => !header.has('authorization'))).toBe(true);
  });
  it('fails an inaccessible index atomically and keeps status independent', async () => {
    const provider = fixtureProvider(async (input) => {
      const { pathname } = new URL(requestUrl(input));
      if (pathname === '/api/front/models/list')
        return Response.json({ models: [{ id: 12, status: 'off', isLive: false }] });
      if (pathname.includes('initial-dynamic'))
        return Response.json({
          initialDynamic: { user: { id: 9, username: 'synthetic-account' } },
        });
      if (pathname === '/api/front/users/9/favorites') return new Response('', { status: 403 });
      throw new Error('unexpected fallback source');
    });
    await expect(provider.importList('fixture=one-shot')).rejects.toMatchObject({ status: 403 });
    expect(await provider.status(12)).toBe('OFFLINE');
  });
  it('propagates an HTTP error instead of inventing OFFLINE', async () => {
    const provider = fixtureProvider(async () => new Response('', { status: 503 }));
    await expect(provider.status(12)).rejects.toMatchObject({ status: 503 });
  });
  it('filters Netscape cookies by domain/expiry while preserving applicable HttpOnly cookies', () => {
    const text =
      '# Netscape HTTP Cookie File\n#HttpOnly_.stripchat.com\tTRUE\t/\tTRUE\t0\tfixture\tx\n.evil.invalid\tTRUE\t/\tTRUE\t0\tforeign\tx\n.stripchat.com\tTRUE\t/\tTRUE\t1\texpired\tx\n';
    expect(parseAccountCookies(text, 'stripchat.com', 10000)).toBe('fixture=x');
    expect(parseAccountCookies('Cookie: fixture=x; second=y', 'stripchat.com', 0)).toBe(
      'fixture=x; second=y',
    );
  });
});

describe('bounded anonymous HTTP', () => {
  it('includes a stalled body in its deadline and cancels it', async () => {
    let cancelled = false;
    const http = createHttp({
      timeoutMs: 15,
      allow: () => true,
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1]));
            },
            cancel() {
              cancelled = true;
            },
          }),
        ),
    });
    await expect(http.bytes('https://fixture.invalid')).rejects.toMatchObject({
      code: 'request-deadline',
    });
    expect(cancelled).toBe(true);
  });
  it('cancels a slow body when the caller aborts', async () => {
    let started: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const controller = new AbortController();
    const http = createHttp({
      allow: () => true,
      fetch: async () => {
        started?.();
        return new Response(new ReadableStream<Uint8Array>());
      },
    });
    const result = http.bytes('https://fixture.invalid', { signal: controller.signal });
    await waiting;
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
  });
  it('bounds streamed bytes even without content-length', async () => {
    const http = createHttp({
      allow: () => true,
      fetch: async () => new Response(new Uint8Array(17)),
    });
    await expect(http.bytes('https://fixture.invalid', { maxBytes: 16 })).rejects.toMatchObject({
      code: 'body-too-large',
    });
  });
  it('rejects redirects outside the hostname allowlist before a second request', async () => {
    let calls = 0;
    const http = createHttp({
      allow: (url) => url.hostname === 'fixture.invalid',
      fetch: async () => {
        calls++;
        return new Response('', {
          status: 302,
          headers: { location: 'https://attacker.invalid/' },
        });
      },
    });
    await expect(http.bytes('https://fixture.invalid')).rejects.toMatchObject({
      code: 'upstream-url-denied',
    });
    expect(calls).toBe(1);
  });
  it('does not forward a one-shot cookie even to another allowed origin', async () => {
    let calls = 0;
    const http = createHttp({
      account: true,
      allow: () => true,
      fetch: async () => {
        calls++;
        return new Response('', { status: 302, headers: { location: 'https://other.invalid/' } });
      },
    });
    await expect(
      http.bytes('https://fixture.invalid', { cookie: 'fixture=x' }),
    ).rejects.toMatchObject({ code: 'account-redirect-denied' });
    expect(calls).toBe(1);
  });
  it('refuses credentials on an anonymous HTTP client', async () => {
    const http = createHttp({
      allow: () => true,
      fetch: async () => {
        throw new Error('must-not-send');
      },
    });
    await expect(
      http.bytes('https://fixture.invalid', { cookie: 'fixture=x' }),
    ).rejects.toMatchObject({ code: 'anonymous-credentials-denied' });
    await expect(
      http.bytes('https://fixture.invalid', { authorization: 'fixture-token' }),
    ).rejects.toMatchObject({ code: 'anonymous-credentials-denied' });
  });
  it('does not archive a successful HTML challenge as media', async () => {
    const http = createHttp({
      allow: () => true,
      fetch: async () => new Response('fixture', { headers: { 'content-type': 'text/html' } }),
    });
    await expect(http.bytes('https://fixture.invalid', { media: true })).rejects.toMatchObject({
      code: 'invalid-media-type',
    });
  });
});

describe('HLS parsing and address decryption', () => {
  it('parses advertised variants and exact key/psch fields', () => {
    expect(
      parseMaster(
        '#EXTM3U\n#EXT-X-MOUFLON:PSCH:info:7:key-name\n#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=640x360\nmain.m3u8\n',
        'https://edge.invalid/root/master.m3u8',
      ),
    ).toEqual({
      keys: [{ name: 'key-name', psch: '7' }],
      variants: [
        { url: 'https://edge.invalid/root/main.m3u8', bandwidth: 400000, width: 640, height: 360 },
      ],
    });
  });
  it('accepts evidenced +0000 PDT and rejects invalid calendar/unzoned values', () => {
    expect(parsePdt('2026-11-02T15:46:14.151+0000')).toBe(Date.UTC(2026, 10, 2, 15, 46, 14, 151));
    expect(() => parsePdt('2026-02-31T00:00:00Z')).toThrow();
    expect(() => parsePdt('2026-11-02T00:00:00')).toThrow();
  });
  it('excludes ordinary decoys and LL parts from protected full-segment identity', () => {
    const playlist = parsePlaylist(
      '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:9007199254740993\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\ndecoy.mp4\n#EXT-X-PART:DURATION=0.5,URI="part.mp4"\n#EXT-X-MOUFLON:URI:ignored_12_part0.mp4\n#EXT-X-PROGRAM-DATE-TIME:2026-11-02T15:46:14.151+0000\n#EXTINF:2.002,\n#EXT-X-MOUFLON:URI:full_12.mp4\ndecoy-after.mp4\n#EXT-X-DISCONTINUITY\n#EXTINF:1.998,\n#EXT-X-MOUFLON:URI:full_13.mp4\n',
      'https://edge.invalid/main.m3u8',
    );
    expect(playlist.segments).toHaveLength(2);
    expect(playlist.segments[0].sequence).toBe('9007199254740993');
    expect(playlist.segments[0].address).toBe('https://edge.invalid/full_12.mp4');
    expect(playlist.segments[0].wallStartMs).toBe(Date.UTC(2026, 10, 2, 15, 46, 14, 151));
    expect(playlist.segments[1]).toMatchObject({
      sequence: '9007199254740994',
      discontinuity: true,
      wallStartMs: null,
    });
  });
  it('rejects delta playlists rather than misnumbering skipped segments', () => {
    expect(() =>
      parsePlaylist('#EXTM3U\n#EXT-X-SKIP:SKIPPED-SEGMENTS=2\n', 'https://edge.invalid/main.m3u8'),
    ).toThrow('unsupported-delta-playlist');
  });
  it('retains a direct PDT when the discontinuity tag follows it before the same segment', () => {
    const playlist = parsePlaylist(
      '#EXTM3U\n#EXT-X-PROGRAM-DATE-TIME:2026-11-02T00:00:00Z\n#EXT-X-DISCONTINUITY\n#EXTINF:2,\nfull.m4s\n',
      'https://edge.invalid/main.m3u8',
    );
    expect(playlist.segments[0]).toMatchObject({
      discontinuity: true,
      wallStartMs: Date.UTC(2026, 10, 2),
    });
  });
  it('decrypts an independently encoded component, preserves its separators, rejects wrong keys and parts', () => {
    const token = encodeToken('0123456789abcdef', 'synthetic-secret');
    expect(
      decryptAddress(`https://edge.invalid/hls/path_${token}_123.mp4?x=1`, 'synthetic-secret'),
    ).toBe('https://edge.invalid/hls/path_0123456789abcdef_123.mp4?x=1');
    expect(() =>
      decryptAddress(`https://edge.invalid/hls/path_${token}_123.mp4`, 'other-secret'),
    ).toThrow();
    expect(() =>
      decryptAddress(`https://edge.invalid/hls/path_${token}_123_part1.mp4`, 'synthetic-secret'),
    ).toThrow();
  });
});

it('distinguishes a foreign-domain cookie export from expired cookies', () => {
  expect(() =>
    parseAccountCookies(
      JSON.stringify([{ domain: '.stripchat.com', name: 'session', value: 'synthetic' }]),
      'stripchat.org',
      Date.now(),
    ),
  ).toThrow('cookies-domain-mismatch');
});

it('uses only the explicitly selected login domain while public status remains anonymous', async () => {
  const calls: { origin: string; cookie: string | null }[] = [];
  const provider = createProvider({
    accountOrigin: 'https://stripchat.com',
    publicOrigins: ['https://aznudelive.com'],
    fetch: async (input, init) => {
      const url = new URL(requestUrl(input));
      calls.push({ origin: url.origin, cookie: new Headers(init?.headers).get('cookie') });
      if (url.pathname.includes('initial-dynamic'))
        return Response.json({ initialDynamic: { user: { id: 9, username: 'fixture' } } });
      if (url.pathname === '/api/front/models/list')
        return Response.json({ models: [{ id: 12, isLive: true, status: 'public' }] });
      if (url.pathname === '/api/front/users/9/favorites') return Response.json({ modelIds: [] });
      throw new Error('unexpected source');
    },
  });
  await provider.importAccount('session=synthetic', undefined, undefined, 'https://stripchat.org');
  expect(calls).toHaveLength(2);
  expect(
    calls.every(
      (call) => call.origin === 'https://stripchat.org' && call.cookie === 'session=synthetic',
    ),
  ).toBe(true);
  expect(await provider.status(12)).toBe('PUBLIC');
  expect(calls.at(-1)).toEqual({ origin: 'https://aznudelive.com', cookie: null });
});

it('does not mislabel an empty cookie export as a foreign-domain session', () => {
  expect(() => parseAccountCookies('[]', 'stripchat.com', Date.now())).toThrow(
    'no-applicable-cookies',
  );
});

it('bounds a media throughput sample without relaxing full-download limits', async () => {
  let cancelled = 0;
  const http = createHttp({
    allow: () => true,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(1024));
          },
          cancel() {
            cancelled++;
          },
        }),
        { headers: { 'content-type': 'video/mp4', 'content-length': '10485760' } },
      ),
  });
  await expect(
    http.bytes('https://fixture.invalid/media', { maxBytes: 512, media: true }),
  ).rejects.toMatchObject({ code: 'body-too-large' });
  const sample = await http.bytes('https://fixture.invalid/media', {
    maxBytes: 512,
    media: true,
    prefix: true,
  });
  expect(sample.byteLength).toBe(512);
  expect(cancelled).toBe(2);
});
