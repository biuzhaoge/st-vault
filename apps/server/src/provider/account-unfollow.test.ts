import { describe, expect, it, vi } from 'vitest';
import { createProvider } from './index.js';

const origin = 'https://zh.stripchat.com';
const favorites = '/api/front/users/17/favorites';
const protectedId = 42;
const roomHandle = 'archive_room';
const roomPath = `/${roomHandle}`;
const sessionFields = {
  csrfToken: 'fixture-csrf-token',
  csrfTimestamp: 'fixture-csrf-time',
  csrfNotifyTimestamp: 'fixture-notify-time',
};

function roomPage(disabled = true) {
  const content = disabled
    ? `<div class="deleted-wrapper"><div class="account-disabled-header">账户被禁用</div><div class="account-disabled-description">${roomHandle}的账户已被禁用。</div></div>`
    : '<div class="view-cam-page"><div class="view-cam-container"></div></div>';
  return new Response(
    `<html lang="zh"><head><link rel="canonical" href="${origin}${roomPath}"></head><body>${content}</body></html>`,
    {
      status: disabled ? 404 : 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    },
  );
}

function fixture({
  response = () => Response.json([]),
  csrf = sessionFields,
  flags = { id: protectedId, isBlocked: false, isDeleted: false },
  room = () => roomPage(),
  indexed = [99],
}: {
  response?: () => Response;
  csrf?: Partial<typeof sessionFields>;
  flags?: { id: number; isBlocked: boolean; isDeleted: boolean };
  room?: () => Response;
  indexed?: number[];
} = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname.endsWith('/initial-dynamic'))
      return Promise.resolve(
        Response.json({ initialDynamic: { user: { id: 17, username: 'owner' }, ...csrf } }),
      );
    if (url.pathname === favorites && init?.method === 'DELETE') return Promise.resolve(response());
    if (url.pathname === favorites) return Promise.resolve(Response.json({ modelIds: indexed }));
    if (url.pathname === '/api/front/models/list')
      return Promise.resolve(Response.json({ models: [{ id: 99, isInFavorites: true }] }));
    if (url.pathname === `/api/front/v2/users/${protectedId}`)
      return Promise.resolve(Response.json({ item: { ...flags, username: roomHandle } }));
    if (url.pathname === roomPath) return Promise.resolve(room());
    if (url.pathname === `/api/front/v2/models/${protectedId}/cam`)
      return Promise.resolve(new Response(null, { status: 403 }));
    throw new Error('unexpected-request');
  });
  const provider = createProvider({ fetch });
  const signal = new AbortController().signal;
  return {
    signal,
    open: (username: string | null = 'OWNER') =>
      provider.openArchiveReasonProbe('session=fixture', origin, username ?? undefined, signal),
    manual: (id = protectedId, username = 'OWNER', requestSignal = signal) =>
      provider.unfollowAccountSubject('session=fixture', origin, username, id, requestSignal),
    paths: () =>
      fetch.mock.calls.map(
        ([input]) => new URL(input instanceof Request ? input.url : input).pathname,
      ),
    writes: () => fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE'),
  };
}

