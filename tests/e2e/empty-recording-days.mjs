import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

process.env.TZ = 'Asia/Shanghai';
let releaseDeletion;
const deletionGate = new Promise((resolve) => {
  releaseDeletion = resolve;
});
const fixture = await startFixture({
  calendarGap: true,
  beforeDeletionPrepare: () => deletionGate,
});
const day = 86400000;
const { port, midnight, subjectId } = fixture.info;
const left = midnight - 110 * day,
  gap = left + day,
  right = midnight - 2 * day;
const origin = `http://127.0.0.1:${port}`;
let browser;
try {
  await fixture.appendSnapshotUnit(left + day / 2);
  await fixture.appendSnapshotUnit(right + day / 2);
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  await page.goto(origin);
  assert.equal((await page.request.get(origin + '/api/archive-calendar')).status(), 401);
  const calendarReply = page.waitForResponse(
    (response) => response.url().endsWith('/api/archive-calendar') && response.ok(),
  );
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  const catalog = await (await calendarReply).json();
  assert(catalog.emptyDays.some(({ fromMs, toMs }) => fromMs === gap && toMs === right));

  const statusPath = `/api/subjects/${encodeURIComponent(subjectId)}/status-history?from=${right - day}&to=${right}&buckets=1`;
  const read = async (path) => {
    const response = await page.request.get(origin + path);
    assert.equal(response.status(), 200);
    return response.json();
  };
  const statusInGap = async () => (await read(statusPath)).buckets[0].durationsMs;
  const eventsInGap = async () =>
    (await read('/api/events')).items.filter(({ atMs }) => atMs >= gap && atMs < right);
  assert((await statusInGap()).PRIVATE > 0);
  assert((await eventsInGap()).length > 0);
  await fixture.pruneEmptyDays();
  assert.deepEqual(await statusInGap(), { PUBLIC: 0, PRIVATE: 0, OFFLINE: 0, UNKNOWN: day });
  assert.deepEqual(await eventsInGap(), []);

  const lane = page.locator(`[data-subject-id="${subjectId}"] .track-lane`);
  const grip = page.getByRole('slider', { name: '平移视窗', exact: true });
  await page.getByRole('button', { name: '前12小时', exact: true }).waitFor();
  await grip.press('Home');
  await page.waitForFunction(
    (left) => Number(document.querySelector('.track-lane')?.dataset.from) === left,
    left,
  );
  const end = page.getByRole('slider', { name: '视窗终点', exact: true });
  await end.press('ArrowRight');
  await end.press('ArrowRight');
  await page.waitForFunction(
    (right) => Number(document.querySelector('.track-lane')?.dataset.to) === right + 86400000,
    right,
  );
  const positions = await page
    .locator('.ruler-date[aria-hidden="false"]')
    .evaluateAll((labels) =>
      labels.map((label) => [Number(label.dataset.day), parseFloat(label.style.left)]),
    );
  assert.deepEqual(positions, [
    [left, 25],
    [right, 75],
  ]);
  assert.equal(await page.locator('.view-position-span').textContent(), '2天');
  await page.waitForFunction((to) => {
    const key = Object.keys(localStorage).find((value) => value.endsWith(':view'));
    const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    return saved?.viewToMs === to && saved?.durationMs === 2 * 86400000;
  }, right + day);
  await page.reload();
  await page.waitForFunction(
    ({ from, to }) => {
      const range = document.querySelector('.track-lane')?.dataset;
      return Number(range?.from) === from && Number(range?.to) === to;
    },
    { from: left, to: right + day },
  );

  const workbench = await read(
    `/api/workbench?ids=${encodeURIComponent(subjectId)}&from=${left}&to=${right + day}&buckets=48`,
  );
  assert.deepEqual(
    workbench.rows[0].coverage.buckets.map(({ mediaFromMs }) => mediaFromMs),
    [left + day / 2, right + day / 2],
  );
  assert(
    workbench.rows[0].status.buckets.every(({ fromMs, toMs }) => toMs <= gap || fromMs >= right),
  );
  const tooWide = await page.request.get(
    `${origin}/api/workbench?ids=${encodeURIComponent(subjectId)}&from=${left - 9 * day}&to=${right + day}&buckets=48`,
  );
  assert.equal(tooWide.status(), 400);

  const bounds = await lane.boundingBox();
  assert(bounds);
  const [resolve, playback, snapshots] = await Promise.all([
    page.waitForRequest((request) => request.url().includes('/recording-bounds?')),
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/playback') && response.request().method() === 'POST',
    ),
    page.waitForResponse((response) => response.url().includes('/snapshot-pages?')),
    (async () => {
      const y = bounds.y + bounds.height / 2;
      await page.mouse.move(bounds.x + bounds.width * 0.2, y);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width * 0.8, y, { steps: 10 });
      await page.mouse.up();
    })(),
  ]);
  const selected = new URL(resolve.url()).searchParams;
  assert(Math.abs(Number(selected.get('from')) - (left + 0.4 * day)) < 0.01 * day);
  assert(Math.abs(Number(selected.get('to')) - (right + 0.6 * day)) < 0.01 * day);
  assert.equal(playback.status(), 200);
  assert.equal(snapshots.status(), 200);

  const backfill = right - day / 2;
  await fixture.appendSnapshotUnit(backfill);
  const after = await read('/api/archive-calendar');
  assert(!after.emptyDays.some(({ fromMs, toMs }) => fromMs <= backfill && toMs > backfill));
  const rightClip = right + day / 2;
  const rightStatus = `/api/subjects/${encodeURIComponent(subjectId)}/status-history?from=${right}&to=${right + day}&buckets=1`;
  const rightPublicMs = async () => (await read(rightStatus)).buckets[0].durationsMs.PUBLIC;
  const beforeDeletion = await rightPublicMs();
  assert(beforeDeletion > 0);
  const commandId = randomUUID();
  const deletion = await page.request.post(
    `${origin}/api/subjects/${encodeURIComponent(subjectId)}/deletion-intents`,
    {
      headers: { origin },
      data: {
        commandId,
        target: { kind: 'range', mode: 'all', fromMs: rightClip - 60000, toMs: rightClip + 60000 },
      },
    },
  );
  assert.equal(deletion.status(), 202);
  const hidden = await read('/api/archive-calendar');
  assert(hidden.emptyDays.some(({ fromMs, toMs }) => fromMs <= rightClip && toMs > rightClip));
  await fixture.pruneEmptyDays();
  assert.equal(await rightPublicMs(), beforeDeletion);
  releaseDeletion();
  const jobPath = `/api/media-deletions/${commandId}`;
  const deadline = Date.now() + 15000;
  let job = await read(jobPath);
  while (job.state !== 'completed' && job.state !== 'failed' && Date.now() < deadline) {
    await delay(100);
    job = await read(jobPath);
  }
  assert.equal(job.state, 'completed');
  await fixture.pruneEmptyDays();
  assert.equal(await rightPublicMs(), 0);
  console.log(
    '[qa] Empty-day cleanup and collapsed ruler verified with exact playback request coordinates',
  );
} finally {
  releaseDeletion();
  await browser?.close();
  await fixture.close();
}
