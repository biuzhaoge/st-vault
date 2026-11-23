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

  await connect();
  const wireAtRecordingButton = () =>
    page.waitForFunction(() => {
      const track = document.querySelector('.track-row.selected');
      const button = track?.querySelector('.record-button');
      const cover = track?.querySelector('.track-cover-wrap');
      const wire = document.querySelector(
        '.row-connection[data-offscreen="visible"] .connection-bus',
      );
      const matrix = wire?.getScreenCTM();
      if (!button || !cover || !matrix) return false;
      const end = wire.getPointAtLength(wire.getTotalLength()).matrixTransform(matrix);
      const control = button.getBoundingClientRect();
      const picture = cover.getBoundingClientRect();
      const center = { x: control.left + control.width / 2, y: control.top + control.height / 2 };
      return (
        control.width <= 24 &&
        Math.abs(control.left - picture.left - 3) < 1 &&
        Math.abs(control.top - picture.top - 3) < 1 &&
        Math.abs(end.x - control.left) < 1 &&
        Math.abs(end.y - center.y) < 1 &&
        button.contains(document.elementFromPoint(center.x, center.y))
      );
    });
  await wireAtRecordingButton();
  const list = page.locator('.track-table-scroll');
  const initialTop = await list.evaluate((node) => node.scrollTop);
  await list.evaluate((node) => node.scrollTo(0, node.scrollHeight));
  await page.locator('.row-connection[data-offscreen="above"] .connection-arrow').waitFor();
  await list.evaluate((node, top) => node.scrollTo(0, top), initialTop);
  await wireAtRecordingButton();
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
  console.log(
    JSON.stringify({ nativeCloseRace: true, pendingBounds: true, pendingPlayback: true }),
  );
} finally {
  for (const release of releases) release();
  await browser?.close();
  await fixture.close();
}
