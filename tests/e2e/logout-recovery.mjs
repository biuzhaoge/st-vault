import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
try {
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE,
    headless: true,
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/session', (route) => route.abort('connectionfailed'));
  await page.goto('http://127.0.0.1:10085');
  const pin = page.getByLabel('6 位 PIN', { exact: true });
  const reconnect = page.getByRole('button', { name: '重新连接', exact: true });
  await reconnect.waitFor({ timeout: 6000 });
  assert.equal(await pin.count(), 0);
  const openedAt = await page.evaluate(() => performance.timeOrigin);
  await page.unroute('**/api/session');
  await reconnect.click();
  await pin.waitFor();
  assert.equal(await page.evaluate(() => performance.timeOrigin), openedAt);
  const logout = page.getByRole('button', { name: '退出', exact: true });
  const retry = page.getByRole('button', { name: '重试退出', exact: true });
  const isAuthenticated = () =>
    page.evaluate(async () => (await (await fetch('/api/session')).json()).authenticated);
  await pin.fill('012345');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await logout.waitFor();
  await page.route('**/api/logout', (route) => route.abort('connectionfailed'));
  await logout.click();
  await retry.waitFor({ timeout: 5000 });
  assert.equal(await isAuthenticated(), true);
  assert.equal(await logout.count(), 0);
  await page.reload();
  await retry.waitFor();
  assert.equal(await reconnect.count(), 0);
  assert.equal(await pin.count(), 0);
  // An unavailable session read also leaves the workspace locked until a retry.
  await page.route('**/api/session', (route) => route.abort('connectionfailed'));
  await retry.click();
  await retry.waitFor();
  assert.equal(await logout.count(), 0);
  await page.unroute('**/api/session');
  await page.unroute('**/api/logout');
  await retry.click();
  await pin.waitFor();
  assert.equal(await isAuthenticated(), false);
  // The server may revoke the token even if the reply never reaches this page.
  await pin.fill('012345');
  await logout.waitFor();
  await page.route('**/api/logout', async (route) => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.abort('connectionfailed');
  });
  await logout.click();
  await pin.waitFor();
  assert.equal(await isAuthenticated(), false);
  assert.deepEqual(errors, []);
  console.info(
    '[qa] Startup read recovered without a reload. Failed sign-out stayed locked across refresh and unavailable reads; a lost success response reconciled with the server.',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