describe('manual account unfollow', () => {
  it('removes the requested ID from the verified account without needing block evidence', async () => {
    const { manual, paths, writes } = fixture({ indexed: [99, protectedId] });
    await expect(manual()).resolves.toBeUndefined();
    expect(paths()).toEqual(['/api/front/v3/config/initial-dynamic', favorites, favorites]);
    expect(writes()).toHaveLength(1);
    const [url, init] = writes()[0];
    expect(url).toBe(origin + favorites);
    const body = init?.body;
    if (typeof body !== 'string') throw new Error('expected-json-request');
    expect(JSON.parse(body) as unknown).toMatchObject({ favoriteIds: [protectedId] });
  });

  it('does not send a removal for another account, invalid ID, or aborted action', async () => {
    const { manual, writes } = fixture();
    await expect(manual(protectedId, 'someone-else')).rejects.toMatchObject({
      code: 'upstream-identity-mismatch',
    });
    await expect(manual(protectedId, '')).rejects.toMatchObject({
      code: 'account-session-unavailable',
    });
    await expect(manual(-1)).rejects.toMatchObject({ code: 'invalid-provider-id' });
    await expect(manual(protectedId, 'OWNER', AbortSignal.abort())).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(writes()).toHaveLength(0);
  });

  it('recognizes a repeated request only when the native result and the index both confirm absence', async () => {
    const options = {
      response: () =>
        Response.json({ error: 'There are no favorites to delete', data: [] }, { status: 400 }),
    };
    await expect(fixture(options).manual()).resolves.toBeUndefined();
    await expect(
      fixture({ ...options, indexed: [99, protectedId] }).manual(),
    ).rejects.toMatchObject({
      code: 'upstream-http',
      status: 400,
    });
  });
});

