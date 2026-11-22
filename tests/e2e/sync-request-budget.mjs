import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
try {
  const origin = `http://127.0.0.1:${fixture.info.port}`;
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE,
    channel: process.env.STV_QA_BROWSER_CHANNEL,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  await page.addInitScript(() => {
    window.timelineChanges = 0;
    window.addEventListener('stv-sync', ({ detail }) => {
      if ((Array.isArray(detail) ? detail : detail.topics).includes('timeline'))
        window.timelineChanges++;
    });
  });
  const path = (url) => new URL(url).pathname;
  let deletionReads = 0;
  const batches = [];
  page.on('request', (request) => {
    if (path(request.url()) === '/api/media-deletions') deletionReads++;
    if (path(request.url()) === '/api/workbench')
      batches.push(new URL(request.url()).searchParams.get('ids').split(','));
  });
  const responseFor = (route) =>
    page.waitForResponse((response) => path(response.url()) === route && response.ok());
  const systemRead = () => responseFor('/api/system');
  const refreshSystem = () =>
    page.evaluate(() => window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['system'] })));
  await page.goto(origin);
  const initial = systemRead();
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  assert.deepEqual((await (await initial).json()).deletionJobs, []);
  await page.locator('.track-row').first().waitFor();
  for (let tick = 0; tick < 2; tick++) await systemRead();
  assert.equal(deletionReads, 0, 'the system snapshot covers steady-state deletion reads');

  const offscreen = 'stripchat:299';
  assert(!batches.flat().includes(offscreen), 'the fixture subject must be outside the viewport');
  batches.length = 0;
  const before = await page.evaluate(() => window.timelineChanges);
  await fixture.renewPublicObservation(offscreen);
  await page.waitForFunction((count) => window.timelineChanges > count, before);
  // Allow the 80 ms invalidation batch to drain before sampling the absence of a read.
  await page.waitForTimeout(400);
  assert.deepEqual(batches, [], 'an offscreen renewal leaves the current rows alone');

  const visible = await page.locator('.track-row').first().getAttribute('data-subject-id');
  assert(visible, 'the fixture must have a visible public subject');
  const readRow = responseFor('/api/workbench');
  await fixture.renewPublicObservation(visible);
  const row = await readRow;
  assert.equal(new URL(row.url()).searchParams.get('ids'), visible);
  await page.waitForTimeout(400);
  assert.deepEqual(batches, [[visible]], 'a visible renewal refreshes exactly its own row');

  const missingInventory = async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({ response, json: { ...status, deletionJobs: null } });
  };
  await page.route('**/api/system', missingInventory);
  const fallback = responseFor('/api/media-deletions');
  await refreshSystem();
  assert.deepEqual(await (await fallback).json(), []);
  await page.unroute('**/api/system', missingInventory);
  const restored = systemRead();
  await refreshSystem();
  assert.deepEqual((await (await restored).json()).deletionJobs, []);
  const afterRecovery = deletionReads;
  for (let tick = 0; tick < 2; tick++) await systemRead();
  assert.equal(deletionReads, afterRecovery, 'recovery returns to a single status read');
  console.log('[qa] Shared deletion inventory, fallback and scoped timeline reads passed');
} finally {
  try {
    await browser?.close();
  } finally {
    await fixture.close();
  }
}
