import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';
import { outputRoot } from './support/media.mjs';

const fixture = await startFixture();
const opening = Promise.withResolvers();
let browser;
try {
  const origin = `http://127.0.0.1:${fixture.info.port}`;
  const subject = 'stripchat:42';
  const covers = await Promise.all(
    ['portrait.jpg', 'landscape.jpg'].map((name) => readFile(path.join(outputRoot, 'media', name))),
  );
  const hashes = covers.map((bytes) => createHash('sha256').update(bytes).digest('hex'));
  let revision = 0;
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.setDefaultTimeout(18000);
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const forSubject = (suffix) => (url) =>
    decodeURIComponent(url.pathname) === `/api/subjects/${subject}/${suffix}`;
  await page.route(forSubject('cover.jpg'), (route) =>
    route.fulfill({
      status: 200,
      contentType: 'image/jpeg',
      headers: { etag: `"cover-${revision}"` },
      body: covers[revision],
    }),
  );
  await page.route(forSubject('live'), async (route) => {
    await opening.promise;
    await route.continue();
  });
  const row = page.locator(`.track-row[data-subject-id="${subject}"] .subject-preview`);
  const listImage = row.locator('img[src^="blob:"]');
  const poster = page.locator('.studio-viewer .playback-poster img[src^="blob:"]');
  const inspectImage = (image) =>
    image.evaluate(async (element) => {
      await element.decode();
      const style = getComputedStyle(element);
      const bytes = await (await fetch(element.src)).arrayBuffer();
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return {
        hash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join(
          '',
        ),
        fit: style.objectFit,
        filter: style.filter,
        transform: style.transform,
        portrait: element.naturalHeight > element.naturalWidth,
      };
    });

  await page.goto(origin);
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  const first = await inspectImage(listImage);
  assert.equal(first.hash, hashes[0]);
  assert.equal(first.portrait, true);
  const requested = page.waitForRequest(
    (request) => request.method() === 'POST' && forSubject('live')(new URL(request.url())),
  );
  await row.click();
  await requested;
  const waiting = await inspectImage(poster);
  assert.equal(waiting.hash, first.hash, 'The waiting image uses the directory cover bytes');
  assert.equal(waiting.fit, 'contain');
  assert.equal(waiting.filter, 'blur(5px)');
  assert.equal(waiting.transform, 'none');

  revision = 1;
  await page.clock.setFixedTime(new Date(Date.now() + 60000));
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('stv-clock', { detail: Date.now() }));
  });
  await page.waitForFunction((id) => {
    const selectors = [
      `.track-row[data-subject-id="${id}"] .subject-preview img`,
      '.studio-viewer .playback-poster img',
    ];
    return selectors.every((selector) => {
      const image = document.querySelector(selector);
      return image?.complete && image.naturalWidth > image.naturalHeight;
    });
  }, subject);
  assert.equal((await inspectImage(listImage)).hash, hashes[1]);
  assert.equal((await inspectImage(poster)).hash, hashes[1]);

  opening.resolve();
  await page.waitForFunction(() => {
    const video = document.querySelector('.studio-viewer video[data-media-slot="active"]');
    return video?.readyState >= 2 && !video.paused;
  });
  await page.locator('.studio-viewer .playback-poster').waitFor({ state: 'detached' });
  console.log('[qa] Waiting poster matches the full current cover through first frame');
} finally {
  opening.resolve();
  await browser?.close();
  await fixture.close();
}
