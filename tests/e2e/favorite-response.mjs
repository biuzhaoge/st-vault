import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
let release;
let releaseInitialRead;
let arrived;
const nextWrite = () => new Promise((resolve) => (arrived = resolve));
try {
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page.getByRole('button', { name: '00 演示直播', exact: true }).click();
  const card = page
    .locator('.snapshot-grid button[data-unit-index][data-favorite-ready="true"]')
    .first();
  const nextCard = page
    .locator('.snapshot-grid button[data-unit-index][data-favorite-ready="true"]')
    .nth(1);
  await page.waitForFunction(() => {
    const button = document.querySelector('.snapshot-grid button[data-unit-index][data-liked]');
    return button?.dataset.favoriteReady === 'true';
  });
  assert.equal(await card.getAttribute('data-liked'), 'false');
  let reads = 0;
  let writes = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/unit-favorites/query')) reads++;
  });
  let reject = false;
  await page.route('**/unit-favorites', async (route) => {
    writes++;
    await new Promise((resolve) => {
      release = resolve;
      arrived();
    });
    if (reject) await route.fulfill({ status: 409, json: { error: 'media_selection_stale' } });
    else await route.continue();
  });
  const waitVisual = (liked, busy) =>
    page.waitForFunction(
      ({ liked, busy }) => {
        const button = document.querySelector('.snapshot-grid button[data-unit-index][data-liked]');
        return (
          button?.getAttribute('data-liked') === String(liked) &&
          (button.getAttribute('aria-busy') === 'true') === busy &&
          (busy || (!button.disabled && button.dataset.favoriteReady === 'true'))
        );
      },
      { liked, busy },
    );
  const noOverlay = async () => assert.equal(await page.locator('.snapshot-feedback').count(), 0);
  const firstWrite = nextWrite();
  await card.dblclick();
  await waitVisual(true, true);
  await firstWrite;
  await page.waitForFunction(
    () => document.querySelector('.snapshot-pages')?.getAttribute('aria-busy') === 'true',
  );
  assert.equal(reads, 0, 'known page facts must skip the preparatory query');
  assert.equal(await nextCard.isEnabled(), true, 'another card must remain clickable');
  await nextCard.dblclick();
  assert.equal(await nextCard.getAttribute('data-liked'), 'true');
  assert.equal(await nextCard.getAttribute('aria-busy'), 'true');
  assert.equal(writes, 1, 'queued writes must wait for the committed revision');
  await noOverlay();
  const committed = page.waitForResponse(
    (response) => response.url().endsWith('/unit-favorites') && response.ok(),
  );
  const queuedWrite = nextWrite();
  release();
  await committed;
  await waitVisual(true, false);
  await queuedWrite;
  const queuedCommitted = page.waitForResponse(
    (response) => response.url().endsWith('/unit-favorites') && response.ok(),
  );
  release();
  await queuedCommitted;
  await page.waitForFunction(
    () =>
      document
        .querySelectorAll('.snapshot-grid button[data-unit-index][data-liked]')[1]
        ?.getAttribute('aria-busy') !== 'true',
  );
  assert.equal(await nextCard.getAttribute('data-liked'), 'true');

  // A rejected optimistic unlike returns to the persisted card without replaying a write.
  reject = true;
  const secondWrite = nextWrite();
  await card.dblclick();
  await waitVisual(false, true);
  await secondWrite;
  release();
  await waitVisual(true, false);
  const notice = page.locator('.snapshot-pages .snapshot-operation-status');
  await notice.waitFor();
  assert.equal(await notice.locator('[title]').count(), 0);
  const [statusBox, gridBox] = await Promise.all([
    notice.boundingBox(),
    page.locator('.snapshot-viewport').boundingBox(),
  ]);
  assert.ok(statusBox.y + statusBox.height <= gridBox.y + 1, 'status belongs above images');
  assert.equal(writes, 3, 'a stale write must not be retried automatically');
  await noOverlay();

  reject = false;
  const thirdWrite = nextWrite();
  await card.dblclick();
  await waitVisual(false, true);
  await thirdWrite;
  release();
  await waitVisual(false, false);
  assert.equal(await page.locator('.snapshot-operation-status').count(), 0, 'no success notice');
  await page.reload();
  await waitVisual(false, false);
  await noOverlay();
  const previouslyLiked = await nextCard.getAttribute('data-key');
  assert.equal(await nextCard.getAttribute('data-liked'), 'true');
  await page.unroute('**/unit-favorites');
  const held = new Promise((resolve) => {
    releaseInitialRead = resolve;
  });
  let initialSeen,
    holding = true;
  const seen = new Promise((resolve) => {
    initialSeen = resolve;
  });
  const exactReads = [],
    unknownWrites = [],
    playbacks = [];
  await page.route('**/unit-favorites/query', async (route) => {
    const { unitIds } = route.request().postDataJSON();
    if (unitIds.length === 1) exactReads.push(unitIds[0]);
    if (holding && unitIds.length > 1) {
      holding = false;
      const original = await route.fetch();
      initialSeen();
      await held;
      await route.fulfill({ response: original });
    } else await route.continue();
  });
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/unit-favorites')) unknownWrites.push(request.postDataJSON());
    if (new URL(request.url()).pathname === '/api/playback') playbacks.push(request.postDataJSON());
  });
  await page.reload();
  await seen;
  const unknown = page.locator(`.snapshot-grid button[data-key="${previouslyLiked}"]`);
  await unknown.waitFor();
  assert.equal(await unknown.getAttribute('data-favorite-ready'), 'false');
  const beforePlayback = playbacks.length;
  const committedUnknown = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/unit-favorites'),
    { timeout: 4_000 },
  );
  const [reply] = await Promise.all([committedUnknown, unknown.dblclick()]).catch((cause) => {
    throw Error('A double click while the page favorite query is held must toggle the exact unit', {
      cause,
    });
  });
  assert.equal(reply.status(), 200);
  assert.deepEqual(exactReads, [previouslyLiked]);
  assert.equal(unknownWrites.length, 1);
  assert.deepEqual(unknownWrites[0].unitIds, [previouslyLiked]);
  assert.equal(unknownWrites[0].liked, false, 'The real saved favorite was already on');
  releaseInitialRead();
  await page.waitForFunction((id) => {
    const card = document.querySelector(`.snapshot-grid button[data-key="${id}"]`);
    return (
      card?.dataset.favoriteReady === 'true' &&
      card.dataset.liked === 'false' &&
      card.getAttribute('aria-busy') !== 'true'
    );
  }, previouslyLiked);
  assert.equal(playbacks.length, beforePlayback);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      immediateCard: true,
      rapidDifferentCards: true,
      redundantRead: false,
      rollback: true,
      persisted: true,
      unknownInitialFavoriteSafelyToggled: true,
      overlay: false,
    }),
  );
} finally {
  releaseInitialRead?.();
  release?.();
  await browser?.close();
  await fixture.close();
}
