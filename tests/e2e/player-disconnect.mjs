import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
const releases = [];
try {
  await fixture.seedSnapshotHistory();
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  const row = page.locator(`.track-row[data-subject-id="${fixture.info.subjectId}"]`);
  const connect = async () => {
    await row.locator('.subject-preview').click();
    await page.waitForFunction(() => {
      const video = document.querySelector('video[data-media-slot="active"]');
      return video?.readyState >= 2 && !video.paused;
    });
    await page.locator('.focus-playhead').waitFor();
  };
  const disconnected = async () => {
    await page.waitForFunction(
      () =>
        !document.querySelector('.focus-playhead') &&
        !document.querySelector('.range-selection[aria-hidden="false"]') &&
        document.querySelector('.connection-rail')?.dataset.connected === 'false',
    );
    assert.equal(await page.locator('.focus-lane').getAttribute('aria-disabled'), 'true');
  };
  const hold = async (pattern) => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    releases.push(release);
    await page.route(pattern, async (route) => {
      await gate;
      // Closing a connection may already have cancelled the browser request.
      await route.continue();
    });
    return async () => {
      release();
      await page.unroute(pattern);
    };
  };

  const wireAtRowMidpoint = (subjectId) =>
    page.waitForFunction(
      (id) => {
        const row = document.querySelector(`.track-row.selected[data-subject-id="${id}"]`);
        const bounds = row?.getBoundingClientRect();
        const connection = document.querySelector('.row-connection[data-offscreen="visible"]');
        const wire = connection?.querySelector('.connection-bus');
        const node = connection?.querySelector('circle.connection-node');
        const matrix = wire?.getScreenCTM();
        const nodeMatrix = node?.getScreenCTM();
        if (!bounds || !matrix || !nodeMatrix) return false;
        const end = wire.getPointAtLength(wire.getTotalLength()).matrixTransform(matrix);
        const center = new DOMPoint(node.cx.baseVal.value, node.cy.baseVal.value).matrixTransform(
          nodeMatrix,
        );
        const brand = getComputedStyle(wire).stroke;
        const marker = getComputedStyle(node);
        return (
          Math.abs(end.x - bounds.left) < 1 &&
          Math.abs(end.y - bounds.top - bounds.height / 2) < 1 &&
          Math.hypot(center.x - end.x, center.y - end.y) < 1 &&
          node.r.baseVal.value >= 3 &&
          (marker.fill === brand || marker.stroke === brand) &&
          marker.fill !== marker.stroke &&
          marker.pointerEvents === 'none' &&
          document.elementFromPoint(center.x, center.y) !== node
        );
      },
      subjectId,
      { timeout: 5000 },
    );

  await connect();
  const recordingButtonInIndex = () =>
    page.waitForFunction(() => {
      const track = document.querySelector('.track-row.selected');
      const index = track?.querySelector('.directory-row-index');
      const button = index?.querySelector('.record-button');
      const number = index?.querySelector('.directory-row-number');
      const cover = track?.querySelector('.track-cover-wrap');
      if (!button || !number || !cover) return false;
      const control = button.getBoundingClientRect();
      const label = number.getBoundingClientRect();
      const picture = cover.getBoundingClientRect();
      const center = { x: control.left + control.width / 2, y: control.top + control.height / 2 };
      return (
        control.right <= picture.left + 0.5 &&
        button.contains(number) &&
        Math.abs(center.y - label.top - label.height / 2) < 1 &&
        Math.abs(center.x - label.left - label.width / 2) < 1 &&
        button.contains(document.elementFromPoint(center.x, center.y))
      );
    });
  await recordingButtonInIndex();
  await wireAtRowMidpoint(fixture.info.subjectId);

  await page.locator('.connection-close').hover();
  await page.waitForFunction(() => {
    const close = document.querySelector('.connection-close:hover');
    const wire = document.querySelector('.row-connection .connection-bus');
    return close && wire && getComputedStyle(close).color === getComputedStyle(wire).stroke;
  });
  await page.mouse.move(0, 0);

  const list = page.locator('.track-table-scroll');
  const initialTop = await list.evaluate((node) => node.scrollTop);
  await list.evaluate((node) => node.scrollTo(0, node.scrollHeight));
  await page.locator('.row-connection[data-offscreen="above"] .connection-arrow').waitFor();
  await list.evaluate((node, top) => node.scrollTo(0, top), initialTop);
  await wireAtRowMidpoint(fixture.info.subjectId);
  await recordingButtonInIndex();
  // A native event in the close click's turn must not resurrect the old cursor.
  await page.evaluate(() => {
    const video = document.querySelector('video[data-media-slot="active"]');
    document.querySelector('.connection-close').click();
    video.dispatchEvent(new Event('seeked'));
    video.dispatchEvent(new Event('timeupdate'));
  });
  await disconnected();

  await connect();
  const releaseBounds = await hold('**/recording-bounds?*');
  const boundsRequested = page.waitForRequest((request) =>
    request.url().includes('/recording-bounds?'),
  );
  const lane = await row.locator('.track-lane').boundingBox();
  await page.mouse.move(lane.x + 4, lane.y + 40);
  await page.mouse.down();
  await page.mouse.move(lane.x + lane.width - 4, lane.y + 40, { steps: 8 });
  await page.locator('.range-selection.is-drawing[aria-hidden="false"]').waitFor();
  await page.mouse.up();
  await boundsRequested;
  await page.locator('.connection-close').click();
  await disconnected();
  await releaseBounds();
  await page.waitForTimeout(250);
  await disconnected();

  await connect();
  const releasePlayback = await hold('**/api/playback');
  const playbackRequested = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/api/playback',
  );
  await page.locator('.snapshot-cell button[data-unit-index]').first().click();
  await playbackRequested;
  await page.locator('.connection-close').click();
  await disconnected();
  await releasePlayback();
  await page.waitForTimeout(250);
  await disconnected();

  const filters = page.locator('.subject-filters');
  await filters.getByRole('button', { name: '归档', exact: true }).click();
  await filters.getByRole('button', { name: '在线', exact: true }).click();
  const archived = page.locator('.track-row[data-subject-id="stripchat:300"]');
  await archived.locator('.subject-preview').press('Enter');
  await wireAtRowMidpoint('stripchat:300');
  console.log(
    JSON.stringify({
      nativeCloseRace: true,
      pendingBounds: true,
      pendingPlayback: true,
      visibleRowMidpoints: true,
      connectionHoverMatchesLine: true,
    }),
  );
} finally {
  for (const release of releases) release();
  await browser?.close();
  await fixture.close();
}
