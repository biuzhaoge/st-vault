import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
const days = Number(process.env.STV_QA_SCROLL_DAYS ?? 7);
assert([1, 7].includes(days));
let browser, page;
let releaseTimeline = () => undefined;
let releaseFirstTrack = () => undefined;
try {
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const timelineReads = [];
  let timelineGate = Promise.resolve();
  let firstTrackGate;
  const coverPreloads = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/workbench')
      timelineReads.push(url.searchParams.get('ids')?.split(',') ?? []);
    if (url.pathname.endsWith('/cover.jpg') && url.searchParams.get('cached') === '1')
      coverPreloads.push(url.pathname);
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.route('**/api/workbench?**', async (route) => {
    await timelineGate;
    const ids = new URL(route.request().url()).searchParams.get('ids')?.split(',') ?? [];
    if (firstTrackGate && ids.includes(firstTrackGate.id)) await firstTrackGate.ready;
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const packet = await response.json();
    for (const { coverage, status } of packet.rows) {
      const step = (coverage.toMs - coverage.fromMs) / 720;
      coverage.buckets = Array.from({ length: 720 }, (_, index) => ({
        fromMs: coverage.fromMs + index * step,
        toMs: coverage.fromMs + (index + 0.8) * step,
        coveredMs: step * (index % 2 ? 0.3 : 0.7),
        segmentCount: 1,
      }));
      status.buckets = Array.from({ length: 720 }, (_, index) => ({
        fromMs: status.fromMs + index * step,
        toMs: status.fromMs + (index + 1) * step,
        durationsMs: {
          PUBLIC: Math.floor((index * step) / 1800000) % 2 ? 0 : step,
          PRIVATE: Math.floor((index * step) / 1800000) % 2 ? step : 0,
          OFFLINE: 0,
          UNKNOWN: 0,
        },
      }));
    }
    return route.fulfill({ response, json: packet });
  });
  const origin = 'http://127.0.0.1:10085';
  const session = await page.request.post(`${origin}/api/login`, {
    headers: { origin },
    data: { pin: '012345' },
  });
  assert.equal(session.status(), 200);
  const identity = await (await page.request.get(`${origin}/api/session`)).json();
  await page.addInitScript(
    ({ key, durationMs }) => {
      if (!localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify({ filter: 'ONLINE', durationMs }));
    },
    { key: `st-vault:${identity.instanceId}:${identity.userId}:view`, durationMs: days * 86400000 },
  );
  await page.goto(origin);
  await page.locator('.track-row svg.track-clip path').first().waitFor();
  assert.equal(
    await page
      .locator('.track-lane')
      .first()
      .evaluate((lane) => Number(lane.dataset.to) - Number(lane.dataset.from)),
    days * 86400000,
    'Measure the requested calendar window',
  );
  const scroller = page.locator('.track-table-scroll');
  const knownId = await scroller.locator('.track-row').first().getAttribute('data-subject-id');
  assert.ok(knownId);
  const knownCover = `.track-row[data-subject-id="${knownId}"] .track-cover`;
  const coverReady = () =>
    page.waitForFunction(
      (selector) => document.querySelector(selector)?.naturalWidth > 0,
      knownCover,
      { timeout: 4000 },
    );
  await coverReady();
  const coverRoute = `${origin}/api/subjects/${encodeURIComponent(knownId)}/cover.jpg**`;
  const holdCover = (route) => route.fulfill({ status: 503 });
  await page.route(coverRoute, holdCover);
  await scroller.evaluate((node) => {
    node.scrollTop = 6000;
  });
  await page.locator(knownCover).waitFor({ state: 'detached' });
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  await coverReady();
  await page.unroute(coverRoute, holdCover);
  assert.notEqual(
    await scroller
      .locator('.track-spacer')
      .last()
      .evaluate((node) => getComputedStyle(node).backgroundImage),
    'none',
  );
  const fastScrollFrames = await scroller.evaluate(async (node) => {
    const checks = [];
    for (const target of [6000, 11840, 4800, 0]) {
      node.scrollTop = target;
      await new Promise(requestAnimationFrame);
      const viewport = node.getBoundingClientRect();
      const visible = [...node.querySelectorAll('.track-table > .track-row')].filter((row) => {
        const bounds = row.getBoundingClientRect();
        return bounds.bottom > viewport.top && bounds.top < viewport.bottom;
      });
      checks.push({
        top: node.scrollTop,
        gridPinned:
          Math.abs(
            node.querySelector('.timeline-grid').getBoundingClientRect().top - viewport.top,
          ) <= 1,
        filled: visible.length >= Math.floor(node.clientHeight / 72),
        rails: visible.every((row) =>
          ['.track-cover-wrap', '.status-line', '.recording-line'].every((selector) =>
            row.querySelector(selector),
          ),
        ),
      });
    }
    return checks;
  });
  assert.deepEqual(
    fastScrollFrames.map(({ top }) => top),
    [6000, 11840, 4800, 0],
  );
  assert.ok(
    fastScrollFrames.every(({ filled, rails, gridPinned }) => filled && rails && gridPinned),
  );
  const target = 3809;
  const visit = async (top) => {
    await scroller.evaluate((node, offset) => {
      node.scrollTop = offset;
    }, top);
    await page.waitForFunction(() => {
      const viewport = document.querySelector('.track-table-scroll');
      const rect = viewport.getBoundingClientRect();
      const visible = [...viewport.querySelectorAll('.track-row')].filter((row) => {
        const box = row.getBoundingClientRect();
        return box.bottom > rect.top && box.top < rect.bottom;
      });
      return (
        viewport.dataset.scrolling === 'false' &&
        visible.length > 0 &&
        visible.every(
          (row) => row.querySelector('.status-band') && row.querySelector('svg.track-clip'),
        )
      );
    });
  };
  for (const offset of [600, 1200, 1800, 0]) await visit(offset);
  const warm = await scroller.evaluate(async (node) => {
    const frames = [];
    let denseMounts = 0;
    const observer = new MutationObserver((records) => {
      if (node.dataset.scrolling !== 'true') return;
      for (const record of records)
        for (const child of record.addedNodes) {
          if (
            child instanceof Element &&
            (child.matches('.status-band') || child.querySelector('.status-band'))
          )
            denseMounts++;
        }
    });
    observer.observe(node, { childList: true, subtree: true });
    let previous = performance.now();
    for (let frame = 1; frame <= 90; frame++) {
      node.scrollTop = frame <= 45 ? frame * 40 : (90 - frame) * 40;
      const now = await new Promise(requestAnimationFrame);
      frames.push(now - previous);
      previous = now;
    }
    observer.disconnect();
    const gridHeight = node.querySelector('.timeline-grid').clientHeight;
    return {
      denseMounts,
      p95Ms: frames.sort((a, b) => a - b)[85],
      gridHeight,
      viewportHeight: node.clientHeight,
      loadingAnimations: node
        .getAnimations({ subtree: true })
        .filter((animation) => animation.animationName === 'track-loading-sweep').length,
    };
  });
  console.log(JSON.stringify({ spanDays: days, warmedScroll: warm }));
  assert.equal(warm.denseMounts, 0, 'Cached detailed rows wait for the scroll to settle');
  assert.equal(warm.gridHeight, warm.viewportHeight, 'Calendar grid paint is viewport-sized');
  assert.equal(warm.loadingAnimations, 0, 'No timeline sweep runs during scrolling');
  await visit(0);
  const visibleSelector = '.track-table > .track-row';
  const viewportIds = () =>
    scroller.evaluate((node, selector) => {
      const viewport = node.getBoundingClientRect();
      return [...node.querySelectorAll(selector)]
        .filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > viewport.top && rect.top < viewport.bottom;
        })
        .map((row) => row.dataset.subjectId);
    }, visibleSelector);
  const assertRevealOrder = async (ids) => {
    await page.waitForFunction((length) => window.__trackRevealOrder.length >= length, ids.length);
    const result = await page.evaluate(() => ({
      ids: window.__trackRevealOrder,
      frames: window.__trackRevealFrames,
    }));
    assert.deepEqual(result.ids, ids);
    if (ids.length > 1) assert.ok(result.frames > 1, 'New rows reveal over multiple frames');
  };
  const observeReveal = (waitForScroll) =>
    scroller.evaluate((node, wait) => {
      const order = (window.__trackRevealOrder = []);
      window.__trackRevealFrames = 0;
      const interruptions = (window.__trackContinuityErrors = []);
      const visibleRows = () => {
        const viewport = node.getBoundingClientRect();
        return [...node.querySelectorAll('.track-row')].filter((row) => {
          const rect = row.getBoundingClientRect();
          return rect.bottom > viewport.top && rect.top < viewport.bottom;
        });
      };
      const retained = new Map(
        wait
          ? visibleRows().map((row) => [
              row.dataset.subjectId,
              row.querySelector('[data-track-state="ready"] .timeline-content'),
            ])
          : [],
      );
      const frame = () => {
        const visible = visibleRows();
        for (const row of visible) {
          const id = row.dataset.subjectId;
          if (!retained.has(id)) continue;
          const content = row.querySelector('[data-track-state="ready"] .timeline-content');
          if (
            content !== retained.get(id) ||
            !content ||
            Number(getComputedStyle(content).opacity) < 0.99
          )
            interruptions.push(id);
        }
        if (node.dataset.scrolling === 'true') wait = false;
        else if (!wait) {
          const entering = visible.filter((row) => !retained.has(row.dataset.subjectId));
          const previousLength = order.length;
          for (const row of entering) {
            const content = row.querySelector('[data-track-state="ready"] .timeline-content');
            if (
              content &&
              Number(getComputedStyle(content).opacity) > 0 &&
              !order.includes(row.dataset.subjectId)
            )
              order.push(row.dataset.subjectId);
          }
          if (order.length > previousLength) window.__trackRevealFrames++;
          if (order.length >= entering.length) return;
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    }, waitForScroll);
  const beforeCachedArrival = await viewportIds();
  await page.waitForFunction(
    (ids) =>
      ids.every((id) => {
        const content = document.querySelector(
          `.track-row[data-subject-id="${id}"] .timeline-content`,
        );
        return content && Number(getComputedStyle(content).opacity) === 1;
      }),
    beforeCachedArrival,
  );
  await observeReveal(true);
  await visit(80);
  const cachedArrival = await viewportIds();
  assert.ok(cachedArrival.some((id) => beforeCachedArrival.includes(id)));
  const entering = cachedArrival.filter((id) => !beforeCachedArrival.includes(id));
  assert.ok(entering.length > 0, 'The partial scroll exposes at least one new row');
  await assertRevealOrder(entering);
  assert.deepEqual(
    await page.evaluate(() => window.__trackContinuityErrors),
    [],
    'Rows that remain visible keep their loaded content fully visible during and after scrolling',
  );
  await visit(0);
  timelineGate = new Promise((resolve) => {
    releaseTimeline = resolve;
  });
  const beforeScroll = timelineReads.length;
  const smoothFrames = await scroller.evaluate(async (node, top) => {
    let previous = performance.now();
    const frameGaps = [];
    for (let i = 1; i <= 90; i++) {
      node.scrollTop = (top * i) / 90;
      const frame = await new Promise(requestAnimationFrame);
      frameGaps.push(frame - previous);
      previous = frame;
    }
    return frameGaps.sort((a, b) => a - b);
  }, target);
  assert.equal(
    timelineReads.length,
    beforeScroll,
    'Continuous scrolling must not start new timeline reads',
  );
  await page.waitForFunction((selector) => {
    const viewport = document.querySelector('.track-table-scroll').getBoundingClientRect();
    return [...document.querySelectorAll(selector)].some((node) => {
      const rect = node.getBoundingClientRect();
      return (
        rect.bottom > viewport.top &&
        rect.top < viewport.bottom &&
        node.querySelector('.track-cover')?.naturalWidth > 0
      );
    });
  }, visibleSelector);
  await scroller.locator('.track-row .recording-line').first().waitFor();
  await page.waitForFunction(
    () => document.querySelector('.track-table-scroll').dataset.scrolling === 'false',
  );
  assert.ok(coverPreloads.length > 0, 'Offscreen covers should use the local cache');
  const visibleIds = await viewportIds();
  assert.ok(await scroller.locator('.track-lane[aria-busy="true"]').count());
  const waitingLane = scroller.locator('.track-lane[data-track-state="loading"]').first();
  assert.ok(await waitingLane.count(), 'Settled rows with a pending request show loading feedback');
  await waitingLane.locator('.track-loading').waitFor();
  const rowId = await waitingLane.evaluate((lane) => lane.closest('.track-row').dataset.subjectId);
  const lane = scroller.locator(`.track-row[data-subject-id="${rowId}"] .track-lane`);
  assert.equal(
    await lane
      .locator('.track-loading')
      .evaluate((marker) => getComputedStyle(marker, '::after').animationName),
    'track-loading-sweep',
  );
  const beforeHydration = await lane.boundingBox();
  assert.equal(rowId, visibleIds[0]);
  firstTrackGate = {
    id: rowId,
    ready: new Promise((resolve) => {
      releaseFirstTrack = resolve;
    }),
  };
  const lowerResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    const ids = url.searchParams.get('ids')?.split(',') ?? [];
    return (
      url.pathname === '/api/workbench' &&
      response.ok() &&
      !ids.includes(rowId) &&
      ids.some((id) => visibleIds.includes(id))
    );
  });
  releaseTimeline();
  const lowerIds = new URL((await lowerResponse).url()).searchParams.get('ids').split(',');
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await lane.getAttribute('data-track-state'), 'loading');
  for (const id of lowerIds) {
    assert.equal(
      await scroller
        .locator(`[data-subject-id="${id}"] .track-lane`)
        .getAttribute('data-track-state'),
      'loading',
      'A faster lower row waits for the top batch',
    );
  }
  await observeReveal(false);
  releaseFirstTrack();
  await lane.locator('.track-clip').waitFor();
  assert.equal(await lane.getAttribute('aria-busy'), 'false');
  assert.equal(
    await lane
      .locator('.timeline-content')
      .evaluate((content) => getComputedStyle(content).animationName),
    'track-data-reveal',
  );
  await lane.locator('.track-loading').waitFor({ state: 'hidden' });
  assert.deepEqual(await lane.boundingBox(), beforeHydration, 'The tracks reveal in place');
  await assertRevealOrder(visibleIds);
  // A later heartbeat/render must not restore an obsolete row-quantized pixel offset.
  await page.waitForTimeout(5500);
  const settledReads = timelineReads.slice(beforeScroll).flat();
  assert.ok(settledReads.length > 0 && settledReads.every((id) => visibleIds.includes(id)));
  assert.equal(await scroller.evaluate((node) => node.scrollTop), target);
  const previousId = await scroller
    .locator(`.track-row[data-subject-id="${visibleIds[0]}"]`)
    .evaluate((row) => row.previousElementSibling?.dataset.subjectId);
  assert.ok(previousId && !settledReads.includes(previousId));
  firstTrackGate = {
    id: previousId,
    ready: new Promise((resolve) => {
      releaseFirstTrack = resolve;
    }),
  };
  await observeReveal(true);
  await scroller.evaluate((node, top) => {
    node.scrollTop = top;
  }, target - 72);
  const enteringLane = scroller.locator(`.track-row[data-subject-id="${previousId}"] .track-lane`);
  await enteringLane.locator('.track-loading').waitFor();
  const partialIds = await viewportIds();
  assert.equal(partialIds[0], previousId);
  for (const id of partialIds.slice(1)) {
    assert.ok(visibleIds.includes(id));
    assert.equal(
      await scroller
        .locator(`.track-row[data-subject-id="${id}"] .track-lane`)
        .getAttribute('data-track-state'),
      'ready',
      'An uncached row above the viewport does not block previously displayed rows',
    );
  }
  releaseFirstTrack();
  await assertRevealOrder([previousId]);
  assert.deepEqual(await page.evaluate(() => window.__trackContinuityErrors), []);
  await visit(target);
  const rows = await page.locator('.track-row').evaluateAll((nodes) =>
    nodes.map((node) => ({
      height: Math.round(node.getBoundingClientRect().height),
      surfaces: node.querySelectorAll('svg.track-clip').length,
      paths: node.querySelectorAll('svg.track-clip path').length,
    })),
  );
  assert.ok(rows.length > 0 && rows.length < 25, 'Only the visible neighborhood mounts');
  assert.ok(rows.every((row) => row.height === 72 && row.surfaces <= 1 && row.paths <= 15));
  assert.ok(
    rows.some((row) => row.paths > 0),
    'Scrolling retains loaded coverage',
  );
  await page.reload();
  await page.waitForFunction(
    (top) => document.querySelector('.track-table-scroll')?.scrollTop === top,
    target,
  );
  // An offline broadcaster losing its latest recording moves down the sort,
  // but the viewport must stay with the neighboring rows, not follow that ID.
  let movedId = null;
  await page.route('**/api/subjects', async (route) => {
    const response = await route.fetch();
    const subjects = await response.json();
    return route.fulfill({
      response,
      json: subjects.map((subject, index) => ({
        ...subject,
        providerStatus: 'OFFLINE',
        archived: false,
        lastRecordedAtMs: subject.id === movedId ? null : 1000000 - index,
      })),
    });
  });
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['subjects'] })),
  );
  await page.getByRole('button', { name: '离线', exact: true }).click();
  await scroller.evaluate((node, top) => {
    node.scrollTop = top;
  }, target);
  await page.waitForTimeout(300);
  movedId = await scroller.evaluate((node) => {
    const top = node.getBoundingClientRect().top + 1;
    return [...node.querySelectorAll('.track-row')]
      .find((row) => {
        const box = row.getBoundingClientRect();
        return box.top <= top && box.bottom > top;
      })
      ?.getAttribute('data-subject-id');
  });
  assert.ok(movedId);
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['subjects'] })),
  );
  await page.locator(`.track-row[data-subject-id="${movedId}"]`).waitFor({ state: 'detached' });
  assert.equal(await scroller.evaluate((node) => node.scrollTop), target);
  assert.deepEqual(errors, []);
  console.log(
    `[qa] Four large jumps keep row shells; 90 scroll frames (p95 ${smoothFrames[85].toFixed(1)}ms) defer reads, covers render during the gate, and heartbeat/reload retain the exact position`,
  );
} finally {
  releaseTimeline();
  releaseFirstTrack();
  await page?.unrouteAll({ behavior: 'wait' });
  await browser?.close();
  await fixture.close();
}
