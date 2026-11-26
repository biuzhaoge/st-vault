import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { build } from 'vite';
const styles = await Promise.all(
  [
    'apps/ui/src/design/tokens.css',
    'apps/ui/src/style.css',
    'apps/ui/src/design/liquid-glass.css',
  ].map((file) => readFile(file, 'utf8')),
);
const browser = await chromium.launch({
  executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
  headless: true,
});
try {
  const page = await browser.newPage();
  // Bundle the production component in memory. Layout, focus and selection changes
  // must exercise React's actual element identity, including the shell and outgoing decoration.
  const bundled = await build({
    configFile: false,
    logLevel: 'error',
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    plugins: [
      {
        name: 'snapshot-toolbar-fixture',
        resolveId(id) {
          if (id.endsWith('/snapshot-toolbar-fixture.js')) return id;
        },
        load(id) {
          if (!id.endsWith('/snapshot-toolbar-fixture.js')) return;
          return `
          import React from 'react';
          import { createRoot } from 'react-dom/client';
          import { flushSync } from 'react-dom';
          import { SnapshotToolbar } from '/apps/ui/src/features/snapshots/SnapshotToolbar.tsx';
          import { setLanguage } from '/apps/ui/src/shared/lib/i18n.ts';
          const root = createRoot(document.querySelector('main'));
          window.actions = [];
          window.setLanguage = setLanguage;
          window.renderToolbar = ({ state, status, busy = false, count = 6, total = 1234567, pages = 999999, pageIndex = 123455 }) =>
            flushSync(() => root.render(React.createElement(SnapshotToolbar, {
              total, pages, pageIndex, live: false, connected: true, busy, status,
              onPrevious: () => actions.push('previous'), onNext: () => actions.push('next'),
              onUnlike: () => actions.push('unlike-all'), onDelete: () => actions.push('delete'),
              selection: state && {
                count, onClear: state === 'keyboard' ? () => actions.push('clear') : undefined,
              },
            })));
        `;
        },
      },
    ],
    build: {
      write: false,
      lib: {
        entry: 'tests/e2e/snapshot-toolbar-fixture.js',
        name: 'ToolbarFixture',
        formats: ['iife'],
      },
    },
  });
  await page.setContent(
    `<style>${styles.join('\n')}</style><main style="display:flex;flex-direction:column;--snapshot-toolbar-height:26px"></main>`,
  );
  const compiled = [bundled].flat().flatMap((result) => result.output);
  await page.addScriptTag({ content: compiled.find((entry) => entry.type === 'chunk').code });
  const render = (props) => page.evaluate((props) => window.renderToolbar(props), props);
  const nav = page.locator('.snapshot-pages');
  const widthOf = async () => (await nav.boundingBox()).width;
  for (const width of [320, 600]) {
    await page.locator('main').evaluate((main, width) => {
      main.style.width = width + 'px';
    }, width);
    for (const english of [false, true]) {
      await page.evaluate((english) => window.setLanguage(english ? 'en' : 'zh-CN'), english);
      const clear = english ? 'Clear selection' : '清除选择';
      for (const state of [null, 'keyboard', 'drag']) {
        await render({ state, count: 1234567 });
        const result = await nav.evaluate((node) => {
          const row = node.querySelector('.snapshot-toolbar-controls');
          const box = node.getBoundingClientRect();
          const parent = node.parentElement.getBoundingClientRect();
          row.scrollLeft = 0;
          const first = row.firstElementChild.getBoundingClientRect();
          row.scrollLeft = row.scrollWidth;
          const last = row.lastElementChild.getBoundingClientRect();
          return {
            clipped: [...row.querySelectorAll('output,.snapshot-total')].some(
              (item) => item.scrollWidth > item.clientWidth + 1,
            ),
            firstVisible: first.left >= box.left - 1 && first.right <= box.right + 1,
            lastReachable: last.right <= box.right + 1,
            centered: Math.abs(box.left + box.right - parent.left - parent.right) <= 2,
            contained: box.width <= parent.width + 1,
            height: box.height,
            direction: getComputedStyle(row).flexDirection,
          };
        });
        assert.deepEqual(
          result,
          {
            clipped: false,
            firstVisible: true,
            lastReachable: true,
            centered: true,
            contained: true,
            height: 26,
            direction: 'row',
          },
          JSON.stringify({ width, english, state, result }),
        );
        assert.equal(await nav.locator('output').count(), state ? 0 : 1);
        const actions =
          state === 'keyboard'
            ? [[clear, 'clear']]
            : state === 'drag'
              ? []
              : [
                  [english ? 'Unlike all' : '取消所有喜欢', 'unlike-all'],
                  [english ? 'Delete unliked' : '删除所有非喜欢', 'delete'],
                ];
        assert.deepEqual(
          await nav
            .locator('.snapshot-actions button')
            .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('aria-label'))),
          actions.map(([name]) => name),
        );
        await page.evaluate(() => {
          window.actions = [];
        });
        for (const [name] of actions) await nav.getByRole('button', { name, exact: true }).click();
        assert.deepEqual(
          await page.evaluate(() => window.actions),
          actions.map(([, command]) => command),
        );
      }
      await render({ state: null });
      const ordinaryWidth = await widthOf();
      await render({ state: 'keyboard', count: 6 });
      const keyboardWidth = await widthOf();
      await render({ state: 'drag', count: 6 });
      const dragWidth = await widthOf();
      assert(
        ordinaryWidth > keyboardWidth && keyboardWidth > dragWidth,
        JSON.stringify({ width, english, ordinaryWidth, keyboardWidth, dragWidth }),
      );
      assert.equal(await nav.getByRole('button').count(), 0);

      // Count changes can resize the centered strip while Clear is held.
      for (const mode of ['commit', 'drag-away', 'disappear']) {
        await render({ state: 'keyboard' });
        const box = await nav.getByRole('button', { name: clear, exact: true }).boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.mouse.down();
        await page.evaluate(() => {
          window.actions = [];
        });
        await render({ state: mode === 'disappear' ? 'drag' : 'keyboard', count: 100000 });
        if (mode === 'drag-away') await page.mouse.move(box.x, box.y + box.height + 40);
        await page.mouse.up();
        assert.deepEqual(
          await page.evaluate(() => window.actions),
          mode === 'commit' ? ['clear'] : [],
        );
      }

      await render({ state: null });
      const previous = await nav.locator('.is-previous').boundingBox();
      await page.mouse.move(previous.x + previous.width / 2, previous.y + previous.height / 2);
      await page.mouse.down();
      await render({ state: null, status: '…', busy: true });
      await page.mouse.up();
      assert.deepEqual(await page.evaluate(() => window.actions), ['previous']);
      await render({ state: null });
      await nav.locator('.is-next').focus();
      await render({ state: 'keyboard' });
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute('aria-label')),
        clear,
      );
      await render({ state: 'drag' });
      assert(await nav.evaluate((n) => n === document.activeElement));
      await render({ state: null });
      assert(await nav.evaluate((n) => n.contains(document.activeElement)));
      await render({ state: 'keyboard' });
      await nav.getByRole('button', { name: clear, exact: true }).focus();
      await render({ state: null, pages: 1, pageIndex: 0 });
      assert(await nav.evaluate((n) => n === document.activeElement));
    }
  }

  for (const reducedMotion of ['no-preference', 'reduce']) {
    await page.emulateMedia({ reducedMotion });
    await render({ state: null });
    await page.waitForTimeout(350);
    await render({ state: 'drag' });
    const outgoing = await nav.locator('.snapshot-toolbar-echo').count();
    assert.equal(outgoing, reducedMotion === 'reduce' ? 0 : 1);
    if (outgoing) {
      const echo = nav.locator('.snapshot-toolbar-echo');
      assert(
        await echo.evaluate(
          (n) =>
            n.inert &&
            n.getAttribute('aria-hidden') === 'true' &&
            !n.querySelector('button, output'),
        ),
      );
    }
    await render({ state: null });
    await render({ state: 'keyboard' });
    await nav.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await page.waitForFunction(() => {
      const n = document.querySelector('.snapshot-pages');
      return (
        !n.querySelector('.snapshot-toolbar-echo') &&
        Math.abs(parseFloat(getComputedStyle(n, '::before').width) - n.offsetWidth) < 1
      );
    });
    assert.equal(await nav.locator('output').count(), 0);
  }
  for (const [columns, rows, width, height] of [
    [5, 6, 500, 700],
    [3, 10, 500, 700],
    [5, 6, 260, 210],
    [3, 10, 260, 210],
  ])
    for (const exiting of [false, true]) {
      const cells = Array.from(
        { length: 30 },
        (_, i) =>
          `<div class="${exiting ? 'snapshot-ghost' : 'snapshot-cell'}" data-liked="true" data-selected="true"><button data-unit-index="${i}" data-liked="true" aria-current="time" aria-pressed="true" class="selected"><div><span class="minute-image" style="background:${i % 2 ? '#e8e8e8' : '#222'}"></span></div><span class="snapshot-mark snapshot-favorite-mark"><svg class="ui-icon"></svg></span><span class="snapshot-mark snapshot-playing-mark"><svg class="ui-icon"></svg></span></button></div>`,
      ).join('');
      await page.setContent(
        `<style>${styles.join('\n')}</style><section class="snapshot-section" style="width:${width}px;height:${height}px;--snapshot-columns:${columns};--snapshot-rows:${rows};--snapshot-toolbar-height:0px;--snapshot-content-gap:0px"><div class="snapshot-viewport"><div class="${exiting ? 'snapshot-page-exit snapshot-exits' : 'snapshot-grid'}">${cells}</div></div></section>`,
      );
      const clipped = await page.locator('.snapshot-cell,.snapshot-ghost').evaluateAll((nodes) =>
        nodes.flatMap((node, index) => {
          const cell = node.getBoundingClientRect(),
            picture = node.querySelector('button > div').getBoundingClientRect();
          const border = getComputedStyle(node, '::before');
          const favorite = node.querySelector('.snapshot-favorite-mark');
          const playing = node.querySelector('.snapshot-playing-mark');
          const heart = favorite.getBoundingClientRect(),
            triangle = playing.getBoundingClientRect();
          const current = !node.matches('.snapshot-ghost');
          return picture.top < cell.top - 0.1 ||
            picture.bottom > cell.bottom + 0.1 ||
            picture.left < cell.left - 0.1 ||
            picture.right > cell.right + 0.1 ||
            parseFloat(border.borderTopWidth) < 2 ||
            border.borderTopStyle !== 'solid' ||
            border.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
            getComputedStyle(favorite).opacity !== '1' ||
            getComputedStyle(favorite).pointerEvents !== 'none' ||
            getComputedStyle(playing).opacity !== (current ? '1' : '0') ||
            heart.right > cell.right ||
            heart.top < cell.top ||
            heart.left < cell.left ||
            heart.right > cell.left + cell.width * 0.45 ||
            Math.abs(triangle.left + triangle.right - cell.left - cell.right) > 1 ||
            Math.abs(triangle.top + triangle.bottom - cell.top - cell.bottom) > 1 ||
            getComputedStyle(playing).pointerEvents !== 'none' ||
            heart.width < 6 ||
            triangle.height <= heart.height
            ? [index]
            : [];
        }),
      );
      assert.deepEqual(
        clipped,
        [],
        `The heart, selection outline and centered play badge fit their cells (${columns}x${rows}, exiting=${exiting})`,
      );
      if (exiting) {
        const badge = page.locator('.snapshot-playing-mark').first();
        assert(
          await badge.evaluate((node) => {
            // On a fast page turn the detached card can still carry its play animation.
            const pending = node.animate([{ opacity: 1 }, { opacity: 1 }], {
              duration: 340,
              fill: 'both',
            });
            try {
              return !node.checkVisibility({ opacityProperty: true, visibilityProperty: true });
            } finally {
              pending.cancel();
            }
          }),
          'A running play animation cannot reveal the previous page’s playing badge',
        );
      }
      // Sample the light tile away from its heart, selection border and central icon.
      const sample = page.locator('.minute-image').nth(1);
      const photo = await sample.boundingBox();
      const patch = (y) =>
        page.screenshot({
          clip: {
            x: Math.round(photo.x + photo.width * 0.74),
            y: Math.round(photo.y + photo.height * y),
            width: Math.max(1, Math.floor(photo.width * 0.04)),
            height: Math.max(1, Math.floor(photo.height * 0.04)),
          },
        });
      const top = await patch(0.21);
      const bottom = await patch(0.79);
      await sample.evaluate((node) => node.closest('button').removeAttribute('aria-current'));
      assert.deepEqual(await patch(0.21), top, 'The upper picture stays clear during playback');
      const restingBottom = await patch(0.79);
      if (exiting)
        assert.deepEqual(restingBottom, bottom, 'An exit ghost never paints a playing scrim');
      else
        assert.notDeepEqual(
          restingBottom,
          bottom,
          'Only the playing card shades the lower picture',
        );
      await page.locator('.snapshot-cell,.snapshot-ghost').evaluateAll((nodes) => {
        for (const n of nodes) {
          n.dataset.selected = 'false';
          const b = n.querySelector('button');
          b.dataset.liked = 'false';
          b.removeAttribute('aria-current');
        }
      });
      assert.deepEqual(
        await patch(0.79),
        restingBottom,
        'Favorite and selection alone preserve the photograph inside the border',
      );
    }
  console.log(
    'Large snapshot numbers: complete, single-row and reachable at 320/600px in both languages.',
  );
} finally {
  await browser.close();
}