describe('blocked account unfollow', () => {
  it('uses the bound session to remove only the freshly confirmed blocked ID', async () => {
    const { open, signal, writes } = fixture();
    const probe = await open();
    await expect(probe.unfollowBlocked(protectedId, signal)).rejects.toMatchObject({
      code: 'blocked-account-unconfirmed',
    });
    await expect(probe(protectedId, signal)).resolves.toBe('account_disabled');
    await expect(probe.unfollowBlocked(43, signal)).rejects.toMatchObject({
      code: 'blocked-account-unconfirmed',
    });
    expect(writes()).toHaveLength(0);
    await expect(probe.unfollowBlocked(protectedId, signal)).resolves.toBeUndefined();

    const [url, init] = writes()[0];
    expect(url).toBe(origin + favorites);
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'manual' });
    const headers = new Headers(init?.headers);
    expect(headers.get('cookie')).toBe('session=fixture');
    expect(headers.get('origin')).toBe(origin);
    expect(headers.has('authorization')).toBe(false);
    const body = init?.body;
    if (typeof body !== 'string') throw new Error('expected-json-request');
    const payload: unknown = JSON.parse(body);
    const nonce: unknown = expect.stringMatching(/^[0-9a-f]{16}$/);
    expect(payload).toEqual({
      favoriteIds: [protectedId],
      ...sessionFields,
      uniq: nonce,
    });
    await expect(probe.unfollowBlocked(protectedId, signal)).rejects.toMatchObject({
      code: 'blocked-account-unconfirmed',
    });
    expect(writes()).toHaveLength(1);
  });

  it('does not mutate with a missing session CSRF value', async () => {
    const { open, signal, writes } = fixture({ csrf: {} });
    const probe = await open();
    await probe(protectedId, signal);
    await expect(probe.unfollowBlocked(protectedId, signal)).rejects.toMatchObject({
      code: 'account-csrf-unavailable',
    });
    expect(writes()).toHaveLength(0);
  });

  it('does not treat a deleted account as a fresh block', async () => {
    const { open, signal, writes } = fixture({
      flags: { id: protectedId, isBlocked: true, isDeleted: true },
    });
    const probe = await open();
    await expect(probe(protectedId, signal)).resolves.toBe('account_deleted');
    await expect(probe.unfollowBlocked(protectedId, signal)).rejects.toMatchObject({
      code: 'blocked-account-unconfirmed',
    });
    expect(writes()).toHaveLength(0);
  });

  it('requires the expected account and discards an older block after reevaluation', async () => {
    let disabled = true;
    const { open, signal, writes } = fixture({ room: () => roomPage(disabled) });
    const unidentified = await open(null);
    await expect(unidentified(protectedId, signal)).resolves.toBe('account_disabled');
    await expect(unidentified.unfollowBlocked(protectedId, signal)).rejects.toMatchObject({
      code: 'blocked-account-unconfirmed',
    });

    const probe = await open();
    await expect(probe(protectedId, signal)).resolves.toBe('account_disabled');
    disabled = false;
    await expect(probe(protectedId, signal)).resolves.toBeNull();
    await expect(probe.unfollowBlocked(protectedId, signal)).rejects.toMatchObject({
      code: 'blocked-account-unconfirmed',
    });
    expect(writes()).toHaveLength(0);
  });

  it('does not authorize removal based on a user API block with a normal room', async () => {
    const { open, signal, writes } = fixture({
      flags: { id: protectedId, isBlocked: true, isDeleted: false },
      room: () => roomPage(false),
    });
    const probe = await open();
    await expect(probe(protectedId, signal)).resolves.toBeNull();
    await expect(probe.unfollowBlocked(protectedId, signal)).rejects.toMatchObject({
      code: 'blocked-account-unconfirmed',
    });
    expect(writes()).toHaveLength(0);
  });

  it('accepts the exact already-absent response alongside a fresh block and bound index absence', async () => {
    const { open, signal, writes } = fixture({
      response: () =>
        Response.json({ error: 'There are no favorites to delete', data: [] }, { status: 400 }),
    });
    const probe = await open();
    await expect(probe(protectedId, signal)).resolves.toBe('account_disabled');
    await expect(probe.unfollowBlocked(protectedId, signal)).resolves.toBeUndefined();
    expect(writes()).toHaveLength(1);
  });

  it('rejects the already-absent response when that exact ID is in the bound index', async () => {
    const { open, signal, writes } = fixture({
      indexed: [99, protectedId],
      response: () =>
        Response.json({ error: 'There are no favorites to delete', data: [] }, { status: 400 }),
    });
    const probe = await open();
    await probe(protectedId, signal);
    await expect(probe.unfollowBlocked(protectedId, signal)).rejects.toMatchObject({
      code: 'upstream-http',
      status: 400,
    });
    expect(writes()).toHaveLength(1);
  });

  it.each([
    {
      name: 'a success-status error object',
      response: () => Response.json({ error: 'denied' }),
      code: 'unfollow-response-unconfirmed',
    },
    {
      name: 'a different HTTP 400 response',
      response: () => Response.json({ error: 'Invalid CSRF token', data: [] }, { status: 400 }),
      code: 'upstream-http',
    },
    {
      name: 'an already-absent text response without the JSON envelope',
      response: () => new Response('There are no favorites to delete', { status: 400 }),
      code: 'upstream-http',
    },
    {
      name: 'an already-absent error with extra response data',
      response: () =>
        Response.json(
          { error: 'There are no favorites to delete', data: [{ failed: 42 }] },
          { status: 400 },
        ),
      code: 'upstream-http',
    },
    {
      name: 'a response without a body',
      response: () => new Response(null, { status: 204 }),
      code: 'unfollow-response-unconfirmed',
    },
    {
      name: 'a successful-status challenge',
      response: () => Response.json([], { headers: { 'cf-mitigated': 'challenge' } }),
      code: 'upstream-http',
    },
    {
      name: 'a remote redirect',
      response: () => Response.redirect('https://unlisted.invalid/', 302),
      code: 'redirect-denied',
    },
  ])('rejects $name without authorizing cleanup', async ({ response, code }) => {
    const { open, signal, writes } = fixture({ response });
    const probe = await open();
    await probe(protectedId, signal);
    await expect(probe.unfollowBlocked(protectedId, signal)).rejects.toMatchObject({ code });
    expect(writes()).toHaveLength(1);
  });

  it('cancels a blocked unfollow when the caller or binding aborts', async () => {
    const { open, signal, writes } = fixture();
    const probe = await open();
    await probe(protectedId, signal);
    const cancelled = AbortSignal.abort();
    await expect(probe.unfollowBlocked(protectedId, cancelled)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(writes()).toHaveLength(0);
  });
});
