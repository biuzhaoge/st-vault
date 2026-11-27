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
  const proxyEndpoint = `${endpoint}/socks-proxy`;
  let proxy = { enabled: false, endpoint: '', username: '', passwordSet: false };
  const proxyWrites = [];
  await page.route(proxyEndpoint, async (route) => {
    if (route.request().method() === 'PUT') {
      const data = route.request().postDataJSON();
      proxyWrites.push(data);
      proxy = {
        enabled: data.enabled,
        endpoint: data.endpoint,
        username: data.username,
        passwordSet:
          data.password !== undefined
            ? data.password.length > 0
            : proxy.endpoint === data.endpoint &&
              proxy.username === data.username &&
              proxy.passwordSet,
      };
    }
    await route.fulfill({ json: proxy });
  });
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
  const proxyToggle = dialog.getByRole('switch', { name: '启用 SOCKS5 代理', exact: true });
  const proxyAddress = dialog.getByRole('textbox', { name: /代理地址/ });
  const proxyUsername = dialog.getByRole('textbox', { name: /代理用户名/ });
  const proxyPassword = dialog.getByLabel('代理密码', { exact: true });
  const saveProxy = dialog.getByRole('button', { name: '保存代理设置', exact: true });
  await proxyToggle.waitFor();
  assert.equal(await proxyToggle.getAttribute('aria-checked'), 'false');
  await proxyToggle.click();
  for (const invalid of [
    'http://proxy.test:8080',
    'socks5://proxy.test',
    'socks5://user:password@proxy.test:1080',
  ]) {
    await proxyAddress.fill(invalid);
    await saveProxy.click();
    await dialog
      .getByRole('alert')
      .filter({ hasText: /代理地址/ })
      .waitFor();
  }
  assert.deepEqual(proxyWrites, []);
  await proxyAddress.fill(' socks5://proxy.test:1080 ');
  await proxyUsername.fill('test-user');
  await saveProxy.click();
  await dialog
    .getByRole('alert')
    .filter({ hasText: /启用代理认证时须填写密码/ })
    .waitFor();
  assert.deepEqual(proxyWrites, []);
  await proxyPassword.fill('test-password');
  await saveProxy.click();
  await dialog.getByText('代理设置已保存', { exact: true }).waitFor();
  assert.deepEqual(proxyWrites[0], {
    enabled: true,
    endpoint: 'socks5://proxy.test:1080',
    username: 'test-user',
    password: 'test-password',
  });
  assert.equal(await proxyPassword.inputValue(), '');
  await proxyToggle.click();
  await saveProxy.click();
  await dialog.getByText('代理设置已保存', { exact: true }).waitFor();
  assert.deepEqual(proxyWrites[1], {
    enabled: false,
    endpoint: 'socks5://proxy.test:1080',
    username: 'test-user',
  });
  await dialog.getByRole('button', { name: '清除已保存密码', exact: true }).click();
  await saveProxy.click();
  await dialog.getByText('代理设置已保存', { exact: true }).waitFor();
  assert.equal(proxyWrites[2].password, '');
  assert.equal(await proxyPassword.inputValue(), '');
  await settings.click();
  await page.locator('.toolbar-popover[aria-label="设置"]').waitFor({ state: 'detached' });
  proxy = {
    enabled: false,
    endpoint: '',
    username: '',
    passwordSet: false,
    error: 'proxy_settings_unavailable',
  };
  await settings.click();
  await dialog
    .getByRole('alert')
    .filter({ hasText: /服务器已暂停出站请求/ })
    .waitFor();
  await saveProxy.click();
  await dialog.getByText('代理设置已保存', { exact: true }).waitFor();
  assert.deepEqual(proxyWrites[3], { enabled: false, endpoint: '', username: '' });
  console.log('[qa] Runtime settings and independent SOCKS5 proxy controls passed');
} finally {
  await browser?.close();
  await fixture.close();
}
