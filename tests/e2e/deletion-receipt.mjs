import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';
import { dragRecordedTimeline, showRecordedTimeline } from './support/recorded-timeline.mjs';

const fixture = await startFixture({ archiveBeforeMidnight: true });
let browser;
try {
  const base = 'http://127.0.0.1:' + fixture.info.port;
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(10000);
  await page.goto(base);
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  const row = page.locator(`.track-row[data-subject-id="${fixture.info.subjectId}"]`);
  const lane = await showRecordedTimeline(page, row, fixture.info);
  const select = () => dragRecordedTimeline(page, lane);
  await select();
  const cards = page.locator('.snapshot-grid button[data-unit-index][data-favorite-ready="true"]');
  await cards.first().waitFor();
  const original = await page.locator('.snapshot-cell').count();
  assert(original > 0);
  const commandIds = [];
  let deliver = false;
  let available = true;
  let maskInventory = true;
  let lastSubmission;
  let holdSystem;
  let readbacks = 0;
  await page.route('**/deletion-intents', async (route) => {
    lastSubmission = { url: route.request().url(), data: route.request().postDataJSON() };
    commandIds.push(lastSubmission.data.commandId);
    if (deliver) assert.equal((await route.fetch()).status(), 202);
    await route.abort('internetdisconnected');
  });
  await page.route('**/api/media-deletions/*', async (route) => {
    readbacks++;
    if (!available) return route.fulfill({ status: 503, json: { error: 'archive_unavailable' } });
    if (!deliver) return route.continue();
    // The bounded inventory omits this ID. Return the actual retained terminal receipt.
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const response = await route.fetch();
      const job = await response.json();
      if (job.state === 'completed') return route.fulfill({ response });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw Error('Synthetic deletion did not reach its terminal receipt');
  });
  await page.route('**/api/system', async (route) => {
    const response = await route.fetch();
    const system = await response.json();
    if (holdSystem) {
      const hold = holdSystem;
      holdSystem = undefined;
      hold.captured();
      await hold.released;
    }
    // Simulate a recent-job inventory from before admission, or after terminal pruning.
    return route.fulfill({
      json: { ...system, deletionJobs: maskInventory ? [] : system.deletionJobs },
    });
  });
  const sync = () =>
    page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['system', 'timeline'] })),
    );
  const confirm = async () => {
    await page.getByRole('button', { name: '删除所有非喜欢', exact: true }).click();
    const readback = page.waitForResponse(
      (r) => r.url() === base + '/api/media-deletions/' + commandIds.at(-1),
    );
    await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
    return readback;
  };
  const restored = async () => {
    await cards.first().waitFor();
    assert.equal(await page.locator('.snapshot-cell').count(), original);
    assert((await row.locator('.track-clip').count()) > 0);
  };
  // No request reached the server. A successful receipt lookup restores the fixed selection.
  const absent = await confirm();
  assert.equal(absent.status(), 404);
  assert.equal((await absent.json()).error, 'media_deletion_not_found');
  await restored();
  assert.deepEqual(commandIds, [commandIds[0], commandIds[0]]);
  // While verification is unavailable the server has not promised to retry this command.
  available = false;
  let release;
  const captured = new Promise((captured) => {
    holdSystem = {
      captured,
      released: new Promise((resolve) => {
        release = resolve;
      }),
    };
  });
  await sync();
  await captured;
  assert.equal((await confirm()).status(), 503);
  await page
    .getByText(/操作结果尚未确认/)
    .first()
    .waitFor();
  const stale = page.waitForResponse((r) => r.url() === base + '/api/system');
  release();
  await stale;
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );
  assert.equal(
    await cards.count(),
    0,
    'The held pre-admission snapshot cannot disprove acceptance',
  );
  await page.getByRole('button', { name: '状态', exact: true }).click();
  assert.equal(await page.getByText(/后台暂不可用，将自动继续/).count(), 0);
  await page.keyboard.press('Escape');
  available = true;
  await sync();
  await restored();
  assert.equal(commandIds[2], commandIds[3]);
  // Both POST responses are lost after real admission. One existing job retains ownership.
  deliver = true;
  const receipt = await (await confirm()).json();
  assert.equal(commandIds.length, 6);
  assert.equal(new Set(commandIds).size, 3);
  assert.equal(commandIds[4], commandIds[5]);
  assert.equal(receipt.id, commandIds[4]);
  assert.equal(receipt.state, 'completed');
  await sync();
  assert.equal(await page.locator('.snapshot-cell').count(), 0);
  assert(readbacks >= 3);

  // A POST can reach the server after the lookup's 404. Its later inventory receipt
  // must still retire the restored media, without sending a fresh client command.
  await fixture.appendSnapshotUnit(fixture.info.archiveStart - 60000);
  await sync();
  await select();
  await cards.first().waitFor();
  deliver = false;
  assert.equal((await confirm()).status(), 404);
  await cards.first().waitFor();
  const late = await page.request.post(lastSubmission.url, {
    headers: { origin: base },
    data: lastSubmission.data,
  });
  assert.equal(late.status(), 202);
  maskInventory = false;
  await sync();
  await page.locator('.snapshot-cell').first().waitFor({ state: 'detached' });
  assert.equal(commandIds.length, 8);
  console.log(
    '[qa] Missing, unavailable, terminal and late-accepted deletion receipts reconciled; stale inventory ignored',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
