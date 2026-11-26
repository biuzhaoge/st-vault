import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
try {
  const base = 'http://127.0.0.1:' + fixture.info.port;
  browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true });
  const page = await browser.newPage();
  const endpoint = base + '/api/settings';
  const put = async (data) => {
    const response = await page.request.put(endpoint, { headers: { origin: base }, data });
    assert.equal(response.status(), 200);
    return response.json();
  };
  await page.goto(base);
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  const settings = page.getByRole('button', { name: '设置', exact: true });
  await settings.waitFor();
  await put({ retentionDays: 7 });
  await settings.click();
  const dialog = page.getByRole('dialog', { name: '设置', exact: true });
  const poll = dialog.getByRole('spinbutton', { name: /统一同步间隔/ });
  const retention = dialog.getByRole('spinbutton', { name: /录像保留天数/ });
  const free = dialog.getByRole('spinbutton', { name: /最低剩余空间/ });
  const button = dialog.getByRole('button', { name: '保存运行设置', exact: true });
  const waitValue = (field, expected) =>
    page.waitForFunction(([input, value]) => input.value === value, [field, expected]);
  await waitValue(await retention.elementHandle(), '7');
  await poll.fill('9');
  const fresh = page.waitForResponse(
    async (response) =>
      response.url() === base + '/api/system' &&
      response.ok() &&
      (await response.json()).settings.retentionDays === 0,
  );
  await put({ retentionDays: 0 });
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['system'] })),
  );
  await fresh;
  const save = async () => {
    const receipt = page.waitForResponse(
      (r) => r.url() === endpoint && r.request().method() === 'PUT',
    );
    await button.click();
    const response = await receipt;
    assert.equal(response.status(), 200);
    return { sent: response.request().postDataJSON(), saved: await response.json() };
  };
  await waitValue(await retention.elementHandle(), '0');
  assert.equal(await poll.inputValue(), '9');
  const patch = await save();
  assert.deepEqual(patch.sent, { pollMs: 9000 });
  assert.equal(patch.saved.retentionDays, 0);

  const writes = [];
  page.on('request', (r) => {
    if (r.url() === endpoint && r.method() === 'PUT') writes.push(r.postDataJSON());
  });
  for (const field of [free, retention, poll]) {
    await field.fill('');
    await button.click();
    assert(await field.evaluate((input) => !input.validity.valid));
    assert.deepEqual(writes, []);
    await dialog.getByRole('button', { name: '撤销未保存修改' }).click();
  }
  await free.fill('0');
  const zero = await save();
  assert.deepEqual(zero.sent, { minFreeBytes: 0 });
  assert.equal(zero.saved.minFreeBytes, 0);
  await poll.fill('1.001');
  assert.deepEqual((await save()).sent, { pollMs: 1001 });
  console.log(
    '[qa] Concurrent partial settings, untouched field refresh, blank and explicit zero passed',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
