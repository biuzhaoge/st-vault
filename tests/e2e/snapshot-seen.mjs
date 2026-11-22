import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
let releaseImages;
const gate = new Promise((resolve) => {
  releaseImages = resolve;
});
try {
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [],
    reports = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.url().endsWith('/unit-seen')) reports.push(request.postDataJSON());
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.route('**/snapshots/*.jpg*', async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  const row = page.locator(`.track-row[data-subject-id="${fixture.info.subjectId}"]`);
  await row.waitFor();
  const peer = await page.context().newPage();
  await peer.goto('http://127.0.0.1:10085');
  const peerRow = peer.locator(`.track-row[data-subject-id="${fixture.info.subjectId}"]`);
  await peerRow.waitFor();
  await page.bringToFront();
  // Timeline hover downloads are deliberately outside screenshot-area evidence.
  const clip = await row.locator('.track-clip').first().boundingBox();
  await page.mouse.move(clip.x + clip.width / 2, clip.y + clip.height / 2);
  await page.waitForTimeout(300);
  assert.equal(reports.length, 0);
  let tailMs = 2000,
    open = true,
    displayedBounds = new Map();
  await page.route('**/snapshot-pages?*', async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    for (const item of json.items) {
      item.open = open;
      item.slotToMs = Math.max(item.slotFromMs + 1, item.slotToMs - tailMs);
    }
    displayedBounds = new Map(json.items.map((item) => [item.unitId, item.slotToMs]));
    await route.fulfill({ response, json });
  });
  // Move the grid outside its clipping viewport while leaving each image within
  // its preload observer's root, as can happen during page movement.
  const clipped = await page.addStyleTag({
    content: '.snapshot-grid { transform: translateY(110%) !important; }',
  });
  await page.getByRole('button', { name: '00 演示直播', exact: true }).click();
  await page.locator('.snapshot-cell').first().waitFor();
  await page.waitForTimeout(300);
  assert.equal(reports.length, 0, 'metadata and pending JPEGs are not seen evidence');
  releaseImages();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.snapshot-cell img')].some(
      (img) => img.complete && img.naturalWidth > 0,
    ),
  );
  await page.waitForTimeout(350);
  assert.equal(reports.length, 0, 'decoded images outside the gallery viewport remain unread');
  const refresh = async () => {
    const refreshed = page.waitForResponse((response) =>
      response.url().includes('/snapshot-pages?'),
    );
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['timeline'] })),
    );
    await refreshed;
  };
  const firstCell = page.locator('.snapshot-cell').first();
  const beforeGrowth = await firstCell.getAttribute('title');
  tailMs = 1000;
  await refresh();
  await page.waitForFunction(
    (title) => document.querySelector('.snapshot-cell')?.getAttribute('title') !== title,
    beforeGrowth,
  );
  assert.equal(reports.length, 0);
  const seenResponse = page.waitForResponse((response) => response.url().endsWith('/unit-seen'));
  await clipped.evaluate((node) => node.remove());
  await seenResponse;
  await page.locator('.viewer-focus .track-clip[data-seen="true"]').waitFor();
  await row.locator('.track-clip[data-seen="true"]').waitFor();
  await peer.bringToFront();
  await peerRow.locator('.track-clip[data-seen="true"]').waitFor();
  await peer.close();
  await page.bringToFront();
  assert(reports.length > 0 && reports.every((r) => r.evidence.length <= 100));
  const original = reports.flatMap((r) => r.evidence);
  for (const item of original)
    assert.equal(item.toMs, displayedBounds.get(item.unitId), 'use the boundary at first display');
  tailMs = 0;
  await refresh();
  await page.waitForTimeout(350);
  open = false;
  await refresh();
  await page.waitForTimeout(500);
  for (const item of original) {
    assert(
      !reports
        .flatMap((r) => r.evidence)
        .some((e) => e.unitId === item.unitId && e.toMs > item.toMs),
      'growth and sealing must not turn the unchanged displayed image into newer evidence',
    );
  }
  await page.unroute('**/snapshot-pages?*');
  await page.waitForFunction(() => !document.querySelector('.snapshot-favorite')?.disabled);
  await page.locator('.snapshot-favorite').first().click();
  await page.locator('.snapshot-favorite[aria-pressed=\"true\" ]').first().waitFor();
  assert.equal(await page.locator('.track-favorite-range').count(), 0);
  assert.equal(
    await page
      .locator('.viewer-focus .track-clip[data-seen="true"]')
      .evaluate((node) => getComputedStyle(node).getPropertyValue('--coverage-tint').trim()),
    '#c4c6cc',
  );
  assert.equal(await page.locator('.recording-line .track-favorite-range').count(), 0);
  await page.reload();
  await page.locator('.viewer-focus .track-clip[data-seen="true"]').waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      decodedGridOnly: true,
      offscreenPrefetchRemainsUnread: true,
      boundarySampledOnDisplay: true,
      growthAndSealRemainUnread: true,
      boundedReporting: true,
      sharedTimelineStyles: true,
      favoritesRemainInGrid: true,
      reloadPersists: true,
    }),
  );
} finally {
  releaseImages();
  await browser?.close();
  await fixture.close();
}
