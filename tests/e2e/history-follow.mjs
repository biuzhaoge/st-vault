import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const origin = `http://127.0.0.1:${fixture.info.port}`;
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  let latest = 0,
    oldest = 1,
    read = 0;
  const received = new Set();
  const skipped = new Set();
  const meta = () => ({
    latestCursor: latest,
    oldestCursor: latest ? oldest : 0,
    readCursor: read,
    unreadCount: latest - Math.max(read, oldest - 1),
    revision: latest,
    retentionDays: 90,
    maxEvents: 10000,
  });
  await page.route('**/api/events/meta', (route) => route.fulfill({ json: meta() }));
  await page.route('**/api/events/read', async (route) => {
    const cursor = route.request().postDataJSON().cursor;
    if (cursor > 101 && cursor < latest) await new Promise((resolve) => setTimeout(resolve, 120));
    for (let id = Math.max(read + 1, oldest); id <= cursor; id++) {
      if (!received.has(id)) skipped.add(id);
    }
    read = Math.max(read, cursor);
    return route.fulfill({ json: meta() });
  });
  const requestedFirstPage = Promise.withResolvers();
  const releaseFirstPage = Promise.withResolvers();
  await page.route('**/api/events?*', async (route) => {
    if (!latest) {
      requestedFirstPage.resolve();
      await releaseFirstPage.promise;
    }
    const query = new URL(route.request().url()).searchParams;
    const after = Number(query.get('after')) || 0;
    const before = Number(query.get('before')) || latest + 1;
    const limit = Number(query.get('limit'));
    const first = Math.max(
      oldest,
      query.has('before') ? Math.min(latest, before - 1) - limit + 1 : after + 1,
    );
    const end = Math.min(latest, before - 1, first + limit - 1);
    const at = Date.now() - 60000;
    const items = Array.from({ length: Math.max(0, end - first + 1) }, (_, offset) => {
      const id = first + offset;
      received.add(id);
      return {
        id,
        kind: 'run_started',
        runId: `run-${id}`,
        atMs: at + id,
        occurredAtMs: at + id,
        startedAtMs: at + id,
        lastHeartbeatAtMs: at + id,
        stoppedAtMs: null,
        uncertainUntilMs: null,
      };
    });
    return route.fulfill({
      json: {
        items,
        nextCursor: query.has('before') ? first : end,
        hasMore: query.has('before') ? first > oldest : end < latest,
        cursorExpired: !query.has('before') && after > 0 && after < oldest - 1,
        meta: meta(),
      },
    });
  });
  await page.goto(origin);
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  const trigger = page.getByRole('button', { name: '历史', exact: true });
  await trigger.click();
  const feed = page.getByRole('log', { name: '历史事件' });
  await requestedFirstPage.promise;
  try {
    assert.equal(
      await feed.getByText('暂无历史事件', { exact: true }).count(),
      0,
      'A pending first page cannot establish that history is empty',
    );
    assert.equal(await feed.getAttribute('aria-busy'), 'true', 'First history page is pending');
  } finally {
    releaseFirstPage.resolve();
  }
  await feed.getByText('暂无历史事件', { exact: true }).waitFor();
  assert.equal(await feed.getAttribute('aria-busy'), 'false');
  latest = 100;
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['events'] })),
  );
  const waitAtBottom = () =>
    page.waitForFunction(
      () => {
        const element = document.querySelector('.toolbar-popover[data-state="open"] .event-feed');
        return (
          element &&
          element.scrollTop > 0 &&
          element.scrollHeight - element.clientHeight - element.scrollTop <= 1
        );
      },
      null,
      { timeout: 4500 },
    );
  await waitAtBottom();
  await feed.evaluate((element) => element.style.setProperty('max-height', '130px'));
  await waitAtBottom();

  const scrollUp = () =>
    feed.evaluate(
      (element) =>
        new Promise((resolve) => {
          element.addEventListener('scroll', () => resolve(element.scrollTop), { once: true });
          element.scrollTop -= 160;
        }),
    );
  const readingPosition = () =>
    feed.evaluate((element) => {
      const top = element.getBoundingClientRect().top;
      const row = [...element.querySelectorAll('[data-event-id]')].find(
        (item) => item.getBoundingClientRect().bottom > top + 1,
      );
      return { id: row.dataset.eventId, offset: Math.round(row.getBoundingClientRect().top - top) };
    });
  await scrollUp();
  const position = await readingPosition();
  latest++;
  const appended = page.waitForResponse((response) =>
    response.url().includes('/api/events?after=100'),
  );
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['events'] })),
  );
  await appended;
  await feed.locator('[data-event-id="101"]').waitFor({ state: 'attached' });
  assert.deepEqual(await readingPosition(), position);
  await trigger.evaluate((element) => element.click());
  await page.locator('.toolbar-popover[data-state="closing"]').waitFor({ state: 'attached' });
  await trigger.evaluate((element) => element.click());
  await waitAtBottom();
  latest += 250;
  const catchUp = async () => {
    const caughtUp = page.waitForResponse(
      (r) => r.url().endsWith('/api/events/read') && r.request().postDataJSON().cursor === latest,
    );
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['events'] })),
    );
    await caughtUp;
  };
  await catchUp();
  assert.deepEqual([...skipped], [], 'Read acknowledgements must follow continuous pages');
  assert.equal(received.size, latest);
  const displayed = () =>
    feed.evaluate(async (element) => {
      const ids = new Set();
      const bottom = element.scrollHeight - element.clientHeight;
      for (let top = bottom; top > -element.clientHeight; top -= element.clientHeight) {
        element.scrollTop = Math.max(0, top);
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        for (const row of element.querySelectorAll('[data-event-id]'))
          ids.add(Number(row.dataset.eventId));
      }
      return [...ids].sort((a, b) => a - b);
    });
  const toBottom = async () => {
    await feed.evaluate(
      (element) =>
        new Promise((done) => {
          if (element.scrollHeight - element.scrollTop - element.clientHeight < 1) {
            requestAnimationFrame(done);
            return;
          }
          element.addEventListener('scroll', () => requestAnimationFrame(done), { once: true });
          element.scrollTop = element.scrollHeight;
        }),
    );
    await waitAtBottom();
  };
  assert.deepEqual(
    await displayed(),
    Array.from({ length: latest }, (_, index) => index + 1),
  );
  await toBottom();
  oldest = 700;
  latest = 850;
  await catchUp();
  assert.deepEqual(
    await displayed(),
    Array.from({ length: 151 }, (_, index) => index + oldest),
  );
  assert.deepEqual([...skipped], []);
  await toBottom();
  latest = 1400;
  await catchUp();
  for (const first of [901, 801, 701]) {
    const olderPage = page.waitForResponse((r) =>
      r.url().includes('/api/events?before=' + first + '&limit=100'),
    );
    await feed.evaluate((element) => {
      element.scrollTop = 0;
    });
    await olderPage;
    if (first > oldest + 1)
      await page.waitForFunction(() => document.querySelector('.event-feed').scrollTop > 0);
  }
  await feed.evaluate((element) => {
    element.scrollTop = 0;
  });
  await feed.locator('[data-event-id="700"]').waitFor({ state: 'attached' });
  await toBottom();
  await feed.locator('[data-event-id="1400"]').waitFor({ state: 'attached' });
  assert.deepEqual([...skipped], []);
  console.log(
    '[qa] History follows on resize and reopen, preserves manual position, and pages every retained event across a burst and an expired cursor.',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
