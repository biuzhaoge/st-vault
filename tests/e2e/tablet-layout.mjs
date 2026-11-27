import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const engine = process.env.STV_QA_BROWSER === 'webkit' ? 'webkit' : 'chromium';
async function swipe(cdp, x, y, dx, dy) {
  const send = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
  await send('touchStart', [{ x, y }]);
  for (let step = 1; step <= 8; step++)
    await send('touchMove', [{ x: x + (dx * step) / 8, y: y + (dy * step) / 8 }]);
  await send('touchEnd', []);
}

const fixture = await startFixture();
let browser;
try {
  const history = await fixture.seedSnapshotHistory();
  browser = await (engine === 'webkit'
    ? webkit.launch()
    : chromium.launch({
        executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
      }));
  const context = await browser.newContext({
    viewport: { width: 1194, height: 748 },
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
  });
  try {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    await page.goto('http://127.0.0.1:10085');
    await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
    const row = page.locator(`.track-row[data-subject-id="${fixture.info.subjectId}"]`);
    await row.waitFor();

    for (const [width, height] of [
      [1194, 748],
      [1024, 768],
      [1133, 660],
      [744, 600],
      [1920, 900],
    ]) {
      await page.setViewportSize({ width, height });
      const boxes = await page.evaluate(() => {
        const rect = (selector) =>
          document.querySelector(selector).getBoundingClientRect().toJSON();
        return {
          header: rect('.topbar'),
          player: rect('.player-picture'),
          review: rect('.media-review'),
          list: rect('.aligned-arrangement'),
          rail: rect('.connection-rail'),
          filter: rect('.subject-filters'),
          controls: rect('.time-control-strip'),
          monitor: rect('.monitor-wall-trigger'),
          view: rect('.time-control-row'),
          viewWindow: rect('.view-position-window'),
          viewSpan: rect('.view-position-span'),
          lastStep: rect('.day-step:last-child'),
          playerControls: [
            ...document.querySelectorAll('.player-actions :is(.player-control,.tool-trigger)'),
          ].map((button) => button.getBoundingClientRect()),
          labels: [...document.querySelectorAll('.header-tools .tool-label')].every(
            (label) => label.getBoundingClientRect().width > 0,
          ),
          lane: rect('.track-lane'),
          ruler: rect('.time-ruler-row .timeline-ruler'),
          listOverflow:
            document.querySelector('.track-table-scroll').scrollWidth -
            document.querySelector('.track-table-scroll').clientWidth,
          overflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      const result = JSON.stringify({ engine, width, height, boxes });
      assert(boxes.header.width > 0 && boxes.player.width > 250 && boxes.list.width > 275, result);
      assert(
        boxes.header.bottom < boxes.player.top && boxes.header.bottom < boxes.list.top,
        result,
      );
      assert(Math.abs(boxes.player.top - boxes.list.top) < 1, result);
      assert(
        boxes.player.right < boxes.list.left && boxes.player.bottom < boxes.review.top,
        result,
      );
      assert(Math.abs(boxes.player.width / boxes.player.height - 16 / 9) < 0.01, result);
      assert(Math.abs(boxes.list.bottom - boxes.review.bottom) < 1, result);
      assert(Math.abs(boxes.rail.top - boxes.list.top) < 1, result);
      assert(Math.abs(boxes.rail.bottom - boxes.list.bottom) < 1, result);
      assert(boxes.filter.width > 0 && boxes.lastStep.right <= boxes.list.right + 1, result);
      assert(
        boxes.filter.right <= boxes.view.left &&
          boxes.view.right <= boxes.monitor.left &&
          boxes.monitor.right <= boxes.controls.right &&
          boxes.monitor.width >= 28 &&
          boxes.monitor.height === boxes.filter.height &&
          boxes.viewSpan.left >= boxes.viewWindow.left - 1 &&
          boxes.viewSpan.right <= boxes.viewWindow.right + 1,
        result,
      );
      assert(!boxes.overflow && boxes.labels, result);
      assert(boxes.listOverflow <= 1 && boxes.lane.right <= boxes.list.right + 1, result);
      assert(Math.abs(boxes.ruler.right - boxes.lane.right) < 1, result);
      assert(boxes.header.height <= 44 && boxes.controls.height <= 39, result);
      assert(
        boxes.playerControls.every(
          ({ width, height }) => width >= 24 && width <= 34 && width === height,
        ),
        result,
      );
      console.log(
        JSON.stringify({ engine, viewport: [width, height], timeline: boxes.lane.width }),
      );
    }

    for (const [width, height] of [
      [390, 844],
      [844, 390],
      [834, 1194],
      [744, 1133],
      [900, 900],
      [1920, 780],
    ]) {
      await page.setViewportSize({ width, height });
      await page.getByRole('heading', { name: '当前窗口尺寸不受支持' }).waitFor();
      await page.getByText('请将平板转为横屏，或调整电脑窗口大小。').waitFor();
      assert.equal(await row.isVisible(), false);
    }
    await page.setViewportSize({ width: 1024, height: 768 });
    await row.waitFor();
    const settings = page.getByRole('button', { name: '设置', exact: true });
    await settings.tap();
    const panel = page.getByRole('dialog', { name: '设置', exact: true });
    await panel.waitFor();
    await panel.evaluate((node) =>
      Promise.all(node.getAnimations().map((entry) => entry.finished)),
    );
    const panelBox = await panel.boundingBox();
    assert(panelBox.x >= 0 && panelBox.y >= 0 && panelBox.y + panelBox.height <= 768);
    await panel.getByRole('button', { name: '关闭浮窗' }).tap();
    await panel.waitFor({ state: 'hidden' });

    const cdp = engine === 'chromium' ? await context.newCDPSession(page) : null;
    if (cdp) {
      const scroller = page.locator('.track-table-scroll');
      for (const side of ['.subject-preview', '.track-lane']) {
        const box = await page.locator(`.track-row ${side}`).nth(3).boundingBox();
        await swipe(cdp, box.x + box.width / 2, box.y + box.height / 2, 0, -160);
        await page.waitForFunction(
          () => document.querySelector('.track-table-scroll').scrollTop > 50,
        );
        assert.equal(
          await page.locator('.track-row.selected, .range-selection[aria-hidden="false"]').count(),
          0,
        );
        // A new touch stops any inertial scrolling before returning to the fixture row.
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
        });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        await scroller.evaluate((node) => node.scrollTo(0, 0));
        await row.waitFor();
      }
      const lane = row.locator('.track-lane');
      if (history.fromMs < Number(await lane.getAttribute('data-from')))
        await page.getByRole('slider', { name: '视窗起点', exact: true }).press('ArrowLeft');
      const box = await lane.boundingBox();
      await swipe(cdp, box.x + 3, box.y + box.height / 2, box.width - 6, 0);
      await row.and(page.locator('.selected')).waitFor();
      const media = page.locator('video[data-media-slot="active"]');
      await page.waitForFunction(
        () => document.querySelector('video[data-media-slot="active"]')?.readyState >= 2,
      );
      await media.evaluate((node) => node.pause());
    } else {
      await row.locator('.subject-preview').tap();
      await row.and(page.locator('.selected')).waitFor();
    }

    const cards = page.locator(
      '.snapshot-grid button[data-unit-index][data-favorite-ready="true"]',
    );
    const card = cards.first();
    await card.waitFor();
    const cardReachable = await card.evaluate((node) => {
      const box = node.querySelector('div').getBoundingClientRect();
      return (
        [
          [box.left + 6, box.top + 6],
          [box.left + box.width / 2, box.top + box.height / 2],
        ].every(([x, y]) => document.elementFromPoint(x, y)?.closest('button') === node) &&
        node.parentElement.querySelectorAll('button').length === 1
      );
    });
    assert(cardReachable, 'The corner and center belong to the same unobstructed touch target');

    let favoriteWrites = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/unit-favorites')) favoriteWrites++;
    });
    if (cdp) {
      const pageNumber = (number) =>
        page.waitForFunction(
          (number) =>
            new RegExp(`^${number}\\s*/\\s*[2-9]`).test(
              document.querySelector('.snapshot-pages output')?.textContent ?? '',
            ),
          number,
        );
      await pageNumber(1);
      const button = await cards.nth(10).boundingBox();
      await swipe(cdp, button.x + button.width / 2, button.y + button.height / 2, 0, -68);
      await pageNumber(2);
      assert.equal(favoriteWrites, 0, 'A paging swipe starting on a card must not favorite it');
    }
    await Promise.all([
      page.waitForResponse(
        (response) => response.url().endsWith('/unit-favorites') && response.ok(),
      ),
      (async () => {
        await card.tap();
        await card.tap();
      })(),
    ]);
    await page.waitForFunction(
      () =>
        document
          .querySelector('.snapshot-grid button[data-unit-index]')
          ?.getAttribute('data-liked') === 'true',
    );
    assert.equal(favoriteWrites, 1);
    if (cdp && (await page.evaluate(() => document.fullscreenEnabled))) {
      await page.locator('.player-picture').tap({ position: { x: 100, y: 60 } });
      await page.getByRole('button', { name: '全屏播放', exact: true }).tap();
      await page.waitForFunction(() => !!document.fullscreenElement);
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.waitForFunction(() => !document.fullscreenElement);
      await page.getByRole('heading', { name: '当前窗口尺寸不受支持' }).waitFor();
      await page.setViewportSize({ width: 1024, height: 768 });
      await row.and(page.locator('.selected')).waitFor();
    }
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        engine,
        unsupported: true,
        touchScrollAndSwipe: !!cdp,
        touchPanel: true,
        touchFavorite: true,
      }),
    );
  } finally {
    await context.close();
  }
} finally {
  await browser?.close();
  await fixture.close();
}
