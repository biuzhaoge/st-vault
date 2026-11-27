import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
try {
  const origin = `http://127.0.0.1:${fixture.info.port}`;
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(18000);
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const id = (value) => `stripchat:${value}`;
  const status = (value, onlineSinceMs = 0) => ({ providerStatus: value, onlineSinceMs });
  const subjects = new Map([
    [1, status('PUBLIC', 2000)],
    [2, status('OFFLINE')],
    [4, status('PRIVATE', 9000)],
    [5, status('OFFLINE')],
    [42, status('PUBLIC', 5000)],
    [300, { ...status('PUBLIC', 10000), archived: true }],
  ]);
  await page.route('**/api/subjects', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: (await response.json())
        .filter((subject) => subjects.has(subject.providerId))
        .map((subject) => ({
          ...subject,
          archived: false,
          directory: undefined,
          lastKnownStatus: undefined,
          ...subjects.get(subject.providerId),
        })),
    });
  });
  let transientFailures = 0;
  let continuingFailure = false;
  let continuingFailures = 0;
  await page.route(`**/api/subjects/${encodeURIComponent(id(2))}/live`, (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    if (continuingFailure) continuingFailures++;
    else if (transientFailures < 3) transientFailures++;
    else return route.continue();
    return route.fulfill({
      status: 503,
      json: { error: 'live_unavailable', reason: 'source' },
    });
  });
  const opens = [];
  const releases = [];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    const room = /^\/api\/subjects\/([^/]+)\/live$/.exec(pathname);
    if (room && request.method() === 'POST') opens.push(decodeURIComponent(room[1]));
    if (request.method() === 'DELETE' && /^\/api\/live\/[^/]+$/.test(pathname))
      releases.push(pathname);
  });

  const trigger = page.getByRole('button', { name: '监控墙', exact: true });
  const wall = page.getByRole('region', { name: '监控墙', exact: true });
  const exit = page.getByRole('button', { name: '返回工作台', exact: true });
  const row = (value) =>
    page.locator(`.track-row[data-subject-id="${id(value)}"] .subject-preview`);
  const tile = (value) => page.locator(`.monitor-tile[data-subject-id="${id(value)}"]`);
  const refresh = () =>
    page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['subjects'] })),
    );
  const waitTiles = async (expected) => {
    const expectedIds = expected.map(id);
    const getIds = (tiles) => Array.from(tiles, (node) => node.dataset.subjectId);
    try {
      await page.waitForFunction(
        (ids) =>
          Array.from(
            document.querySelectorAll('.monitor-tile'),
            (node) => node.dataset.subjectId,
          ).join(',') === ids.join(','),
        expectedIds,
      );
    } catch {
      assert.deepEqual(await page.locator('.monitor-tile').evaluateAll(getIds), expectedIds);
    }
  };
  const playing = (selector) =>
    page.waitForFunction((selector) => {
      const video = document.querySelector(selector);
      return video && !video.paused && video.readyState >= 2;
    }, selector);

  await page.goto(origin);
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await row(42).click();
  await playing('.studio-viewer .player-stage video');
  await page.getByRole('button', { name: '在线', exact: true }).click();
  await page.getByRole('button', { name: '离线', exact: true }).click();
  await trigger.click({ timeout: 5000 });
  await waitTiles([42, 1, 4]);
  assert.equal(await wall.getByRole('heading').count(), 0);
  const layout = await wall.evaluate((element) => {
    const shell = element.closest('.studio-shell');
    const topbar = shell.querySelector('.topbar');
    const viewport = element.querySelector('.monitor-wall-viewport');
    const exit = element.querySelector('.monitor-wall-return');
    const shellStyle = getComputedStyle(shell);
    const wallStyle = getComputedStyle(element);
    const titleStyle = getComputedStyle(topbar);
    const { bottom, left, right, top } = element.getBoundingClientRect();
    const shellBox = shell.getBoundingClientRect();
    const view = viewport.getBoundingClientRect();
    return {
      sharedGlass: ['backgroundImage', 'backdropFilter', 'borderRadius', 'boxShadow'].every(
        (property) => titleStyle[property] === wallStyle[property],
      ),
      fillsShell:
        Math.abs(left - shellBox.left - parseFloat(shellStyle.paddingLeft)) <= 1 &&
        Math.abs(shellBox.right - right - parseFloat(shellStyle.paddingRight)) <= 1 &&
        Math.abs(shellBox.bottom - bottom - parseFloat(shellStyle.paddingBottom)) <= 1,
      viewportStartsAtTop: view.top - top <= 6,
      viewportReachesBottom: bottom - view.bottom <= 6,
      floatingReturn: getComputedStyle(exit).position === 'absolute',
    };
  });
  assert.deepEqual(layout, {
    sharedGlass: true,
    fillsShell: true,
    viewportStartsAtTop: true,
    viewportReachesBottom: true,
    floatingReturn: true,
  });
  await playing(`.monitor-tile[data-subject-id="${id(42)}"] video`);
  await playing(`.monitor-tile[data-subject-id="${id(1)}"] video`);
  for (const value of [42, 1])
    assert.equal(
      await tile(value)
        .locator('video')
        .evaluate((v) => v.muted),
      true,
    );
  await tile(4).getByText('主播已转入非公开直播', { exact: true }).waitFor();
  assert.ok(!opens.includes(id(4)), 'Private rooms do not attempt a public stream');
  const names = page.locator('.monitor-tile-name');
  assert.deepEqual(await names.allTextContents(), ['00 演示直播', '演示主播 001', '演示主播 004']);
  await page.mouse.move(3, 3);
  assert.ok(
    await names.evaluateAll((nodes) =>
      nodes.every((node) => {
        const name = node.getBoundingClientRect();
        const cell = node.closest('.monitor-tile').getBoundingClientRect();
        return (
          name.height > 0 &&
          name.height < cell.height / 4 &&
          name.top >= cell.top &&
          name.top < cell.top + 12 &&
          name.left >= cell.left &&
          name.left < cell.left + 12
        );
      }),
    ),
    'Names remain visible in the upper-left corner of each tile',
  );
  const initialWidth = (await tile(42).boundingBox()).width;
  const previousReleases = releases.length;
  subjects.set(42, status('PRIVATE', 5000));
  subjects.set(1, status('OFFLINE'));
  subjects.set(2, status('PUBLIC', 11000));
  subjects.set(5, status('PRIVATE', 10000));
  await refresh();
  await waitTiles([2, 5, 4, 42]);
  await playing(`.monitor-tile[data-subject-id="${id(2)}"] video`);
  assert.equal(transientFailures, 3, 'The fixture dropped the first three connection attempts');
  assert.equal(
    opens.filter((value) => value === id(2)).length,
    4,
    'The third automatic reconnect restores live frames',
  );
  await tile(42).getByText('主播已转入非公开直播', { exact: true }).waitFor();
  await tile(42).locator('video').waitFor({ state: 'detached' });
  assert.ok(
    releases.length >= previousReleases + 2,
    'Offline and newly private streams are closed',
  );

  for (const value of [5, 4, 42]) subjects.set(value, status('OFFLINE'));
  await refresh();
  await waitTiles([2]);
  await page.waitForFunction(
    (width) => document.querySelector('.monitor-tile').clientWidth > width * 1.5,
    initialWidth,
  );

  subjects.set(2, status('OFFLINE'));
  await refresh();
  await page.getByText('暂无在线主播', { exact: true }).waitFor();
  continuingFailure = true;
  subjects.set(2, status('PUBLIC', 11000));
  subjects.set(1, status('PUBLIC', 12000));
  await refresh();
  await waitTiles([1, 2]);
  await playing(`.monitor-tile[data-subject-id="${id(1)}"] video`);
  const manualReconnect = tile(2).getByRole('button', { name: '重新连接', exact: true });
  await manualReconnect.waitFor();
  assert.equal(continuingFailures, 4, 'Automatic reconnect stops after the third retry');
  continuingFailure = false;
  await manualReconnect.click();
  await playing(`.monitor-tile[data-subject-id="${id(2)}"] video`);

  const beforeReturn = releases.length;
  const opensBeforeReturn = opens.length;
  const firstRelease = Promise.withResolvers();
  const allowRelease = Promise.withResolvers();
  await page.route('**/api/live/*', async (route) => {
    if (route.request().method() === 'DELETE') {
      firstRelease.resolve();
      await allowRelease.promise;
    }
    await route.continue();
  });
  try {
    const releaseRequest = page.waitForRequest(
      (request) =>
        request.method() === 'DELETE' &&
        /^\/api\/live\/[^/]+$/.test(new URL(request.url()).pathname),
    );
    await exit.focus();
    await page.keyboard.press('Enter');
    await releaseRequest;
    await firstRelease.promise;
    await trigger.waitFor({ timeout: 3000 });
    await wall.waitFor({ state: 'detached' });
    assert.equal(
      opens.length,
      opensBeforeReturn,
      'Live playback waits for the wall leases to close',
    );
  } finally {
    allowRelease.resolve();
  }
  await trigger.waitFor();
  await playing('.studio-viewer .player-stage video');
  assert.equal(opens.at(-1), id(42), 'Returning restores the previous workbench stream');
  assert.ok(releases.length > beforeReturn, 'Leaving closes the remaining wall stream');
  assert.equal(
    await page.getByRole('button', { name: '离线', exact: true }).getAttribute('aria-pressed'),
    'true',
  );

  await page.unroute('**/api/live/*');
  const openingLease = Promise.withResolvers();
  const allowOpen = Promise.withResolvers();
  await page.route(`**/api/subjects/${encodeURIComponent(id(5))}/live`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    openingLease.resolve(body.sessionId);
    await allowOpen.promise;
    await route.fulfill({ response, json: body });
  });
  subjects.set(1, status('OFFLINE'));
  subjects.set(2, status('PRIVATE', 11000));
  subjects.set(5, status('PUBLIC', 13000));
  await refresh();
  await trigger.click();
  await waitTiles([5, 2]);
  try {
    const sessionId = await openingLease.promise;
    assert.ok(sessionId, 'The server admitted a monitor stream without sending its response yet');
    const beforeLateReturn = opens.length;
    await exit.click();
    await trigger.waitFor({ timeout: 3000 });
    await page.getByRole('button', { name: '在线', exact: true }).click();
    await row(2).click();
    assert.equal(await row(2).getAttribute('aria-current'), 'true');
    assert.equal(opens.length, beforeLateReturn, 'A new choice can wait for the outstanding lease');
    const releasedLate = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/live/${sessionId}` &&
        response.request().method() === 'DELETE' &&
        response.ok(),
    );
    allowOpen.resolve();
    await releasedLate;
    await playing('.studio-viewer .player-stage video');
    assert.deepEqual(opens.slice(beforeLateReturn), [id(2)]);
  } finally {
    allowOpen.resolve();
  }
  assert.deepEqual(errors, []);
  console.log(
    '[qa] Monitor wall layout, live frames, three retries, roster changes and nonblocking return passed',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
