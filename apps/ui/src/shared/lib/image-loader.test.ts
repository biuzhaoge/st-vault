import { afterEach, expect, it, vi } from 'vitest';
import { ImageLoader } from './image-loader';
import { ImageAdmission } from './image-admission';
const image = () => new Response(new Blob(['image'], { type: 'image/jpeg' }));
it('releases a pending-image slot and reports its retry delay without blocking ready images', async () => {
  const request = vi.fn((input) =>
    Promise.resolve(
      String(input) === '/pending'
        ? new Response(null, { status: 202, headers: { 'retry-after': '3' } })
        : image(),
    ),
  );
  const loader = new ImageLoader({ concurrency: 1, fetch: request });
  const pending = loader.load('/pending');
  const ready = loader.load('/ready');
  await expect(pending).rejects.toMatchObject({ retryAfterMs: 3000 });
  expect((await ready).size).toBeGreaterThan(0);
  expect(await loader.load('/ready')).toBe(await ready);
  expect(request).toHaveBeenCalledTimes(2);
});
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

it('keeps a foreground slot available and promotes a waiting cover without starting a duplicate', async () => {
  const releases = new Map<string, () => void>();
  const fetch = vi.fn(async (url) => {
    await new Promise<void>((resolve) => releases.set(String(url), resolve));
    return image();
  });
  const loader = new ImageLoader({ admission: new ImageAdmission(2, 1), fetch });
  const first = loader.load('/first', undefined, 'prefetch');
  const second = loader.load('/second', undefined, 'prefetch');
  try {
    await tick();
    expect([...releases.keys()]).toEqual(['/first']);
    const promoted = loader.load('/second', undefined, 'visible');
    await tick();
    expect([...releases.keys()]).toEqual(['/first', '/second']);
    releases.get('/second')!();
    expect(await second).toBe(await promoted);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    for (const release of releases.values()) release();
    loader.clear();
    await Promise.allSettled([first, second]);
  }
});
it('uses the local cache for preloads and promotes a cache miss without making the visible row wait', async () => {
  let complete!: (response: Response) => void;
  const fetch = vi.fn((url: RequestInfo | URL) =>
    (url instanceof Request ? url.url : url.toString()).endsWith('?cached=1')
      ? new Promise<Response>((resolve) => {
          complete = resolve;
        })
      : Promise.resolve(image()),
  );
  const loader = new ImageLoader({ fetch, prefetchUrl: (url) => `${url}?cached=1` });
  const preload = loader.load('/cover', undefined, 'prefetch');
  await tick();
  const foreground = loader.load('/cover', undefined, 'visible');
  try {
    complete(new Response(null, { status: 204 }));
    expect(await foreground).toBe(await preload);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/cover?cached=1', '/cover']);
  } finally {
    loader.clear();
  }
});
it('puts pointer previews ahead of queued grid images without duplicating requests', async () => {
  const gates: (() => void)[] = [],
    calls: string[] = [];
  const loader = new ImageLoader({
    concurrency: 1,
    fetch: vi.fn(async (input) => {
      calls.push(String(input));
      await new Promise<void>((resolve) => gates.push(resolve));
      return image();
    }),
  });
  const first = loader.load('/first'),
    visible = loader.load('/grid'),
    urgent = loader.load('/hover', undefined, 'interactive');
  try {
    await tick();
    gates.shift()!();
    await first;
    await tick();
    expect(calls).toEqual(['/first', '/hover']);
    gates.shift()!();
    await urgent;
    await tick();
    gates.shift()!();
    await visible;
  } finally {
    loader.clear();
    for (const release of gates) release();
    await Promise.allSettled([first, visible, urgent]);
  }
});
afterEach(() => vi.restoreAllMocks());
it('revalidates expired covers by ETag and reuses the same decoded blob on 304', async () => {
  let now = 1000;
  const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
    if (new Headers(init?.headers).get('if-none-match') === '"cover-version"')
      return Promise.resolve(
        new Response(null, {
          status: 304,
          headers: { etag: '"cover-version"' },
        }),
      );
    return Promise.resolve(
      new Response(new Blob(['image'], { type: 'image/jpeg' }), {
        headers: { etag: '"cover-version"' },
      }),
    );
  });
  const loader = new ImageLoader({ fetch, now: () => now });
  const first = await loader.load('/cover');
  now += 30001;
  expect(await loader.load('/cover')).toBe(first);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await loader.load('/cover')).toBe(first);
  expect(fetch).toHaveBeenCalledTimes(2);
  loader.clear();
});
it('prioritizes visible rows over queued preloads and shares requests for the same image', async () => {
  const gates: (() => void)[] = [],
    calls: string[] = [];
  const loader = new ImageLoader({
    concurrency: 1,
    fetch: vi.fn(async (input) => {
      calls.push(String(input));
      await new Promise<void>((resolve) => gates.push(resolve));
      return image();
    }),
  });
  const first = loader.load('/first'),
    preload = loader.load('/preload', undefined, 'prefetch'),
    visible = loader.load('/visible'),
    duplicate = loader.load('/visible');
  await tick();
  expect(calls).toEqual(['/first']);
  gates.shift()!();
  await first;
  await tick();
  expect(calls).toEqual(['/first', '/visible']);
  gates.shift()!();
  expect(await visible).toBe(await duplicate);
  await tick();
  gates.shift()!();
  await preload;
  loader.clear();
});
it('uses fresh cached blobs without refetch and bounds cache size and bytes', async () => {
  let now = 1000;
  const fetch = vi.fn(() => Promise.resolve(image())),
    loader = new ImageLoader({
      fetch,
      now: () => now,
      maxEntries: 2,
      maxBytes: 12,
    });
  const blob = await loader.load('/a');
  expect(await loader.load('/a')).toBe(blob);
  expect(fetch).toHaveBeenCalledTimes(1);
  await loader.load('/b');
  expect(loader.peek('/a')).toBe(blob);
  await loader.load('/c');
  expect(loader.peek('/b')).toBeNull();
  now += 30001;
  await loader.load('/a');
  expect(fetch).toHaveBeenCalledTimes(4);
  loader.clear();
  expect(loader.peek('/b')).toBeNull();
});
it('removes cancelled preloads without aborting another visible consumer', async () => {
  const gates: (() => void)[] = [],
    calls: string[] = [],
    loader = new ImageLoader({
      concurrency: 1,
      fetch: vi.fn(async (input) => {
        calls.push(String(input));
        await new Promise<void>((resolve) => gates.push(resolve));
        return image();
      }),
    });
  const first = loader.load('/first'),
    cancel = new AbortController(),
    gone = loader.load('/gone', cancel.signal, 'prefetch'),
    sharedCancel = new AbortController(),
    one = loader.load('/shared', sharedCancel.signal),
    two = loader.load('/shared');
  const goneResult = expect(gone).rejects.toMatchObject({ name: 'AbortError' }),
    oneResult = expect(one).rejects.toMatchObject({ name: 'AbortError' });
  cancel.abort();
  sharedCancel.abort();
  await goneResult;
  await oneResult;
  await tick();
  gates.shift()!();
  await first;
  await tick();
  expect(calls).toEqual(['/first', '/shared']);
  gates.shift()!();
  await two;
  loader.clear();
});
it('rejects invalid images and does not cache failures', async () => {
  const fetch = vi.fn(() =>
      Promise.resolve(new Response('html', { headers: { 'content-type': 'text/html' } })),
    ),
    loader = new ImageLoader({ fetch });
  await expect(loader.load('/bad')).rejects.toThrow('image-format');
  expect(loader.peek('/bad')).toBeNull();
  loader.clear();
});
