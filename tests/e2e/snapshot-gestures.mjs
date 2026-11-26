import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';
import { outputRoot } from './support/media.mjs';
import {
  verifyDoubleDuringReturn,
  snapshotMarks,
  watchSnapshotMotion,
  watchSnapshotCommit,
} from './support/snapshot-frame.mjs';

const fixture = await startFixture();
let browser;
try {
  const history = await fixture.seedSnapshotHistory();
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, hasTouch: true });
  page.setDefaultTimeout(10_000);
  await page.addInitScript(() => {
    const animate = Element.prototype.animate;
    window.__snapshotFeedback = [];
    window.__snapshotMotions = [];
    Element.prototype.animate = function (...args) {
      const animation = animate.apply(this, args);
      if (animation.id.startsWith('snapshot-action-'))
        window.__snapshotFeedback.push([animation.id, this.closest('button')?.dataset.key]);
      if (animation.id.startsWith('snapshot-gesture-')) {
        const frames = animation.effect.getKeyframes().map(({ transform }) => {
          const matrix = new DOMMatrixReadOnly(
            transform && transform !== 'none' ? transform : undefined,
          );
          return {
            scale: Math.hypot(matrix.a, matrix.b),
            degrees: (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI,
          };
        });
        window.__snapshotMotions.push({
          id: animation.id,
          key: this.closest('button')?.dataset.key,
          frames,
        });
      }
      return animation;
    };
  });
  await page.addInitScript(() =>
    document.addEventListener(
      'playing',
      (event) => {
        if (event.target instanceof HTMLVideoElement) event.target.pause();
      },
      true,
    ),
  );
  const errors = [],
    writes = [],
    seeks = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (request.method() !== 'POST') return;
    const target = new URL(request.url()).pathname;
    if (target.endsWith('/unit-favorites')) writes.push(request.postDataJSON());
    if (target === '/api/playback') seeks.push(request);
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:' + fixture.info.port);
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  const row = page.locator(`.track-row[data-subject-id="${fixture.info.subjectId}"]`);
  const lane = row.locator('.track-lane');
  await lane.waitFor();
  if (history.fromMs < Number(await lane.getAttribute('data-from')))
    await page.getByRole('slider', { name: '视窗起点', exact: true }).press('ArrowLeft');
  const box = await lane.boundingBox();
  await page.mouse.move(box.x + 1, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + 40, { steps: 6 });
  await page.mouse.up();
  const cards = page.locator('.snapshot-grid .snapshot-cell button[data-unit-index]');
  const toolbar = page.locator('.snapshot-actions');
  const viewport = page.locator('.snapshot-viewport');
  const action = (name) => toolbar.getByRole('button', { name, exact: true });
  const actions = (...names) =>
    page.waitForFunction((expected) => {
      const actual = [...document.querySelectorAll('.snapshot-actions button')]
        .filter((button) => button.checkVisibility({ visibilityProperty: true }))
        .map((button) => button.getAttribute('aria-label') ?? button.textContent.trim())
        .sort();
      return actual.length === expected.length && actual.every((name, i) => name === expected[i]);
    }, names.sort());
  const selectedIds = () =>
    cards
      .and(page.locator('[aria-pressed="true"]'))
      .evaluateAll((nodes) => nodes.map((node) => node.dataset.key));
  const firstKeys = [];
  const pageReady = (n) =>
    page.waitForFunction(
      ({ n, first }) =>
        (first
          ? document.querySelector('.snapshot-grid button[data-key]')?.dataset.key === first
          : document.querySelector('.snapshot-pages output')?.textContent === n + ' / 3') &&
        document.querySelector('.snapshot-grid')?.getAttribute('aria-busy') === 'false' &&
        document.querySelectorAll('.snapshot-grid button[data-favorite-ready="true"]').length ===
          30,
      { n, first: firstKeys[n] },
    );
  const midpoint = async (card) => {
    const rect = await card.boundingBox();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  };
  const move = async (index) => {
    const point = await midpoint(cards.nth(index));
    await page.mouse.move(point.x, point.y, { steps: 4 });
  };
  const startDrag = async (from, ...through) => {
    await move(from);
    await page.mouse.down();
    for (const index of through) await move(index);
  };
  await page.waitForFunction(() =>
    /^1\s*\/\s*3$/.test(document.querySelector('.snapshot-pages output')?.textContent ?? ''),
  );
  await page.waitForFunction(
    () => document.querySelector('video[data-media-slot="active"]')?.readyState >= 2,
  );
  await page.locator('video[data-media-slot="active"]').evaluate((node) => node.pause());
  const key = async (index) => cards.nth(index).getAttribute('data-key');
  // Establish the two page identities while the ordinary pagination controls are present.
  await pageReady(1);
  firstKeys[1] = await key(0);
  await page.evaluate(() => {
    const ids = [],
      original = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
      const animation = original.apply(this, args);
      if (this.closest('.snapshot-section') && /^(snapshot-page-|media-layout)/.test(animation.id))
        ids.push(animation.id);
      return animation;
    };
    window.__snapshotPageMotion = {
      ids,
      restore: () => {
        Element.prototype.animate = original;
      },
    };
  });
  const setMotion = async (reducedMotion) => {
    await page.emulateMedia({ reducedMotion });
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  };
  await setMotion('reduce');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await pageReady(2);
  assert.deepEqual(
    await page.evaluate(() => window.__snapshotPageMotion.ids),
    [],
    'Reduced motion changes actual pages without moving the grid or its cards',
  );
  firstKeys[2] = await key(0);
  assert.notEqual(firstKeys[1], firstKeys[2]);
  await setMotion('no-preference');
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await pageReady(1);
  assert(
    (
      await page.evaluate(() => {
        window.__snapshotPageMotion.restore();
        return window.__snapshotPageMotion.ids;
      })
    ).includes('snapshot-page-enter'),
    'Normal motion still slides the page',
  );
  const currentKey = () =>
    page.locator('.snapshot-cell button[aria-current="time"]').getAttribute('data-key');
  const before = await currentKey();
  const target = await key(4);
  assert.notEqual(target, before);
  const seekCount = seeks.length;
  await verifyDoubleDuringReturn(page, cards.nth(4));
  assert.equal(writes.length, 1, 'A double click must issue exactly one favorite command');
  assert.deepEqual(writes[0].unitIds, [target]);
  assert.equal(await currentKey(), before, 'Neither click of a double click may seek');
  assert.equal(seeks.length, seekCount);
  await pageReady(1);
  const archiveDir = process.env.STV_QA_GESTURE_ARTIFACTS ?? outputRoot;
  await mkdir(archiveDir, { recursive: true });
  const all = await cards.evaluateAll((nodes) => nodes.map((node) => node.dataset.key));
  await Promise.all(
    [2, 3, 4].map((index) => cards.nth(index).locator('img').waitFor({ timeout: 60_000 })),
  );
  const liked = await cards.nth(4).evaluate(snapshotMarks);
  assert.ok(liked.favorite);
  assert.equal(liked.playing, null);
  await viewport.screenshot({ path: path.join(archiveDir, 'snapshot-favorite.png') });
  const singlePress = async (card, pointer, down, up) => {
    const key = await card.getAttribute('data-key');
    const before = seeks.length;
    const point = await midpoint(card);
    await card.evaluate(watchSnapshotMotion);
    await card.evaluate(watchSnapshotCommit);
    if (pointer === 'touch') {
      // Do not let a test-controller round trip turn a short contact into a long press.
      await Promise.all([down(point), up()]);
    } else {
      await down(point);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      await up();
    }
    await page.waitForFunction((id) => {
      const b = document.querySelector('.snapshot-grid button[aria-current="time"]');
      return b?.dataset.key === id;
    }, key);
    const commits = await page.evaluate(() => window.__readSnapshotCommits());
    const { frames, contacts, settled } = await page.evaluate(() =>
      window.__snapshotMotion.finish(),
    );
    assert.deepEqual(
      contacts.map((event) => [event.type, event.pointer, event.trusted]),
      [
        ['pointerdown', pointer, true],
        ['pointerup', pointer, true],
      ],
    );
    const [press, release] = contacts;
    const heldMs = release.at - press.at;
    if (pointer === 'touch') assert(heldMs >= 0 && heldMs < 350, 'The two inputs must form a tap');
    assert.equal(commits.length, 1, 'The target becomes current once');
    const confirmedAt = commits[0];
    const pressFrames = frames.filter((frame) => frame.at >= press.at && frame.at <= confirmedAt);
    assert(pressFrames.length > 0, 'Capture a frame during the click or rebound');
    assert(
      [...contacts, ...pressFrames].every((frame) => !frame.pressEdge),
      'A single press and its rebound never draw an outline',
    );
    assert((await card.evaluate(snapshotMarks)).playing, 'The current screenshot shows playback');
    if (pointer === 'mouse') {
      assert(
        pressFrames.some((f) => f.scale < 0.99),
        'A single mouse press shrinks the photograph',
      );
      assert(
        frames.every((f) => Math.abs(f.degrees) < 0.05),
        'A single click never shakes',
      );
      assert(Math.abs(settled.scale - 1) < 0.002, 'The photograph returns as playback starts');
    } else {
      assert(
        frames.every((f) => Math.abs(f.scale - 1) < 0.001 && Math.abs(f.degrees) < 0.01),
        'Reduced motion leaves the photograph at its original size throughout',
      );
    }
    assert(confirmedAt >= release.at, 'The press alone never changes the playhead');
    const writes = seeks.slice(before);
    assert(
      writes.length <= 1 && writes.every((request) => request.postDataJSON().unitId === key),
      'A local media seek needs no new session. Any playback request must target this unit',
    );
    console.log('[qa] Borderless click feedback (ms)', pointer, {
      held: Math.round(heldMs),
      frames: pressFrames.length,
      releaseToCommit: Math.round(confirmedAt - release.at),
    });
  };
  await singlePress(
    cards.nth(3),
    'mouse',
    async ({ x, y }) => {
      await page.mouse.move(x, y);
      await page.mouse.down();
    },
    () => page.mouse.up(),
  );
  assert(liked.favorite.left < liked.favorite.right);
  await page.waitForTimeout(400);
  assert.equal(writes.length, 1, 'A single click must not toggle a favorite');
  const stableSeeks = seeks.length;
  const favoriteReply = () =>
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/unit-favorites') && response.request().method() === 'POST',
    );
  const waitLikes = (ids, liked) =>
    page.waitForFunction(
      ({ ids, liked }) => {
        const expected = new Set(liked);
        const buttons = new Map(
          [...document.querySelectorAll('.snapshot-grid button[data-key]')].map((button) => [
            button.dataset.key,
            button,
          ]),
        );
        return (
          !document.querySelector('.snapshot-pages[aria-busy="true"]') &&
          ids.every(
            (id) => !buttons.has(id) || buttons.get(id).dataset.liked === String(expected.has(id)),
          )
        );
      },
      { ids, liked },
    );
  const commitDrag = async (ids, liked, release = () => page.mouse.up()) => {
    const before = writes.length;
    const response = favoriteReply();
    await release();
    const reply = await response;
    assert.equal(reply.status(), 200);
    const request = reply.request().postDataJSON();
    assert.equal(request.liked, 'toggle');
    assert.deepEqual([...request.unitIds].sort(), [...ids].sort());
    assert.deepEqual(
      (await reply.json()).favorites.map((item) => item.id).sort(),
      [...liked].sort(),
    );
    await waitLikes(ids, liked);
    await actions('取消所有喜欢', '删除所有非喜欢');
    assert.deepEqual(await selectedIds(), []);
    assert.equal(writes.length, before + 1, 'A drag release submits exactly one batch');
    assert.equal(seeks.length, stableSeeks);
  };

  await startDrag(2, 4);
  assert.deepEqual(await selectedIds(), all.slice(2, 5));
  await actions();
  assert.equal(await page.locator('.snapshot-total').textContent(), '已选 3 项');
  assert.equal(writes.length, 1, 'Dragging only previews the range until release');
  const [both, selected, playing] = await Promise.all(
    [4, 2, 3].map((i) => cards.nth(i).evaluate(snapshotMarks)),
  );
  assert.equal(both.favorite?.fill, liked.favorite.fill);
  assert.equal(selected.favorite, null);
  assert.equal(playing.playing?.fill, 'rgb(114, 218, 179)');
  assert.equal(playing.favorite, null);
  assert.deepEqual(
    await cards.nth(4).evaluate((button) => {
      const frame = getComputedStyle(button.parentElement, '::before');
      return [
        frame.borderTopColor,
        frame.borderStyle,
        parseFloat(frame.borderTopWidth),
        frame.backgroundColor,
      ];
    }),
    [liked.favorite.fill, 'solid', 2, 'rgba(0, 0, 0, 0)'],
    'The live drag outline matches the favorite heart',
  );
  await viewport.screenshot({ path: path.join(archiveDir, 'snapshot-selection-mixed.png') });
  await commitDrag(all.slice(2, 5), all.slice(2, 4));
  const combined = await cards.nth(3).evaluate(snapshotMarks);
  assert.equal(combined.favorite?.fill, liked.favorite.fill);
  assert.equal(combined.playing?.fill, playing.playing.fill);
  await startDrag(4, 1, 2);
  assert.deepEqual(await selectedIds(), all.slice(2, 5), 'Reversing restores the retracting edge');
  await viewport.screenshot({ path: path.join(archiveDir, 'snapshot-three-states.png') });
  await commitDrag(all.slice(2, 5), [all[4]]);
  assert.equal(await cards.nth(1).getAttribute('data-liked'), 'false');

  const beforeEscape = writes.length;
  await startDrag(2, 5);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await actions('取消所有喜欢', '删除所有非喜欢');
  assert.deepEqual(await selectedIds(), []);
  assert.equal(writes.length, beforeEscape);

  // The browser's compatibility click after a native touch drag cannot seek.
  const cdp = await page.context().newCDPSession(page);
  const touch = (type, point) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: point ? [point] : [] });
  await touch('touchStart', await midpoint(cards.nth(10)));
  await page.waitForFunction(
    () => document.querySelector('.snapshot-viewport')?.dataset.selecting === 'true',
  );
  assert.equal(
    await cards
      .nth(10)
      .locator(':scope > div')
      .evaluate((picture) => getComputedStyle(picture).transform),
    'none',
    'A long press hands control to range selection and restores the photograph',
  );
  await touch('touchMove', await midpoint(cards.nth(12)));
  await commitDrag(all.slice(10, 13), all.slice(10, 13), () => touch('touchEnd'));
  assert.equal(await currentKey(), all[3]);
  assert.equal(seeks.length, stableSeeks);

  // A stationary captured pointer reaches the next page after a dwell.
  const edge = await viewport.boundingBox();
  await viewport.evaluate((node, firstKeys) => {
    const changes = [];
    let lastEdge;
    const sample = () => {
      const direction = node.dataset.edge ?? '';
      const visiblePage = firstKeys.indexOf(
        node.querySelector('.snapshot-grid button[data-key]')?.dataset.key,
      );
      if (direction !== lastEdge || changes.at(-1)?.page !== visiblePage)
        changes.push({ direction, page: visiblePage, at: performance.now() });
      lastEdge = direction;
    };
    const observer = new MutationObserver(sample);
    observer.observe(node.closest('.snapshot-section'), {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-edge'],
      characterData: true,
      childList: true,
    });
    window.__gesturePageTrace = changes;
    sample();
  }, firstKeys);
  const reachedPage = (n) =>
    page.waitForFunction(
      (first) => document.querySelector('.snapshot-grid button[data-key]')?.dataset.key === first,
      firstKeys[n],
    );
  const wheelPage = async (direction, to) => {
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await page.mouse.wheel(0, direction * 100);
    await pageReady(to);
  };
  const settlePage = async (n) => {
    // A held edge can turn another page while the first page's favorites load.
    await reachedPage(n);
    await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
    await pageReady(n);
    await page.waitForFunction(() =>
      document
        .querySelector('.snapshot-grid')
        ?.getAnimations()
        .every((a) => a.id !== 'snapshot-page-enter'),
    );
  };
  const assertDwell = async (start, from, direction, to) => {
    // The edge clears at the page limit before a delayed test reader can sample it.
    const trace = await page.evaluate((start) => window.__gesturePageTrace.slice(start), start);
    const entered = trace.find((e) => e.page === from && e.direction === direction);
    const paged = trace.find((e) => e.page === to);
    assert(
      entered && paged && paged.at - entered.at >= 360,
      'A visible edge dwell precedes the turn: ' + JSON.stringify(trace),
    );
  };
  await move(27);
  await page.mouse.down();
  await move(28);
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height - 2, { steps: 4 });
  await settlePage(2);
  await assertDwell(0, 1, 'next', 2);
  await move(2);
  const next = await cards.evaluateAll((nodes) => nodes.map((node) => node.dataset.key));
  assert.equal(next[0], firstKeys[2], 'The captured units belong to the second page');
  assert.equal(new Set([...all, ...next]).size, all.length + next.length);
  assert.deepEqual(await selectedIds(), next.slice(0, 3));
  const across = [...all.slice(27), ...next.slice(0, 3)];
  await commitDrag(across, across);
  await wheelPage(-1, 1);
  await waitLikes(all.slice(27), all.slice(27));
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await settlePage(2);
  const reverseStart = await page.evaluate(() => window.__gesturePageTrace.length);
  await move(2);
  await page.mouse.down();
  await move(1);
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 2, { steps: 4 });
  await settlePage(1);
  await assertDwell(reverseStart, 2, 'previous', 1);
  await move(27);
  assert.deepEqual(await selectedIds(), all.slice(27));
  await commitDrag(across, []);
  // Reverse the very same held pointer across the boundary. The second page
  // was visited and selected, so shrinking back must omit it from the command.
  await settlePage(1);
  await move(26);
  await page.mouse.down();
  await move(27);
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height - 2);
  await settlePage(2);
  await move(8);
  assert.deepEqual(await selectedIds(), next.slice(0, 9));
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 2);
  await settlePage(1);
  await move(25);
  await move(27);
  assert.deepEqual(await selectedIds(), all.slice(26, 28));
  await commitDrag(all.slice(26, 28), all.slice(26, 28));
  await wheelPage(1, 2);
  await waitLikes(next.slice(0, 9), []);
  assert.equal(seeks.length, stableSeeks, 'Selection and both edge dwells never start playback');
  // Touch capture must survive a page change without producing a synthetic seek.
  await settlePage(2);
  await touch('touchStart', await midpoint(cards.nth(2)));
  await page.waitForFunction(
    () => document.querySelector('.snapshot-viewport')?.dataset.selecting === 'true',
  );
  await touch('touchMove', { x: edge.x + edge.width / 2, y: edge.y + 2 });
  await reachedPage(1);
  await touch('touchMove', { x: edge.x + edge.width / 2, y: edge.y + edge.height / 2 });
  await pageReady(1);
  await page.waitForFunction(() =>
    document
      .querySelector('.snapshot-grid')
      ?.getAnimations()
      .every((a) => a.id !== 'snapshot-page-enter'),
  );
  await touch('touchMove', await midpoint(cards.nth(28)));
  // Chromium can coalesce a move until the next frame. Wait for the range
  // preview to reflect the final touch position before releasing it.
  await page.waitForFunction((ids) => {
    const selected = Array.from(
      document.querySelectorAll('.snapshot-grid button[aria-pressed="true"]'),
      (button) => button.dataset.key,
    );
    return selected.length === ids.length && selected.every((id, index) => id === ids[index]);
  }, all.slice(28));
  const touchAcross = [...all.slice(28), ...next.slice(0, 3)];
  await commitDrag(touchAcross, touchAcross, () => touch('touchEnd'));
  const doubleCard = cards.nth(28);
  await doubleCard.press('Shift+Space');
  await actions('清除选择');
  const finger = { ...(await midpoint(doubleCard)), id: 1 };
  assert.equal(
    await page.evaluate(
      () => window.__snapshotMotions.filter((m) => m.id === 'snapshot-gesture-favorite').length,
    ),
    1,
    'Dragging, paging and bulk favorite actions do not shake a photograph',
  );
  await page.evaluate(() => {
    window.__touchFavorite = [];
    for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick'])
      document.addEventListener(
        type,
        (event) => {
          const b = event.target.closest('button[data-key]');
          window.__touchFavorite.push({
            type,
            at: event.timeStamp,
            x: event.clientX,
            y: event.clientY,
            detail: event.detail,
            trusted: event.isTrusted,
            pointer: event.pointerType,
            unit: b?.dataset.key,
            ready: b?.dataset.favoriteReady,
            selected: b?.getAttribute('aria-pressed'),
            liked: b?.dataset.liked,
            target: event.target.className || event.target.tagName,
          });
        },
        true,
      );
  });
  const beforeTouchDouble = writes.length;
  const touchWrite = page.waitForResponse(
    (r) => r.request().method() === 'POST' && r.url().endsWith('/unit-favorites'),
    { timeout: 5_000 },
  );
  const [tapReply] = await Promise.all([
    touchWrite,
    // Queue both native contacts on the same CDP session before awaiting their acknowledgments.
    touch('touchStart', finger),
    touch('touchEnd'),
    touch('touchStart', finger),
    touch('touchEnd'),
  ]).catch(async (cause) => {
    const events = await page.evaluate(() => window.__touchFavorite);
    throw Error(
      'Two real taps on a selected card must toggle only the favorite: ' + JSON.stringify(events),
      { cause },
    );
  });
  assert.equal(tapReply.status(), 200);
  assert.deepEqual(tapReply.request().postDataJSON().unitIds, [all[28]]);
  assert.equal(tapReply.request().postDataJSON().liked, false);
  await page.waitForTimeout(600);
  const contacts = await page.evaluate(() =>
    window.__touchFavorite.filter((e) => e.type === 'pointerdown' || e.type === 'pointerup'),
  );
  assert.deepEqual(
    contacts.map((e) => [e.type, e.trusted, e.pointer, e.unit]),
    ['pointerdown', 'pointerup', 'pointerdown', 'pointerup'].map((type) => [
      type,
      true,
      'touch',
      all[28],
    ]),
  );
  assert.ok(contacts.every((e) => e.x === contacts[0].x && e.y === contacts[0].y));
  for (const i of [0, 1]) {
    const gap = contacts[i + 2].at - contacts[i].at;
    assert.ok(
      gap >= 0 && gap <= 300,
      `Two native ${contacts[i].type} events arrived ${gap} ms apart`,
    );
  }
  assert.deepEqual(await selectedIds(), [all[28]], 'Double tapping keeps the keyboard selection');
  assert.equal(await currentKey(), all[3]);
  assert.equal(seeks.length, stableSeeks);
  assert.equal(writes.length, beforeTouchDouble + 1);
  assert.deepEqual(
    await page.evaluate(() =>
      window.__snapshotMotions
        .filter((m) => m.id === 'snapshot-gesture-favorite')
        .map((m) => m.key),
    ),
    [target, all[28]],
    'The touch double tap also rocks the correct photograph when removing a favorite',
  );
  assert.deepEqual(await page.evaluate(() => window.__snapshotFeedback), [
    ['snapshot-action-favorite', all[4]],
    ['snapshot-action-play', all[3]],
    ['snapshot-action-unfavorite', all[28]],
  ]);
  await action('清除选择').click();
  await wheelPage(1, 2);
  assert.deepEqual(await selectedIds(), []);
  assert.deepEqual(errors, []);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const ordinaryMotionCount = await page.evaluate(() => window.__snapshotMotions.length);
  const reducedUnit = await key(5);
  const reducedCard = cards.nth(5);
  const wasLiked = await reducedCard.getAttribute('data-liked');
  await reducedCard.dblclick();
  await page.waitForFunction(
    ({ id, wasLiked }) => {
      const button = document.querySelector(`.snapshot-grid button[data-key="${id}"]`);
      return (
        button && button.dataset.liked !== wasLiked && button.getAttribute('aria-busy') !== 'true'
      );
    },
    { id: reducedUnit, wasLiked },
  );
  await page.emulateMedia({ forcedColors: 'active' });
  await singlePress(
    reducedCard,
    'touch',
    (point) => touch('touchStart', point),
    () => touch('touchEnd'),
  );
  await page.emulateMedia({ forcedColors: 'none' });
  assert.equal(await page.evaluate(() => window.__snapshotFeedback.length), 3);
  assert.equal(
    await page.evaluate(() => window.__snapshotMotions.length),
    ordinaryMotionCount,
    'Reduced motion keeps input and favorite feedback still',
  );
  await setMotion('no-preference');
  const priorWrites = writes.length;
  const motionStart = await page.evaluate(() => window.__snapshotMotions.length);
  const one = await key(7),
    two = await key(8);
  for (const index of [7, 8]) {
    const { x, y } = await midpoint(cards.nth(index));
    await page.mouse.click(x, y);
  }
  await page.waitForFunction(
    (id) =>
      document.querySelector('.snapshot-grid button[aria-current="time"]')?.dataset.key === id,
    two,
  );
  const crossTarget = await page.evaluate(
    (from) => window.__snapshotMotions.slice(from).map((m) => [m.id, m.key]),
    motionStart,
  );
  assert.deepEqual(
    crossTarget.filter(([id]) => id === 'snapshot-gesture-press').map(([, key]) => key),
    [one, two],
  );
  assert(!crossTarget.some(([id]) => id === 'snapshot-gesture-favorite'));
  assert.equal(
    writes.length,
    priorWrites,
    'Consecutive clicks on different cards never form a favorite gesture',
  );
  await page.keyboard.press('Tab');
  assert(
    await cards
      .nth(9)
      .evaluate(
        (button) =>
          button.matches(':focus-visible') && getComputedStyle(button).outlineStyle === 'solid',
      ),
    'Keyboard navigation still shows the focus outline',
  );
  assert.deepEqual(errors, []);
  console.log(
    '[qa] Chromium verified distinct click and double click, painted favorite and selection states, exact selected commands, touch consumption, range inversion and bidirectional page dwell.',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
