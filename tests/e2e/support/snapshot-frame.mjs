import assert from 'node:assert/strict';

/** Measure the painted icon and its position inside the actual card button in Chromium. */
export function snapshotMarks(button) {
  const bounds = button.getBoundingClientRect();
  const inspect = (selector) => {
    const mark = button.querySelector(selector);
    const path = mark?.querySelector('svg path');
    if (!path || !path.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
      return null;
    const box = mark.getBoundingClientRect();
    return {
      fill: getComputedStyle(path).fill,
      pointerEvents: getComputedStyle(mark).pointerEvents,
      top: box.top - bounds.top,
      right: bounds.right - box.right,
      bottom: bounds.bottom - box.bottom,
      left: box.left - bounds.left,
      width: box.width,
      height: box.height,
    };
  };
  return {
    favorite: inspect('.snapshot-favorite-mark'),
    playing: inspect('.snapshot-playing-mark'),
  };
}

/** Sample the compositor's picture transform and the hit target throughout one real gesture. */
export function watchSnapshotMotion(button) {
  const picture = button.querySelector(':scope > div');
  const frames = [],
    contacts = [];
  const box = button.getBoundingClientRect();
  let frame;
  const sample = () => {
    const transform = getComputedStyle(picture).transform;
    const matrix = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform);
    const bounds = button.getBoundingClientRect();
    const edge = getComputedStyle(button, '::after');
    return {
      at: performance.now(),
      scale: Math.hypot(matrix.a, matrix.b),
      degrees: (Math.atan2(matrix.b, matrix.a) * 180) / Math.PI,
      boxDelta: Math.max(...['x', 'y', 'width', 'height'].map((k) => Math.abs(bounds[k] - box[k]))),
      pressEdge:
        edge.content !== 'none' &&
        Number(edge.opacity) > 0 &&
        (edge.boxShadow !== 'none' ||
          parseFloat(edge.borderTopWidth) > 0 ||
          parseFloat(edge.outlineWidth) > 0),
    };
  };
  const record = (event) =>
    contacts.push({
      type: event.type,
      pointer: event.pointerType,
      trusted: event.isTrusted,
      ...sample(),
    });
  button.addEventListener('pointerdown', record, true);
  button.addEventListener('pointerup', record, true);
  const tick = () => {
    frames.push(sample());
    frame = requestAnimationFrame(tick);
  };
  tick();
  window.__snapshotMotion = {
    frames,
    contacts,
    finish() {
      cancelAnimationFrame(frame);
      button.removeEventListener('pointerdown', record, true);
      button.removeEventListener('pointerup', record, true);
      return { frames, contacts, settled: sample() };
    },
  };
}

/** Observe the playhead commit in the same clock as input and paint. */
export function watchSnapshotCommit(button) {
  const commits = [];
  const playhead = new MutationObserver((records) => {
    if (
      button.getAttribute('aria-current') === 'time' &&
      records.some((record) => record.oldValue !== 'time')
    )
      commits.push(performance.now());
  });
  playhead.observe(button, {
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ['aria-current'],
  });
  window.__readSnapshotCommits = () => {
    playhead.disconnect();
    return commits;
  };
}

export async function verifyDoubleDuringReturn(page, favoriteCard) {
  const target = await favoriteCard.getAttribute('data-key');
  // The previous page can still be sliding after its cards become ready.
  await favoriteCard.hover();
  const box = await favoriteCard.boundingBox();
  assert(box);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await favoriteCard.evaluate(watchSnapshotMotion);
  await page.mouse.click(point.x, point.y);
  // An ordinary fast click can deliver down and up before the next paint.
  await page
    .waitForFunction(
      () => {
        const { frames, contacts } = window.__snapshotMotion;
        const minScale = Math.min(...frames.map((f) => f.scale));
        const current = frames.at(-1).scale;
        return (
          contacts.length === 2 && minScale < 0.991 && current > minScale + 0.001 && current < 0.999
        );
      },
      undefined,
      { timeout: 2500 },
    )
    .catch(async (cause) => {
      const data = await page.evaluate(() => {
        const { frames, contacts } = window.__snapshotMotion;
        return { contacts, scales: frames.map((f) => f.scale), motions: window.__snapshotMotions };
      });
      throw Error(
        'The first tap must visibly shrink and return before the second tap: ' +
          JSON.stringify(data),
        { cause },
      );
    });
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(700);
  const trace = await page.evaluate(() => window.__snapshotMotion.finish());
  assert.deepEqual(
    trace.contacts.map((c) => c.type),
    ['pointerdown', 'pointerup', 'pointerdown', 'pointerup'],
  );
  assert(
    Math.min(...trace.frames.map((f) => f.scale)) < 0.99,
    'A fast first click visibly compresses the photograph',
  );
  assert(
    trace.frames.every((f) => f.boxDelta < 0.1),
    'The screenshot hit target stays in place throughout',
  );
  assert.equal(
    await favoriteCard
      .locator(':scope > div')
      .evaluate((picture) => getComputedStyle(picture).pointerEvents),
    'none',
    'A transformed photograph cannot capture a neighboring card click',
  );
  assert(Math.abs(trace.settled.scale - 1) < 0.001 && Math.abs(trace.settled.degrees) < 0.01);
  const motions = await page.evaluate(
    (key) => window.__snapshotMotions.filter((m) => m.key === key),
    target,
  );
  const shakes = motions.filter((m) => m.id === 'snapshot-gesture-favorite');
  assert.equal(shakes.length, 1, 'Only one favorite shake takes over the return');
  assert(
    Math.abs(shakes[0].frames[0].scale - trace.contacts[2].scale) < 0.01,
    'The shake starts at the scale reached by the returning card',
  );
  const angles = shakes[0].frames.map((f) => f.degrees);
  assert(Math.max(...angles) > 0.3 && Math.min(...angles) < -0.3, 'The photo rocks to both sides');
  assert(
    trace.frames.some((f) => Math.abs(f.degrees) > 0.15),
    'A tilted photograph reached a render frame',
  );
  console.log('[qa] Fast click into favorite', {
    contacts: trace.contacts.map((c) => c.scale),
    minimum: Math.min(...trace.frames.map((f) => f.scale)),
    angles,
    paintedAngles: [
      Math.min(...trace.frames.map((f) => f.degrees)),
      Math.max(...trace.frames.map((f) => f.degrees)),
    ],
    settled: trace.settled.scale,
  });
}
