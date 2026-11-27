import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { startFixture } from './support/fixture.mjs';
import { outputRoot } from './support/media.mjs';

const fixture = await startFixture();
let browser;
try {
  const origin = `http://127.0.0.1:${fixture.info.port}`;
  browser = await chromium.launch({
    executablePath: process.env.STV_QA_BROWSER_EXECUTABLE ?? '/usr/bin/chromium',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const portrait = await readFile(path.join(outputRoot, 'media', 'portrait.jpg'));
  await page.route(/\/api\/subjects\/[^/]+\/cover\.jpg(?:\?|$)/, (route) =>
    route.fulfill({ contentType: 'image/jpeg', body: portrait }),
  );
  const id = (value) => `stripchat:${value}`;
  const binding = 'synthetic-directory-binding';
  let connected = false;
  const subjects = new Map([
    [
      42,
      {
        providerStatus: 'PUBLIC',
        onlineSinceMs: 5000,
        lastOnlineAtMs: 12000,
        autoRecord: false,
        captureState: 'IDLE',
      },
    ],
    [4, { providerStatus: 'PRIVATE', onlineSinceMs: 6000, lastOnlineAtMs: 6000 }],
    [1, { providerStatus: 'UNKNOWN', lastKnownStatus: 'PUBLIC', lastOnlineAtMs: 4000 }],
    [3, { providerStatus: 'OFFLINE', lastRecordedAtMs: 1000, lastOnlineAtMs: 8000 }],
    [
      6,
      {
        providerStatus: 'UNKNOWN',
        lastKnownStatus: 'OFFLINE',
        lastOnlineAtMs: 9000,
        archiveReason: 'region_restricted',
      },
    ],
    [
      21,
      {
        providerStatus: 'UNKNOWN',
        lastRecordedAtMs: 3000,
        directory: { group: 'OFFLINE', orderStatus: 'UNKNOWN', pending: true },
      },
    ],
    [
      300,
      {
        providerStatus: 'OFFLINE',
        archived: true,
        archiveReason: 'region_restricted',
        lastRecordedAtMs: 2000,
      },
    ],
    [
      298,
      {
        providerStatus: 'PUBLIC',
        archived: true,
        archiveReason: 'account_disabled',
        lastOnlineAtMs: 9000,
      },
    ],
    [296, { providerStatus: 'PRIVATE', archived: true, archiveReason: 'account_deleted' }],
    [297, { providerStatus: 'UNKNOWN', archived: true }],
    [
      295,
      {
        providerStatus: 'UNKNOWN',
        archived: true,
        archiveReason: 'unfollowed',
        lastRecordedAtMs: 1000,
      },
    ],
  ]);
  await page.route('**/api/subjects', async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: (await response.json())
        .filter((subject) => subjects.has(subject.providerId))
        .map((subject) => ({
          ...subject,
          archived: false,
          lastRecordedAtMs: null,
          lastOnlineAtMs: null,
          lastKnownStatus: undefined,
          onlineSinceMs: undefined,
          directory: undefined,
          unfollowBinding:
            connected && [1, 3, 4, 21, 42, 298].includes(subject.providerId) ? binding : undefined,
          ...subjects.get(subject.providerId),
        })),
    });
  });

  const filters = page.locator('.subject-filters');
  const button = (name) => filters.getByRole('button', { name, exact: true });
  const selected = () =>
    filters
      .locator('button[aria-pressed="true"]')
      .evaluateAll((items) => items.map((item) => item.getAttribute('aria-label')));
  const waitForRows = async (expected) => {
    await page.waitForFunction((expectedIds) => {
      const rows = [...document.querySelectorAll('.track-table > .track-row')];
      return (
        rows.length === expectedIds.length &&
        rows.every((row, index) => row.dataset.subjectId === expectedIds[index])
      );
    }, expected.map(id));
    const numbers = await page
      .locator('.track-table > .track-row .directory-row-number')
      .evaluateAll((nodes) =>
        nodes.map((node) => [node.textContent.trim(), node.getAttribute('aria-hidden')]),
      );
    assert.deepEqual(
      numbers,
      expected.map((_, index) => [String(index + 1), 'true']),
      'Visible rows have consecutive decorative numbers in the current filtered order',
    );
  };
  const waitForSelection = (expected) =>
    page.waitForFunction(
      (names) =>
        Array.from(document.querySelectorAll('.subject-filters button[aria-pressed="true"]'), (n) =>
          n.getAttribute('aria-label'),
        ).join() === names.join(),
      expected,
    );
  const firstRow = page.locator('.track-table > .track-row').first();
  const readLayout = () =>
    firstRow.evaluate((row) => {
      const box = (selector) => row.querySelector(selector).getBoundingClientRect();
      const label = row.querySelector('.track-label');
      const indexColumn = row.querySelector('.directory-row-index');
      const recording = indexColumn?.querySelector('.record-button');
      if (!recording) return null;
      const number = row.querySelector('.directory-row-number');
      const glyph = number.querySelector('span');
      const labelBox = label.getBoundingClientRect();
      const indexBox = indexColumn.getBoundingClientRect();
      const controlBox = recording.getBoundingClientRect();
      const numberBox = number.getBoundingClientRect();
      const cover = box('.track-cover-wrap');
      const lane = box('.track-lane');
      const ruler = document
        .querySelector('.time-range-control .timeline-ruler')
        .getBoundingClientRect();
      const directory = document.querySelector('.directory').getBoundingClientRect();
      const account = document
        .querySelector('.directory .account-tool .tool-trigger')
        .getBoundingClientRect();
      const text = document.createRange();
      text.selectNodeContents(glyph);
      const textBox = text.getBoundingClientRect();
      const style = getComputedStyle(glyph);
      return {
        numberWidth: indexBox.width,
        numberBeforeCover: indexBox.right <= cover.left + 0.5,
        numberCenterOffset: Math.abs(
          (textBox.left + textBox.right - labelBox.left - cover.left) / 2,
        ),
        numberDivider: getComputedStyle(indexColumn).borderInlineEndWidth,
        numberFits: textBox.left >= indexBox.left && textBox.right <= indexBox.right,
        recordingContainsNumber: recording.contains(number),
        recordingCentered:
          Math.abs(controlBox.left + controlBox.right - numberBox.left - numberBox.right) < 2 &&
          Math.abs(controlBox.top + controlBox.bottom - numberBox.top - numberBox.bottom) < 2,
        recordingClearOfCover: controlBox.right <= cover.left + 0.5,
        labelShadow: getComputedStyle(label).boxShadow,
        coverWithinDirectory: cover.right <= lane.left + 0.5,
        coverWidth: cover.width,
        coverHeight: cover.height,
        laneAndRulerOffset: Math.abs(lane.left - ruler.left),
        accountCenterOffset: Math.abs(
          (account.left + account.right - directory.left - directory.right) / 2,
        ),
        glyph: {
          fontSize: parseFloat(style.fontSize),
          fontWeight: Number(style.fontWeight),
          backgroundClip: style.backgroundClip,
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          boxShadow: style.boxShadow,
          color: style.color,
          filter: style.filter,
          textShadow: style.textShadow,
          textFill: style.webkitTextFillColor,
          textStroke: style.webkitTextStroke,
        },
      };
    });

  await page.goto(origin);
  await page.getByLabel('6 位 PIN', { exact: true }).fill('012345');
  await button('在线').waitFor();
  assert.deepEqual(await selected(), ['在线']);
  await button('离线').click();
  assert.deepEqual(await selected(), ['在线', '离线'], 'Toggling offline keeps online selected');
  await waitForRows([42, 1, 4, 3, 6, 21]);
  assert.equal(await button('在线').locator('.filter-count').textContent(), '3');
  assert.equal(await button('离线').locator('.filter-count').textContent(), '2');
  assert.equal(await filters.getByRole('status').count(), 0);
  await button('归档').click();
  assert.deepEqual(await selected(), ['在线', '离线', '归档']);
  const allRows = [42, 1, 4, 3, 6, 21, 300, 295, 298, 296, 297];
  await waitForRows(allRows);
  const rowFor = (value) => page.locator(`.track-table > [data-subject-id="${id(value)}"]`);
  assert.equal(await page.locator('.track-row[data-pending-section-start]').count(), 0);
  for (const [value, status] of [
    [1, 'public'],
    [21, 'unknown'],
    [297, 'archived'],
  ]) {
    const preview = rowFor(value).locator(`.track-label.status-cell-${status} .subject-preview`);
    await preview.waitFor();
    assert.equal(await preview.locator('.subject-preview-status').count(), 0);
    assert.equal(await preview.getAttribute('aria-description'), null);
  }
  for (const value of allRows) {
    const image = rowFor(value).locator('.track-cover-cell .track-cover');
    await image.waitFor();
    await image.evaluate((element) => element.decode());
    const { fit, width, height } = await image.evaluate((element) => ({
      fit: getComputedStyle(element).objectFit,
      width: element.naturalWidth,
      height: element.naturalHeight,
    }));
    assert(height > width, `Row ${value} uses a portrait preview`);
    assert.equal(
      fit,
      [42, 1, 4].includes(value) ? 'contain' : 'cover',
      `Cover fit for row ${value}`,
    );
  }
  for (const [value, status, message] of [
    [6, 'offline', '地区限制'],
    [300, 'archived', '地区限制'],
    [298, 'archived', '账号已禁用'],
    [296, 'archived', '账号已删除'],
    [295, 'archived', '已取消关注'],
  ]) {
    const label = rowFor(value).locator(`.track-label.status-cell-${status}`);
    const preview = label.locator('.subject-preview');
    assert.equal(await preview.getByText(message, { exact: true }).isVisible(), true);
    assert.match(await preview.getAttribute('aria-description'), new RegExp(message));
    if (status === 'archived') {
      assert.equal(await label.locator('.track-cover-cell button').count(), 1);
    }
  }
  const switchRows = await page
    .locator('.track-table > .track-row')
    .evaluateAll((rows) =>
      rows
        .filter((row) => row.querySelector('.directory-row-index [role="switch"]'))
        .map((row) => row.dataset.subjectId),
    );
  assert.deepEqual(switchRows, [42, 1, 4, 3, 6, 21].map(id), 'Archived rows show a number alone');
  assert.equal(await page.locator('.track-cover-cell .record-button').count(), 0);
  for (const viewport of [
    { width: 1024, height: 768 },
    { width: 744, height: 600 },
  ]) {
    await page.setViewportSize(viewport);
    const layout = await readLayout();
    assert(layout, 'Recording belongs in the directory index column');
    assert(
      layout.numberWidth >= 28 &&
        layout.numberWidth <= 34 &&
        layout.numberBeforeCover &&
        layout.coverWithinDirectory &&
        layout.coverWidth >= 110 &&
        Math.abs(layout.coverWidth - (layout.coverHeight * 16) / 9) <= 1 &&
        layout.laneAndRulerOffset <= 1,
      JSON.stringify({ viewport, layout }),
    );
    assert(
      layout.accountCenterOffset <= 1,
      `The account button is centered across the number and cover header: ${JSON.stringify({ viewport, offset: layout.accountCenterOffset })}`,
    );
    assert(
      layout.numberCenterOffset <= 1 && layout.numberFits,
      JSON.stringify({ viewport, layout }),
    );
    assert(
      layout.recordingCentered && layout.recordingContainsNumber && layout.recordingClearOfCover,
      `The number is the centered recording control and leaves the cover clear: ${JSON.stringify({ viewport, layout })}`,
    );
    assert.equal(layout.numberDivider, '0px', 'The number column has no cover divider');
    assert.doesNotMatch(layout.labelShadow, /\)\s+3px 0px\b/, 'The left edge has no thick stripe');
    const { glyph } = layout;
    assert(
      glyph.fontSize >= 13 &&
        glyph.fontWeight >= 700 &&
        glyph.backgroundImage.includes('gradient(') &&
        glyph.backgroundClip === 'text' &&
        glyph.backgroundColor === 'rgba(0, 0, 0, 0)' &&
        glyph.boxShadow === 'none',
      `Glass styling should be confined to the number glyph: ${JSON.stringify({ viewport, glyph })}`,
    );
  }
  await page.setViewportSize({ width: 1024, height: 768 });
  const record = firstRow.locator('.record-button');
  const waitForRecordGlyph = (actionVisible) =>
    page.waitForFunction(
      (showAction) => {
        const control = document.querySelector('.track-table > .track-row .record-button');
        const number = control?.querySelector('.directory-row-number');
        const action = control?.querySelector('.record-action');
        return (
          number &&
          action &&
          getComputedStyle(number).opacity === (showAction ? '0' : '1') &&
          getComputedStyle(action).opacity === (showAction ? '1' : '0')
        );
      },
      actionVisible,
      { timeout: 3000 },
    );
  await record.hover();
  await waitForRecordGlyph(true);
  await page.mouse.move(2, 2);
  await waitForRecordGlyph(false);
  await button('在线').click();
  await waitForRows([3, 6, 21, 300, 295, 298, 296, 297]);

  await page.reload();
  await waitForSelection(['离线', '归档']);
  await waitForRows([3, 6, 21, 300, 295, 298, 296, 297]);
  await rowFor(295).getByText('已取消关注', { exact: true }).waitFor();
  assert.equal(await rowFor(297).locator('.subject-preview-status').count(), 0);
  await button('归档').click();
  await waitForRows([3, 6, 21]);
  await button('离线').click();
  await waitForRows([]);
  assert.deepEqual(await selected(), []);

  await page.reload();
  await button('在线').waitFor();
  await waitForSelection([]);
  await waitForRows([]);
  await button('在线').click();
  await waitForRows([42, 1, 4]);
  await page.mouse.move(2, 2);
  const unselected = await readLayout();
  await firstRow.locator('.subject-preview').press('Enter');
  await firstRow.locator('.subject-preview[aria-current="true"]').waitFor();
  const active = await readLayout();
  assert.deepEqual(active.glyph, unselected.glyph, 'Selection keeps the same glass glyph');
  assert.equal(active.labelShadow, unselected.labelShadow, 'Selection adds no edge stripe');

  const unfollowButton = (value) => rowFor(value).locator('.directory-unfollow-button');
  assert.equal(await unfollowButton(1).count(), 0, 'Unfollow requires a connected account');
  await page.route('**/api/account-sync', async (route) => {
    const response = await route.fetch();
    if (response.ok() && route.request().method() === 'PUT') connected = true;
    await route.fulfill({ response });
  });
  await page.locator('.account-tool .tool-trigger').click();
  await page.getByLabel('Cookies', { exact: true }).fill('session=synthetic-directory');
  await page.getByRole('button', { name: '连接并同步', exact: true }).click();
  await page.getByRole('button', { name: '更换 Cookies', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await button('离线').click();
  await button('归档').click();
  await waitForRows(allRows);
  await rowFor(42).locator('.subject-preview').press('Enter');
  await rowFor(42).locator('.subject-preview[aria-current="true"]').waitFor();
  for (const value of [6, 295, 296, 297, 300]) {
    assert.equal(
      await unfollowButton(value).count(),
      0,
      `No unfollow command for protected row ${value}`,
    );
  }
  await unfollowButton(298).waitFor();
  const unfollow = unfollowButton(1);
  assert.equal(await unfollow.getAttribute('aria-label'), '取消关注 演示主播 001');
  assert.ok(
    await unfollow.evaluate((control) => {
      const box = control.getBoundingClientRect();
      const number = control
        .closest('.directory-row-index')
        .querySelector('.directory-row-number')
        .getBoundingClientRect();
      return (
        box.top >= number.bottom && Math.abs(box.left + box.right - number.left - number.right) < 2
      );
    }),
    'The unfollow button is centered directly below the number',
  );

  const response = Promise.withResolvers();
  const target = `/api/account-sync/favorites/${encodeURIComponent(id(1))}`;
  await page.route(`**${target}`, async (route) => {
    await response.promise;
    subjects.delete(1);
    await route.fulfill({ json: { subject: null } });
  });
  const requested = page.waitForRequest((request) => new URL(request.url()).pathname === target);
  try {
    await unfollow.click();
    const request = await requested;
    assert.equal(request.method(), 'DELETE');
    assert.deepEqual(request.postDataJSON(), { binding });
    await rowFor(1).locator('.directory-unfollow-button:disabled[aria-busy="true"]').waitFor();
    assert.equal(await rowFor(42).locator('.subject-preview').getAttribute('aria-current'), 'true');
  } finally {
    response.resolve();
  }
  await waitForRows(allRows.filter((value) => value !== 1));
  assert.equal(await rowFor(42).locator('.subject-preview').getAttribute('aria-current'), 'true');
  console.log('[qa] Directory filters, row layout, reload and explicit unfollow passed');
} finally {
  await browser?.close();
  await fixture.close();
}
