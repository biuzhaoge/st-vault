import { describe, expect, it, vi } from 'vitest';
import { createProvider } from './index.js';

const origin = 'https://stripchat.com';
const other = 'https://stripchat.mov';
const toUrl = (input: string | URL | Request) =>
  new URL(input instanceof Request ? input.url : input);
const blocked = () =>
  new Response('<h1>Sorry, you have been blocked</h1>', {
    status: 403,
    headers: { 'content-type': 'text/html' },
  });

describe('live status reads on a bound site', () => {
  it('uses a single anonymous model batch for fresh statuses on the first observation', async () => {
    const items = new Map([
      [12, { id: 12, status: 'public', isLive: true }],
      [13, { id: 13, status: 'off', isLive: false }],
      [14, { id: 14, status: 'p2p', isLive: true }],
    ]);
    const calls: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const url = toUrl(input);
      calls.push(url.pathname);
      if (url.pathname === '/api/front/models/list') {
        const ids = [...url.searchParams.values()].map(Number);
        const models = ids.map((id) => items.get(id)).filter(Boolean);
        return Promise.resolve(Response.json({ models }));
      }
      return Promise.resolve(blocked());
    });
    const { status } = createProvider({ origin, fetch });

    await expect(Promise.all([status(12), status(13), status(14)])).resolves.toEqual([
      'PUBLIC',
      'OFFLINE',
      'PRIVATE',
    ]);
    expect(calls).toEqual(['/api/front/models/list']);
  });

  it.each([
    () => new Response('verify', { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
    () => Response.json({ description: 'Access forbidden: reason=geoBan' }, { status: 403 }),
    blocked,
    () => new Response(null, { status: 429 }),
  ])('propagates a failed model batch', async (response) => {
    const upstream = response();
    const fetch = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(upstream));
    const { status } = createProvider({ origin, fetch });

    await expect(status(12)).rejects.toMatchObject({ status: upstream.status });
    expect(fetch.mock.calls.map(([url]) => toUrl(url).pathname)).toEqual([
      '/api/front/models/list',
    ]);
  });

  it('leaves missing cards and contradictory states unknown in the same batch', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const url = toUrl(input);
      if (url.pathname === '/api/front/models/list') {
        return Promise.resolve(
          Response.json({
            models: [
              { id: 12, status: 'public', isLive: true },
              { id: 13, status: 'off', isLive: true },
            ],
          }),
        );
      }
      return Promise.resolve(
        Response.json({ item: { modelId: 14, status: 'off', isLive: false } }),
      );
    });
    const { status } = createProvider({ origin, fetch });
    await expect(Promise.all([status(12), status(13), status(14)])).resolves.toEqual([
      'PUBLIC',
      'UNKNOWN',
      'UNKNOWN',
    ]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('preserves snapshots for inconclusive cards and restores the default at a confirmed transition', async () => {
    const small = 'https://static-cdn.strpst.com/previews/fixture-thumb-small';
    const row = { id: 12, status: 'public', isLive: true, previewUrlThumbSmall: small };
    const fetch = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json({ models: [row, { id: 99, isLive: false, status: 'off' }] }),
      )
      .mockResolvedValueOnce(Response.json({ models: [{ ...row, snapshotTimestamp: 123 }] }))
      .mockResolvedValueOnce(Response.json({ models: [row] }))
      .mockResolvedValueOnce(Response.json({ models: [] }))
      .mockResolvedValueOnce(
        Response.json({ models: [{ ...row, status: 'groupShow', snapshotTimestamp: 124 }] }),
      )
      .mockResolvedValueOnce(
        Response.json({
          models: [{ ...row, status: 'off', isLive: false, snapshotTimestamp: 125 }],
        }),
      );
    const onCoverObserved = vi.fn();
    const { status } = createProvider({ origin, fetch, onCoverObserved });
    await expect(status(12)).rejects.toMatchObject({ code: 'upstream-identity-mismatch' });
    expect(onCoverObserved).not.toHaveBeenCalled();
    await expect(status(12)).resolves.toBe('PUBLIC');
    expect(onCoverObserved).toHaveBeenCalledExactlyOnceWith(
      'stripchat:12',
      'https://img.doppiocdn.org/snapshot/12/123',
    );
    await expect(status(12)).resolves.toBe('PUBLIC');
    await expect(status(12)).resolves.toBe('UNKNOWN');
    expect(onCoverObserved).toHaveBeenCalledTimes(1);
    await expect(status(12)).resolves.toBe('PRIVATE');
    expect(onCoverObserved).toHaveBeenLastCalledWith('stripchat:12', null);
    await expect(status(12)).resolves.toBe('OFFLINE');
    expect(onCoverObserved).toHaveBeenCalledTimes(3);
    expect(onCoverObserved).toHaveBeenLastCalledWith('stripchat:12', null);
  });

  it('uses the selected site batch after a binding change', async () => {
    const paths: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>((input) => {
      const url = toUrl(input);
      paths.push(url.origin + url.pathname);
      if (url.pathname !== '/api/front/models/list') return Promise.resolve(blocked());
      const isLive = url.origin !== other;
      return Promise.resolve(
        Response.json({ models: [{ id: 12, status: isLive ? 'public' : 'off', isLive }] }),
      );
    });
    const { sites, status } = createProvider({ origin, publicOrigins: [origin, other], fetch });
    await expect(status(12)).resolves.toBe('PUBLIC');
    sites.configure(other);
    await expect(status(12)).resolves.toBe('OFFLINE');
    expect(paths).toEqual([`${origin}/api/front/models/list`, `${other}/api/front/models/list`]);
  });
});
