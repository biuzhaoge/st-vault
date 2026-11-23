import assert from 'node:assert/strict';
import { holdPlayerControls } from './support/player-chrome.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';

const fixture = await startFixture();
let browser;
const problems = [],
  checks = [];
const geometry = new Map();
let tasksRunning = true;
const english = JSON.parse(await readFile('apps/ui/src/locales/en.json', 'utf8'));
try {
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (error) => problems.push({ panel: 'runtime', issues: [error.message] }));
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  await page.goto('http://127.0.0.1:10085');
  for (const [width, height] of [
    [390, 844],
    [844, 390],
    [1024, 599],
    [768, 1024],
    [1800, 600],
  ]) {
    await page.setViewportSize({ width, height });
    await page.getByRole('heading', { name: '当前窗口尺寸不受支持' }).waitFor();
    assert.equal(
      await page.locator('.viewport-workspace').evaluate((node) => getComputedStyle(node).display),
      'none',
    );
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await page.locator('.track-row').first().waitFor();
  const syntheticName = 'synthetic-layout-fixture';
  const syntheticKey = '0123456789abcdef'.repeat(4);
  await page.route('**/api/keys/current', (route) =>
    route.fulfill({
      json: {
        key: { name: syntheticName, value: syntheticKey },
        status: 'usable',
        checking: false,
        keyCount: 1,
      },
    }),
  );
  await page.route('**/api/network/routes', async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    data.sites.probing = true;
    data.sites.probeProgress = { completed: 12, total: 34 };
    await route.fulfill({ response, json: data });
  });
  await page.route('**/api/system', async (route) => {
    const response = await route.fetch(),
      data = await response.json(),
      now = Date.now();
    data.backgroundTasks = [
      { id: 'capture-status', group: 'sync', state: 'running', processed: 121, total: 300 },
      { id: 'account-list', group: 'sync', state: 'waiting', nextRunAtMs: now + 5000 },
      { id: 'cover-sync', group: 'sync', state: 'idle', lastSuccessAtMs: now - 10000 },
      {
        id: 'avatar-sync',
        group: 'sync',
        state: 'waiting',
        nextRunAtMs: now + 30000,
      },
      {
        id: 'site-access',
        group: 'sync',
        state: 'running',
        processed: 12,
        total: 34,
        target: 'aznudelive.com',
        detail: 'account-bound',
      },
      {
        id: 'archive-index',
        group: 'processing',
        state: 'running',
        processed: 4096,
        detail: 'index-batches',
      },
      {
        id: 'orphan-sweep',
        group: 'processing',
        state: 'idle',
        processed: 3000,
        detail: 'checked-files',
      },
      { id: 'snapshots', group: 'processing', state: 'running', processed: 129, pending: 963 },
      {
        id: 'snapshot-maintenance',
        group: 'processing',
        state: 'waiting',
        detail: 'bounded-audit',
      },
      {
        id: 'deletion',
        group: 'processing',
        state: 'paused',
        pending: 12,
        error: 'deletion_retry',
      },
      { id: 'disk-check', group: 'protection', state: 'idle', lastSuccessAtMs: now },
      { id: 'retention', group: 'protection', state: 'disabled' },
      {
        id: 'integrity-scan',
        group: 'protection',
        state: 'idle',
        processed: 16,
        nextRunAtMs: now + 60000,
      },
      { id: 'run-heartbeat', group: 'protection', state: 'idle', lastSuccessAtMs: now },
      { id: 'client-sync', group: 'sync', state: 'waiting', nextRunAtMs: now + 5000 },
    ];
    data.capturedAtMs = now;
    if (!tasksRunning)
      data.backgroundTasks = data.backgroundTasks.map((task) =>
        task.state === 'running' ? { ...task, state: 'idle' } : task,
      );
    data.ingress = { subjects: 128, retainedBytes: 256 * 1024 ** 2, maxBytes: 1024 ** 3 };
    data.capture = {
      ...data.capture,
      active: 128,
      starting: tasksRunning ? 3 : 0,
      retrying: tasksRunning ? 2 : 0,
    };
    data.disk = { freeBytes: 7 * 1024 ** 3, totalBytes: 10 * 1024 ** 3, lowSpace: false };
    await route.fulfill({ response, json: data });
  });
  for (const language of ['zh-CN', 'en']) {
    await page.evaluate((value) => localStorage.setItem('stv-language', value), language);
    await page.reload();
    await page.locator('.track-row').first().waitFor();
    for (const width of [1280, 1024, 768]) {
      await page.setViewportSize({ width, height: 720 });
      const directory = await page.evaluate(() => {
        const label = document.querySelector('.track-label');
        const cell = label.getBoundingClientRect();
        const cover = label.querySelector('.track-cover-wrap').getBoundingClientRect();
        const style = getComputedStyle(label);
        const gaps = [
          cover.left - cell.left - parseFloat(style.borderLeftWidth),
          cell.right - cover.right - parseFloat(style.borderRightWidth),
          cover.top - cell.top - parseFloat(style.borderTopWidth),
          cell.bottom - cover.bottom - parseFloat(style.borderBottomWidth),
        ];
        const filters = [...document.querySelectorAll('.subject-filters button')].map((button) => {
          const name = [...button.querySelectorAll('.filter-label,.filter-label-compact')]
            .find((label) => label.getClientRects().length)
            ?.getBoundingClientRect();
          const count = button.querySelector('.filter-count')?.getBoundingClientRect();
          const bounds = button.getBoundingClientRect();
          return Boolean(
            name &&
            name.left >= bounds.left &&
            name.right <= bounds.right &&
            (!count ||
              (count.left >= name.right &&
                Math.abs(count.top + count.height / 2 - name.top - name.height / 2) < 1 &&
                count.left >= bounds.left &&
                count.right <= bounds.right)),
          );
        });
        const account = document.querySelector('.directory').getBoundingClientRect();
        const filterBar = document.querySelector('.subject-filters').getBoundingClientRect();
        const navigation = document.querySelector('.time-control-row').getBoundingClientRect();
        const rightButton = document.querySelector('.day-step:last-child').getBoundingClientRect();
        const header = document.querySelector('.track-header-viewport').getBoundingClientRect();
        const ruler = document
          .querySelector('.time-ruler-row .timeline-ruler')
          .getBoundingClientRect();
        const lane = label.nextElementSibling.getBoundingClientRect();
        return {
          gaps,
          width: cell.width,
          filters,
          headerWidth: account.width,
          placement:
            filterBar.left >= account.right &&
            navigation.left >= filterBar.right &&
            rightButton.right <= header.right + 1 &&
            Math.abs(lane.left - ruler.left) < 1,
          headerHeight: document.querySelector('.arrangement-controls').getBoundingClientRect()
            .height,
        };
      });
      assert(
        Math.max(...directory.gaps) - Math.min(...directory.gaps) < 0.75,
        `Cover insets must match on all four sides: ${JSON.stringify(directory)}`,
      );
      assert(
        directory.width < 150 && Math.abs(directory.width - directory.headerWidth) < 0.5,
        'The compact directory header and subject cells must share their derived width',
      );
      assert(directory.headerHeight <= 91.5, 'The control strip keeps the desktop header height');
      assert(directory.placement, JSON.stringify(directory));
      assert(
        directory.filters.every(Boolean),
        'Filter labels and counts must fit on the same line',
      );
      checks.push({ language, viewportWidth: width, directory });
      const sizes = await page.evaluate(() =>
        Object.fromEntries(
          [
            '.header-tools',
            '.header-tools .tool-trigger',
            '.logout-button',
            '.record-button',
            '.subject-filters',
            '.snapshot-pages',
            '.snapshot-actions button',
            '.player-picture',
            '.track-header-viewport',
          ].map((selector) => {
            const rect = document.querySelector(selector)?.getBoundingClientRect();
            return [selector, rect ? { width: rect.width, height: rect.height } : null];
          }),
        ),
      );
      for (const [selector, size] of Object.entries(sizes)) {
        const key = `${width}:${selector}`;
        if (language === 'zh-CN') geometry.set(key, size);
        else if (
          size &&
          geometry.get(key) &&
          ['width', 'height'].some((axis) => Math.abs(size[axis] - geometry.get(key)[axis]) > 1)
        )
          problems.push({
            language,
            width,
            panel: selector,
            issues: [
              `language changes geometry: ${JSON.stringify(geometry.get(key))} -> ${JSON.stringify(size)}`,
            ],
          });
      }
      const headerIssue = await page.locator('.topbar').evaluate((node) => {
        const bar = node.getBoundingClientRect(),
          tools = node.querySelector('.header-tools').getBoundingClientRect();
        return tools.right > bar.right + 1 || tools.bottom > bar.bottom + 1
          ? 'header controls outside the title bar'
          : null;
      });
      if (headerIssue) problems.push({ language, width, panel: 'header', issues: [headerIssue] });
      let menuChrome;
      const menuWidths = {};
      for (const [name, selector] of [
        ['settings', '.header-tool:nth-child(1) .tool-trigger'],
        ['status', '.header-tool:nth-child(2) .tool-trigger'],
        ['history', '.header-tool:nth-child(3) .tool-trigger'],
        ['account', '.directory .tool-trigger'],
        ['keys', '.key-tool .tool-trigger'],
        ['cdn', '.cdn-tool .tool-trigger'],
      ]) {
        await page.locator(selector).evaluate((node) => node.click());
        await page.locator('.toolbar-popover[data-state="open"]').waitFor();
        await page
          .locator('.toolbar-popover[data-state="open"] ')
          .evaluate((node) =>
            Promise.all(node.getAnimations().map((animation) => animation.finished)),
          );
        const chrome = await page
          .locator('.toolbar-popover[data-state="open"]')
          .evaluate((node) => {
            const header = node.querySelector('header');
            const title = getComputedStyle(header.querySelector('h2'));
            const body = getComputedStyle(node.querySelector('.panel-content'));
            const close = header.querySelector('.panel-close').getBoundingClientRect();
            return {
              radius: getComputedStyle(node).borderRadius,
              headerHeight: header.offsetHeight,
              titleSize: title.fontSize,
              titleWeight: title.fontWeight,
              bodyPadding: body.padding,
              closeWidth: close.width,
              hasIcon: Boolean(header.querySelector('.panel-header-icon svg')),
            };
          });
        assert(chrome.hasIcon, `${name} must use the shared menu title icon`);
        if (menuChrome) assert.deepEqual(chrome, menuChrome, `${name} menu geometry`);
        else menuChrome = chrome;
        if (name === 'account')
          await page.locator('.routing-item').filter({ hasText: 'primetime-cams.live' }).click();
        if (name === 'keys') {
          const identity = page.locator('.key-tools .panel-identity');
          const value = identity.locator('code');
          await value.waitFor();
          assert.equal(await value.textContent(), syntheticKey);
          assert.equal(
            await identity.locator('.panel-identity-label').textContent(),
            syntheticName,
          );
          const display = await value.evaluate((field) => {
            const card = field.closest('.panel-identity');
            const label = card.querySelector('.panel-identity-label');
            const icon = card.querySelector('.panel-identity-icon svg');
            const status = card.querySelector('.panel-badge');
            const input = card.parentElement.querySelector('form input').getBoundingClientRect();
            const button = card.parentElement.querySelector('form button').getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(field);
            const lines = new Set([...range.getClientRects()].map((rect) => rect.top)).size;
            const overflow = field.scrollWidth - field.clientWidth;
            const valueBox = field.getBoundingClientRect();
            const labelBox = label.getBoundingClientRect();
            const statusBox = status.getBoundingClientRect();
            const cardBox = card.getBoundingClientRect();
            field.scrollLeft = field.scrollWidth;
            const reachesEnd = Math.abs(field.scrollLeft - overflow) <= 1;
            field.scrollLeft = 0;
            return {
              lines,
              overflow,
              reachesEnd,
              focusable: field.tabIndex === 0,
              icon: Boolean(icon),
              stacked:
                labelBox.bottom <= valueBox.top && Math.abs(labelBox.left - valueBox.left) <= 1,
              centeredStatus:
                Math.abs((statusBox.top + statusBox.bottom - cardBox.top - cardBox.bottom) / 2) <=
                  1 &&
                statusBox.left >= valueBox.right - 1 &&
                statusBox.right <= cardBox.right,
              hierarchy: getComputedStyle(label).color !== getComputedStyle(field).color,
              formAligned:
                Math.abs(input.top - button.top) <= 1 &&
                Math.abs(input.height - button.height) <= 1,
            };
          });
          assert.ok(
            display.icon &&
              display.stacked &&
              display.centeredStatus &&
              display.hierarchy &&
              display.formAligned,
            JSON.stringify(display),
          );
          assert.equal(display.lines, 1, `${language} key value stays on one line`);
          assert.ok(
            display.overflow > 0 && display.reachesEnd && display.focusable,
            `${language} long key value remains readable by scrolling: ${JSON.stringify(display)}`,
          );
        }
        if (name === 'status') {
          const running = page.locator('[data-status-row="capture-status"].is-busy');
          await running.waitFor();
          assert.equal(await page.locator('.system-summary details').count(), 0);
          const summary = page.locator('.system-summary');
          assert.equal(
            await summary.locator('.status-help-trigger').count(),
            await summary.locator('.panel-status-row').count(),
            'Every visible status row offers an explanation',
          );
          const help = running.locator('.status-help-trigger');
          const tooltip = summary.locator('[role="tooltip"]:visible');
          await help.hover();
          await tooltip.waitFor();
          const glyph = await help.evaluate((button) => {
            const style = getComputedStyle(button);
            const labelStyle = getComputedStyle(button.parentElement.parentElement);
            return {
              inline: button.getBoundingClientRect().width <= parseFloat(labelStyle.fontSize) + 1,
              textColor: style.color === labelStyle.color,
              background: style.backgroundColor,
              border: style.borderTopWidth,
            };
          });
          assert.deepEqual(glyph, {
            inline: true,
            textColor: true,
            background: 'rgba(0, 0, 0, 0)',
            border: '0px',
          });
          assert.equal(
            await help.getAttribute('aria-describedby'),
            await tooltip.getAttribute('id'),
          );
          assert.match(
            await tooltip.textContent(),
            language === 'en' ? /Sync interval/ : /统一同步间隔/,
          );
          await tooltip.hover();
          await page.keyboard.press('Escape');
          await tooltip.waitFor({ state: 'hidden' });
          await page.locator('.toolbar-popover[data-state="open"]').waitFor();
          await help.focus();
          await tooltip.waitFor();
          await page.keyboard.press('Escape');
          await tooltip.waitFor({ state: 'hidden' });
          await page.locator('.toolbar-popover[data-state="open"]').waitFor();
          const tones = await page
            .locator('.system-summary')
            .evaluate((panel) =>
              ['recording', 'capture-status', 'recording-reconnect', 'deletion'].map(
                (id) =>
                  getComputedStyle(panel.querySelector(`[data-status-row="${id}"] .panel-badge`))
                    .color,
              ),
            );
          assert.equal(new Set(tones).size, tones.length, 'Status tones are visibly distinct');
          const capacity = page.locator(
            '[data-status-row="disk-check"] .panel-badge [role="meter"]',
          );
          assert.equal(await capacity.getAttribute('aria-valuenow'), '30');
          assert.equal(
            await capacity.textContent(),
            language === 'en' ? 'Free 7.0 GiB' : '剩余 7.0 GiB',
          );
          const bar = await capacity.evaluate((node) => ({
            fill: getComputedStyle(node).backgroundImage,
            track: getComputedStyle(node.parentElement).backgroundColor,
            outline: getComputedStyle(node).outlineStyle,
          }));
          assert.match(
            bar.fill,
            /^linear-gradient\(90deg,.* 30%, (?:transparent|rgba\(0, 0, 0, 0\)) 30%\)$/,
          );
          assert.equal(bar.track, 'rgba(0, 0, 0, 0)');
          assert.equal(bar.outline, 'solid');
          const rows = () =>
            page.locator('.system-row:visible').evaluateAll((nodes) =>
              nodes.map((node) => {
                const bounds = node.getBoundingClientRect();
                const label = node.querySelector('.panel-row-label').getBoundingClientRect();
                const state = node.querySelector('.panel-row-value').getBoundingClientRect();
                return {
                  top: bounds.top,
                  height: bounds.height,
                  overlap: label.right > state.left + 1,
                };
              }),
            );
          const before = await rows();
          tasksRunning = false;
          await page.evaluate(() =>
            window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['system'] })),
          );
          const idle = page.locator('[data-status-row="capture-status"]:not(.is-busy)');
          await idle.waitFor();
          assert(
            before.every((row) => !row.overlap),
            'Active task labels must fit',
          );
          assert.deepEqual(await rows(), before, 'Task rows stay in place as their states change');
          tasksRunning = true;
          await page.evaluate(() =>
            window.dispatchEvent(new CustomEvent('stv-sync', { detail: ['system'] })),
          );
          await running.waitFor();
          if (language === 'zh-CN' && width === 1280)
            await page.screenshot({ path: '.local/qa/task-state-stable.png' });
          const scrolls = await page
            .locator('.panel-content:has(.system-summary)')
            .evaluate((node) => node.scrollHeight > node.clientHeight + 1);
          assert.equal(scrolls, false, 'Compact status rows fit without scrolling');
        }
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const size = await page.locator('.toolbar-popover[data-state="open"]').boundingBox();
        menuWidths[name] = size.width;
        const panelKey = `${width}:${name}`;
        if (language === 'zh-CN') geometry.set(panelKey, size);
        else if (
          ['width', 'height'].some(
            (axis) => Math.abs(size[axis] - geometry.get(panelKey)[axis]) > 1,
          )
        )
          problems.push({
            language,
            width,
            panel: name,
            issues: [
              `language changes panel size: ${JSON.stringify(geometry.get(panelKey))} -> ${JSON.stringify(size)}`,
            ],
          });
        const result = await page
          .locator('.toolbar-popover[data-state="open"]')
          .evaluate((panel) => {
            const issues = [],
              body = panel.querySelector('.panel-content'),
              box = panel.getBoundingClientRect();
            if (
              box.left < -1 ||
              box.right > innerWidth + 1 ||
              box.top < -1 ||
              box.bottom > innerHeight + 1
            )
              issues.push('panel outside viewport');
            if (body.scrollWidth > body.clientWidth + 1)
              issues.push(`panel horizontal overflow ${body.scrollWidth}/${body.clientWidth}`);
            const scrolling = [body, ...panel.querySelectorAll('.routing-list,.event-feed')].filter(
              (node) =>
                ['auto', 'scroll'].includes(getComputedStyle(node).overflowY) &&
                node.scrollHeight > node.clientHeight + 1,
            );
            if (scrolling.length > 1) issues.push('panel has nested vertical scroll regions');
            const bodyStyle = getComputedStyle(body),
              children = [...body.children].filter(
                (node) => getComputedStyle(node).display !== 'none',
              );
            const occupied =
              children.reduce((height, node) => height + node.getBoundingClientRect().height, 0) +
              Math.max(0, children.length - 1) * (parseFloat(bodyStyle.rowGap) || 0) +
              parseFloat(bodyStyle.paddingTop) +
              parseFloat(bodyStyle.paddingBottom);
            if (body.scrollHeight <= body.clientHeight + 1 && body.clientHeight > occupied + 2)
              issues.push(`panel reserves unused vertical space ${body.clientHeight}/${occupied}`);
            for (const node of panel.querySelectorAll(
              '.routing-toolbar button, .panel-inline-form button, .panel-content label > span, .panel-section h3, .language-toggle > span, .panel-row-label, .panel-row-value > span:not(.operation-spinner), .panel-badge, .panel-identity-content > strong:not(:has(> code))',
            )) {
              const style = getComputedStyle(node),
                bounds = node.getBoundingClientRect();
              if (!bounds.width || style.textOverflow === 'ellipsis') continue;
              const clipped = node.querySelector('.overflow-text');
              if (clipped) {
                const clip = clipped.getBoundingClientRect();
                if (clip.left < bounds.left - 1 || clip.right > bounds.right + 1)
                  issues.push(`overflow text container escapes: ${node.textContent.trim()}`);
                continue;
              }
              // Check actual text, not rotating progress SVGs whose visual bounds
              // deliberately extend beyond their unrotated inline box.
              const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
              const rects = [];
              while (walker.nextNode()) {
                if (!walker.currentNode.textContent.trim()) continue;
                const range = document.createRange();
                range.selectNodeContents(walker.currentNode);
                rects.push(...range.getClientRects());
              }
              if (
                rects.some((rect) => rect.left < bounds.left - 1 || rect.right > bounds.right + 1)
              )
                issues.push(`text escapes: ${node.textContent.trim()}`);
            }
            const toolbar = panel.querySelector('.routing-toolbar');
            if (toolbar) {
              const controls = [...toolbar.children].map((node) => node.getBoundingClientRect());
              for (let i = 0; i < controls.length; i++)
                for (let j = i + 1; j < controls.length; j++) {
                  const a = controls[i],
                    b = controls[j];
                  if (
                    Math.min(a.right, b.right) > Math.max(a.left, b.left) + 1 &&
                    Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top) + 1
                  )
                    issues.push('routing controls overlap');
                }
              for (const button of toolbar.querySelectorAll('button')) {
                const range = document.createRange();
                range.selectNodeContents(button);
                if (
                  new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size > 1
                )
                  issues.push(`button label split across lines: ${button.textContent.trim()}`);
              }
            }
            return issues;
          });
        checks.push({ language, width, panel: name, size });
        const scrollPosition = await page
          .locator('.toolbar-popover[data-state="open"] .panel-content')
          .evaluate((body) => {
            body.scrollTop = Math.min(50, body.scrollHeight - body.clientHeight);
            body.dispatchEvent(new Event('scroll', { bubbles: true }));
            return body.scrollTop;
          });
        if (scrollPosition > 0) {
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          assert(
            Math.abs(
              (await page
                .locator('.toolbar-popover[data-state="open"] .panel-content')
                .evaluate((body) => body.scrollTop)) - scrollPosition,
            ) <= 1,
            'Panel scrolling must not reset list measurement or scroll position',
          );
        }
        if (result.length) {
          problems.push({ language, width, panel: name, issues: result });
          await page.screenshot({
            path: `.local/qa/localization-${language}-${width}-${name}.png`,
          });
        }
        if (language === 'en' && width === 768 && ['settings', 'keys', 'status'].includes(name))
          await page.screenshot({ path: `.local/qa/localization-verified-${name}.png` });
        await page.keyboard.press('Escape');
        await page.locator('.toolbar-popover').waitFor({ state: 'detached' });
      }
      assert(
        ['settings', 'status', 'history', 'cdn', 'keys'].every(
          (name) => menuWidths[name] < menuWidths.account,
        ),
        `Panels size to their contents at ${width}px in ${language}: ${JSON.stringify(menuWidths)}`,
      );
      const noticeIssue = await page.evaluate(
        (copy) => {
          const picture = document.createElement('div');
          picture.className = 'player-picture';
          picture.style.cssText =
            'position:fixed;inset:0 auto auto 0;width:300px;height:169px;z-index:100000';
          const notice = document.createElement('div');
          notice.className = 'playback-status playback-status--compact';
          const content = document.createElement('div');
          content.className = 'playback-status-content';
          for (const [tag, text] of [
            ['span', '!'],
            ['strong', copy.title],
            ['p', copy.detail],
            ['button', copy.retry],
          ]) {
            const node = document.createElement(tag);
            node.textContent = text;
            if (tag === 'span') node.className = 'playback-status-symbol';
            content.append(node);
          }
          notice.append(content);
          picture.append(notice);
          document.body.append(picture);
          const box = picture.getBoundingClientRect(),
            noticeBox = notice.getBoundingClientRect();
          const issue =
            notice.scrollWidth > notice.clientWidth + 1 ||
            noticeBox.top < box.top - 1 ||
            noticeBox.bottom > box.bottom + 1;
          picture.remove();
          return issue;
        },
        Object.fromEntries(
          Object.entries({
            title: '无法确认公开直播状态',
            detail: '状态接口未返回有效公开状态，为避免继续获取非公开画面，连接已停止。',
            retry: '重新连接',
          }).map(([key, value]) => [key, language === 'en' ? english[value] : value]),
        ),
      );
      if (noticeIssue)
        problems.push({
          language,
          width,
          panel: 'player-notice',
          issues: ['compact playback notice escapes its picture'],
        });
    }
    await page.setViewportSize({ width: 1920, height: 900 });
    assert.equal(
      (await page.locator('.record-button').first().textContent()).trim(),
      '',
      'Cover recording controls have no visible labels',
    );
    assert(await page.locator('.record-button').first().getAttribute('aria-description'));
    await page.getByRole('button', { name: '00 演示直播', exact: true }).click();
    await page.locator('.snapshot-cell').first().waitFor();
    await page
      .locator('.snapshot-section')
      .dispatchEvent('pointermove', { clientX: 110, clientY: 110 });
    for (const mode of ['normal', 'fullscreen']) {
      if (mode === 'fullscreen') {
        await page
          .locator('.player-picture')
          .dispatchEvent('pointermove', { clientX: 110, clientY: 110 });
        await page
          .getByRole('button', {
            name: language === 'en' ? english['全屏播放'] : '全屏播放',
            exact: true,
          })
          .click();
        await page.waitForFunction(() => !!document.fullscreenElement);
        await page.locator('.inline-player:fullscreen .media-review').waitFor();
      }
      const sizes = await page.locator('.snapshot-pages').evaluate((node) =>
        [...node.querySelectorAll('button'), node].map((item) => {
          const rect = item.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        }),
      );
      await page.waitForTimeout(400);
      assert.equal(
        await page.locator('.snapshot-pages').isVisible(),
        true,
        `${mode}: toolbar must remain visible`,
      );
      const separation = await page.evaluate(() => {
        const tools = document.querySelector('.snapshot-pages').getBoundingClientRect();
        const grid = document.querySelector('.snapshot-grid').getBoundingClientRect();
        const picture = document.querySelector('.player-picture').getBoundingClientRect();
        return {
          tools: { x: tools.x, y: tools.y, width: tools.width, height: tools.height },
          parent: document.querySelector('.snapshot-pages').parentElement.className,
          inFullscreen: document.fullscreenElement?.contains(
            document.querySelector('.snapshot-pages'),
          ),
          outsideGrid: tools.bottom <= grid.top + 1,
          outsidePicture: tools.top >= picture.bottom,
          direction: getComputedStyle(document.querySelector('.snapshot-pages')).flexDirection,
        };
      });
      console.log('[qa] Screenshot tools', JSON.stringify({ mode, separation }));
      assert(
        separation.outsideGrid &&
          (mode === 'fullscreen' || separation.outsidePicture) &&
          separation.direction === 'row',
        JSON.stringify({ mode, separation }),
      );
      const imageBounds = await page.locator('.snapshot-cell').evaluateAll((cells) =>
        cells.map((cell) => {
          const box = cell.getBoundingClientRect();
          const image = cell.querySelector('img')?.getBoundingClientRect();
          return {
            width: box.width,
            height: box.height,
            imageWidth: image?.width,
            imageHeight: image?.height,
          };
        }),
      );
      assert(
        imageBounds.every((box) => !box.imageWidth || box.imageWidth <= box.width + 2),
        JSON.stringify({ mode, imageBounds }),
      );
      if (language === 'zh-CN')
        await page.screenshot({ path: `.local/qa/snapshot-tools-${mode}.png` });
      const key = `actions:${mode}`;
      if (language === 'zh-CN') geometry.set(key, sizes);
      else
        assert.deepEqual(
          sizes,
          geometry.get(key),
          `${mode} range actions must keep bilingual dimensions`,
        );
      const clipping = await page.locator('.snapshot-actions button > span').evaluateAll((labels) =>
        labels.flatMap((node) => {
          if (!node.getBoundingClientRect().width) return [];
          const box = node.closest('button').getBoundingClientRect(),
            range = document.createRange();
          range.selectNodeContents(node);
          return [...range.getClientRects()].some(
            (rect) => rect.left < box.left || rect.right > box.right,
          )
            ? [node.textContent]
            : [];
        }),
      );
      assert.deepEqual(clipping, [], 'Range action labels must fit their controls');
      const stacked = await page
        .locator('.snapshot-pages button:has(span)')
        .evaluateAll((buttons) =>
          buttons.flatMap((button) => {
            const icon = button.querySelector('.ui-icon').getBoundingClientRect();
            const label = button.querySelector('span').getBoundingClientRect();
            return Math.abs(icon.y + icon.height / 2 - label.y - label.height / 2) > 1 ||
              icon.right > label.left
              ? [button.textContent]
              : [];
          }),
        );
      assert.deepEqual(stacked, [], 'Icons and labels share one horizontal row');
    }
    await holdPlayerControls(page);
    await page
      .getByRole('button', {
        name: language === 'en' ? english['退出全屏'] : '退出全屏',
        exact: true,
      })
      .click();
    await page.waitForFunction(() => document.fullscreenElement === null);
    await page.locator('.connection-close').click();
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('.header-tool').first().locator('.tool-trigger').click();
  await page.locator('.toolbar-popover[data-state="open"]').waitFor();
  await page
    .locator('.toolbar-popover[data-state="open"]')
    .evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const liveGeometry = () =>
    page.evaluate(() =>
      [
        '.header-tools',
        '.subject-filters',
        '.record-button',
        '.toolbar-popover[data-state="open"]',
      ].map((selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }),
    );
  const beforeSwitch = await liveGeometry();
  await page.locator('.language-toggle').click();
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  const afterSwitch = await liveGeometry();
  assert.deepEqual(
    afterSwitch.slice(0, 3),
    beforeSwitch.slice(0, 3),
    'Language switching keeps toolbar and directory geometry',
  );
  assert.equal(
    afterSwitch[3].width,
    beforeSwitch[3].width,
    'Panel widths remain stable across languages',
  );
  assert(
    Math.abs(afterSwitch[3].x - beforeSwitch[3].x) < 1,
    'Panel horizontal anchor remains stable',
  );
  assert(
    Math.abs(afterSwitch[3].y - beforeSwitch[3].y) < 1 ||
      Math.abs(
        afterSwitch[3].y + afterSwitch[3].height - beforeSwitch[3].y - beforeSwitch[3].height,
      ) < 1,
    'Natural-height panels retain their anchored edge',
  );
  await writeFile(
    '.local/qa/localization-layout.json',
    JSON.stringify({ checks, problems }, null, 2),
  );
  console.log(JSON.stringify(problems));
  assert.equal(
    problems.length,
    0,
    'Localized panels must wrap text without clipping or horizontal overflow',
  );
} finally {
  await browser?.close();
  await fixture.close();
}
