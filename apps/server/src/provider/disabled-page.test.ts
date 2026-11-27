import { describe, expect, it, vi } from 'vitest';
import { createDisabledPageProbe, createRoomAccessProbe } from './disabled-page.js';

const site = 'https://stripchat.com';
const room = 'Fixture_Model';
const html = (body: string, status = 404) =>
  new Response(`<html lang="zh"><body>${body}</body></html>`, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
const notice = (username = room, copy = `${username}的账户已被禁用。`) =>
  `<div class="deleted-wrapper"><svg class="icon icon-account-disabled"><use href="#i"/></svg>
    <div class="account-disabled-header">账户被禁用</div>
    <div class="account-disabled-description">${copy}</div></div>`;
const roomMarkup = '<div class="view-cam-page"><div class="view-cam-container"></div></div>';
const regularRoom = (canonical = `${site}/${room}`, body = roomMarkup, status = 200) =>
  new Response(
    `<html><head><link rel="canonical" href="${canonical}"></head><body>${body}</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );

const serverRoomState = (viewCam: unknown) =>
  `<script>window.__PRELOADED_STATE__ = ${JSON.stringify({ viewCam })};</script>`;

describe('the public room access evidence', () => {
  const available = { model: { id: 42, username: room }, playerIsAvailable: true };
  const access = (response: Response) =>
    createRoomAccessProbe(site, vi.fn<typeof globalThis.fetch>().mockResolvedValue(response));

  it('accepts same-ID server room state in an ordinary public room', async () => {
    await expect(
      access(regularRoom(undefined, `${roomMarkup}${serverRoomState(available)}`))(room, 42),
    ).resolves.toBe(true);
  });

  it.each([
    { ...available, model: { id: 43, username: room } },
    { ...available, model: { id: 42, username: 'Other_Model' } },
    { ...available, playerIsAvailable: false },
    { ...available, playerIsAvailable: 'true' },
    { ...available, isGeoBanned: true },
    { ...available, model: { ...available.model, isGeoRestricted: true } },
  ])('requires exact identity and affirmative player availability', async (state) => {
    await expect(
      access(regularRoom(undefined, `${roomMarkup}${serverRoomState(state)}`))(room, 42),
    ).resolves.toBe(false);
  });

  it('rejects a shell, inert state or conflicting room structure', async () => {
    for (const response of [
      regularRoom(),
      regularRoom(undefined, `${roomMarkup}<template>${serverRoomState(available)}</template>`),
      regularRoom(undefined, `${roomMarkup}${notice()}${serverRoomState(available)}`),
      regularRoom(`${site}/Other_Model`, `${roomMarkup}${serverRoomState(available)}`),
      regularRoom(undefined, `${roomMarkup}${serverRoomState(available)}`, 404),
    ]) {
      await expect(access(response)(room, 42)).resolves.toBe(false);
    }
  });

  it('does not infer room access from the site-wide age verification state', async () => {
    for (const [viewCam, isGeoRestricted] of [
      [{ model: available.model }, false],
      [available, true],
    ] as const) {
      const state = { viewCam, configV3: { dynamic: { ageVerification: { isGeoRestricted } } } };
      const body = `${roomMarkup}<script>window.__PRELOADED_STATE__ = ${JSON.stringify(state)};</script>`;
      await expect(access(regularRoom(undefined, body))(room, 42)).resolves.toBe(false);
    }
  });

  it('treats non-JSON and duplicate bootstrap assignments as inconclusive', async () => {
    for (const body of [
      `${serverRoomState(available)}${serverRoomState(available)}`,
      '<script>window.__PRELOADED_STATE__ = makeState();</script>',
      serverRoomState(available).replace('</script>', 'void 0;</script>'),
    ]) {
      await expect(access(regularRoom(undefined, roomMarkup + body))(room, 42)).resolves.toBe(
        false,
      );
    }
  });
});

describe('the public room disabled notice', () => {
  it('recognizes the visible notice and checks the exact account named there', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch.mockResolvedValueOnce(
      html(notice(room, `<strong>${room}</strong> 的账户已被禁用&#12290;`)),
    );
    fetch.mockResolvedValueOnce(html(notice('Other_Model')));
    fetch.mockResolvedValueOnce(html(notice(room, `${room}的账户目前无法访问。`)));
    const probe = createDisabledPageProbe(site, fetch);
    await expect(probe(room)).resolves.toBe(true);
    await expect(probe(room)).resolves.toBeUndefined();
    await expect(probe(room)).resolves.toBeUndefined();
  });

  it('recognizes the reviewed English notice only for the room it names', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch.mockResolvedValueOnce(
      html(
        notice(room, `${room}&#x27;s account has been disabled.`).replace(
          '账户被禁用',
          'Account Disabled',
        ),
      ),
    );
    fetch.mockResolvedValueOnce(
      html(
        notice(room, 'Other_Model&#x27;s account has been disabled.').replace(
          '账户被禁用',
          'Account Disabled',
        ),
      ),
    );
    const probe = createDisabledPageProbe(site, fetch);
    await expect(probe(room)).resolves.toBe(true);
    await expect(probe(room)).resolves.toBeUndefined();
  });

  it.each([
    '<main>账户已被禁用。页面不存在。</main>',
    `<script type="application/json">${notice()}</script>`,
    `<div><script type="application/json">"</div>${notice()}"</script></div>`,
    `<!-- ${notice()} -->`,
    `<template>${notice()}</template>`,
    `<div hidden>${notice()}</div>`,
    `<div aria-hidden="true">${notice()}</div>`,
    `<div style="visibility: hidden;">${notice()}</div>`,
    `<nav>${notice()}</nav>`,
    notice().replace('deleted-wrapper', 'elsewhere'),
    notice().replace(
      'class="account-disabled-description"',
      'class="account-disabled-description" hidden',
    ),
  ])('rejects generic errors, hidden or unrelated copies of the message', async (body) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(html(body));
    await expect(createDisabledPageProbe(site, fetch)(room)).resolves.toBeUndefined();
  });

  it('keeps an unrelated 200 page inconclusive', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(html('<main>Home</main>', 200));
    await expect(createDisabledPageProbe(site, fetch)(room)).resolves.toBeUndefined();
  });

  it('confirms an ordinary 200 room with a visible cam and a same-room canonical link', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(regularRoom());
    await expect(createDisabledPageProbe('https://stripchat.mov', fetch)(room)).resolves.toBe(
      false,
    );
  });

  it('keeps conflicting identity or page structure inconclusive', async () => {
    const responses = [
      regularRoom(`${site}/Other_Model`),
      regularRoom(`https://invalid.example/${room}`),
      regularRoom(undefined, `<template>${roomMarkup}</template>`),
      regularRoom(undefined, undefined, 404),
      regularRoom(undefined, `${roomMarkup}${notice()}`),
      regularRoom(undefined, `${roomMarkup}${notice('Other_Model')}`),
      html(roomMarkup, 200),
    ];
    const fetch = vi.fn<typeof globalThis.fetch>();
    const probe = createDisabledPageProbe(site, fetch);
    for (const response of responses) {
      fetch.mockResolvedValueOnce(response);
      await expect(probe(room)).resolves.toBeUndefined();
    }
  });

  it('follows the reviewed Chinese locale redirect for the same room without credentials', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.redirect(`https://zh.stripchat.mov/${room.toLowerCase()}`, 302),
      )
      .mockResolvedValueOnce(html(notice()));
    await expect(createDisabledPageProbe(site, fetch)(room)).resolves.toBe(true);
    expect(fetch.mock.calls.map(([address]) => address)).toEqual([
      `${site}/${room}`,
      `https://zh.stripchat.mov/${room.toLowerCase()}`,
    ]);
    for (const [, request] of fetch.mock.calls) {
      const headers = new Headers(request?.headers);
      expect(request).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'manual' });
      expect(headers.get('accept')).toBe('text/html');
      expect(headers.has('cookie')).toBe(false);
      expect(headers.has('authorization')).toBe(false);
    }
  });

  it('reads the reviewed public Chinese room when the bound host is stripchat.mov', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(html(notice()));
    await expect(createDisabledPageProbe('https://stripchat.mov', fetch)(room)).resolves.toBe(true);
    expect(fetch.mock.calls.map(([address]) => address)).toEqual([
      `https://zh.stripchat.mov/${room}`,
    ]);
    expect(new Headers(fetch.mock.calls[0][1]?.headers).has('cookie')).toBe(false);
  });

  it.each([
    'https://invalid.example/Fixture_Model',
    'https://zh.stripchat.mov/Other_Model',
    'https://zh.stripchat.mov/Fixture_Model?goto=Other_Model',
    'https://zh.stripchat.mov:8443/Fixture_Model',
    'http://zh.stripchat.mov/Fixture_Model',
  ])('rejects an unexpected room redirect to %s', async (target) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.redirect(target, 302));
    await expect(createDisabledPageProbe(site, fetch)(room)).rejects.toMatchObject({
      code: 'upstream-url-denied',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a custom provider on its own same-room origin', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(html(notice()))
      .mockResolvedValueOnce(Response.redirect(`https://zh.stripchat.mov/${room}`, 302));
    const custom = 'https://site.invalid';
    const probe = createDisabledPageProbe(custom, fetch);
    await expect(probe(room)).resolves.toBe(true);
    await expect(probe(room)).rejects.toMatchObject({ code: 'upstream-url-denied' });
    expect(fetch.mock.calls.map(([address]) => address)).toEqual([
      `${custom}/${room}`,
      `${custom}/${room}`,
    ]);
    expect(() => createDisabledPageProbe(`${custom}/different-room`, fetch)).toThrow(
      'invalid-room-origin',
    );
  });

  it('preserves timeouts and upstream errors instead of treating them as observations', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    fetch.mockResolvedValueOnce(html(notice(), 403));
    fetch.mockResolvedValueOnce(
      new Response(notice(), {
        status: 404,
        headers: { 'cf-mitigated': 'challenge', 'content-type': 'text/html' },
      }),
    );
    fetch.mockResolvedValueOnce(new Response(notice(), { status: 200 }));
    fetch.mockResolvedValueOnce(
      new Response(notice(), {
        status: 404,
        headers: { 'content-type': 'text/html', 'content-length': '3000000' },
      }),
    );
    fetch.mockImplementationOnce(() => new Promise<Response>(() => undefined));
    const probe = createDisabledPageProbe(site, fetch, 100);
    await expect(probe(room)).rejects.toMatchObject({ code: 'upstream-http', status: 403 });
    await expect(probe(room)).rejects.toMatchObject({ code: 'upstream-http', challenge: true });
    await expect(probe(room)).rejects.toMatchObject({ code: 'invalid-html-content-type' });
    await expect(probe(room)).rejects.toMatchObject({ code: 'body-too-large' });
    await expect(probe(room)).rejects.toMatchObject({ code: 'request-deadline' });
  });

  it('never turns a placeholder or a path fragment into a request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const probe = createDisabledPageProbe(site, fetch);
    await expect(probe('主播 #23')).rejects.toMatchObject({ code: 'invalid-room-handle' });
    await expect(probe('../Fixture_Model')).rejects.toMatchObject({ code: 'invalid-room-handle' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
