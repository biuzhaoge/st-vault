import { describe, expect, it, vi } from 'vitest';
import { createHttp } from './http.js';

const address = 'https://stripchat.com/api/front/v2/models/42/cam';
const allow = (url: URL): boolean => url.origin === new URL(address).origin;

describe('provider HTTP forbidden responses', () => {
  it('only returns a JSON 403 when the caller opts in', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(Response.json({ description: 'model unavailable' }, { status: 403 })),
    );
    const http = createHttp({ allow, fetch });
    await expect(http.text(address)).rejects.toMatchObject({
      code: 'upstream-http',
      status: 403,
    });
    await expect(http.jsonText(address)).rejects.toMatchObject({
      code: 'upstream-http',
      status: 403,
    });
    await expect(http.jsonText(address, { acceptForbidden: true })).resolves.toEqual({
      status: 403,
      text: '{"description":"model unavailable"}',
    });
  });

  it('distinguishes an HTML access denial from a Cloudflare challenge', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(
        new Response('<html>Sorry, you have been blocked</html>', {
          status: 403,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      ),
    );
    const http = createHttp({ allow, fetch });
    await expect(http.text(address)).rejects.toMatchObject({
      code: 'upstream-http',
      status: 403,
      challenge: false,
    });
    await expect(http.jsonText(address, { acceptForbidden: true })).rejects.toMatchObject({
      code: 'upstream-http',
      status: 403,
      challenge: false,
    });
    fetch.mockResolvedValueOnce(
      Response.json({}, { status: 403, headers: { 'cf-mitigated': 'challenge' } }),
    );
    await expect(http.jsonText(address, { acceptForbidden: true })).rejects.toMatchObject({
      code: 'upstream-http',
      status: 403,
      challenge: true,
    });
  });

  it('bounds streamed forbidden bodies independently of successful bodies', async () => {
    const data = { description: 'a'.repeat(16 * 1024) };
    const fetch = vi
      .fn(() => Promise.resolve(Response.json(data, { status: 403 })))
      .mockResolvedValueOnce(Response.json(data));
    const http = createHttp({ allow, fetch });
    await expect(http.jsonText(address, { acceptForbidden: true })).resolves.toMatchObject({
      status: 200,
    });
    await expect(http.jsonText(address, { acceptForbidden: true })).rejects.toMatchObject({
      code: 'body-too-large',
    });
  });

  it('keeps credentials on the request origin when accepting JSON 403', async () => {
    const fetch = vi.fn(() =>
      Promise.resolve(Response.redirect('https://example.invalid/redirected', 302)),
    );
    const http = createHttp({ allow: () => true, account: true, fetch });
    await expect(
      http.jsonText(address, { cookie: 'session=fixture', acceptForbidden: true }),
    ).rejects.toMatchObject({ code: 'account-redirect-denied' });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
