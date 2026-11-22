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
  let latest = 100,
    read = 0;
  const meta = () => ({
    latestCursor: latest,
    oldestCursor: 1,
    readCursor: read,
    unreadCount: latest - read,
    revision: latest,
    retentionDays: 90,
    maxEvents: 10000,
  });
  await page.route('**/api/events/meta', (route) => route.fulfill({ json: meta() }));
  await page.route('**/api/events/read', (route) => {
    read = Math.max(read, route.request().postDataJSON().cursor);
    return route.fulfill({ json: meta() });
  });
  await page.route('**/api/events?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const after = Number(query.get('after')) || 0;
    const before = Number(query.get('before')) || latest + 1;
    const end = Math.min(latest, before - 1);
    const at = Date.now() - 60000;
    const items = Array.from({ length: Math.max(0, end - after) }, (_, offset) => {
      const id = after + offset + 1;
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
      json: { items, nextCursor: end, hasMore: false, cursorExpired: false, meta: meta() },
    });
  });
  await page.goto(origin);
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  const trigger = page.getByRole('button', { name: '历史', exact: true });
  await trigger.click();
  const feed = page.getByRole('log', { name: '历史事件' });
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
  console.log(
    '[qa] History follows the latest entry after resize and reopen, and preserves manual reading position.',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
