import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SystemSummary } from './SystemSummary';
import type { SystemInfo } from './system';
const system: SystemInfo = {
  version: 'test',
  capturedAtMs: 1000,
  disk: { freeBytes: 5 * 1024 ** 3, totalBytes: 10 * 1024 ** 3, lowSpace: false },
  capture: { pollMs: 5000, active: 3, starting: 1, retrying: 2 },
  backgroundTasks: [
    {
      id: 'archive-index',
      group: 'processing',
      state: 'running',
      processed: 3,
      detail: 'index-batches',
    },
  ],
};
it('shows recording and media items in separate rows under their groups', () => {
  const html = renderToStaticMarkup(<SystemSummary system={system} autoRecordingCount={5} />);
  expect(html).toMatch(/data-status-row="recording-start"[^>]*>.*?启动中/);
  expect(html).toMatch(/data-status-row="recording-reconnect"[^>]*>.*?重连中/);
  expect(html).toMatch(
    /aria-label="媒体处理"[^>]*>.*?data-status-row="archive-index"[^>]*>.*?录像整理/,
  );
  expect(html).toContain('剩余 5.0 GiB');
  expect(html).toMatch(/aria-label="归档与存储"[^>]*>.*?归档服务.*?data-status-row="disk-check"/);
  expect(html).toContain('width:50%');
  expect(html).not.toContain('<details');
  expect(html).not.toContain('overflow-text');
  expect(html).not.toContain('index-batches');
});
it('does not draw a fake disk progress bar before capacity is known', () => {
  const html = renderToStaticMarkup(
    <SystemSummary
      system={{ ...system, disk: { freeBytes: 0, totalBytes: 0, lowSpace: true } }}
      autoRecordingCount={0}
    />,
  );
  expect(html).not.toContain('磁盘剩余空间');
});
it('keeps retry feedback on its existing status row and omits it after healthy checks', () => {
  const onRefresh = () => Promise.resolve();
  const html = renderToStaticMarkup(
    <SystemSummary
      system={{
        ...system,
        retries: [{ target: 'cover-sync', state: 'running', startedAtMs: 1000 }],
        retryableTargets: ['cover-sync', 'avatar-sync'],
        backgroundTasks: [
          { id: 'cover-sync', group: 'sync', state: 'retrying', error: 'cover_refresh_partial' },
          { id: 'avatar-sync', group: 'sync', state: 'retrying', error: 'avatar_refresh_partial' },
        ],
      }}
      autoRecordingCount={0}
      onRefresh={onRefresh}
    />,
  );
  expect(html).toMatch(
    /data-status-row="cover-sync"[^>]*>.*?disabled="" aria-label="封面更新：重试"/,
  );
  expect(html).toMatch(
    /data-status-row="avatar-sync"[^>]*>.*?system-retry" type="button" aria-label="头像更新：重试"/,
  );
  expect(html).toContain('重试中');
  expect(html).not.toContain('aria-label="数据同步：重试"');
  expect(html).not.toContain('aria-label="媒体处理：重试"');
  expect(
    renderToStaticMarkup(
      <SystemSummary system={system} autoRecordingCount={0} onRefresh={onRefresh} />,
    ),
  ).not.toContain('system-retry');
});
it('keeps the actual diagnostic visible after a retry while offering another attempt', () => {
  const html = renderToStaticMarkup(
    <SystemSummary
      system={{
        ...system,
        archiveHealth: { error: null, failures: 0, recovery: 'none', checkedAtMs: 1000 },
        disk: { ...system.disk, error: 'disk_read_only' },
        retryableTargets: ['disk-check'],
        retries: [{ target: 'disk-check', state: 'finished', startedAtMs: 1000 }],
      }}
      autoRecordingCount={0}
      onRefresh={() => Promise.resolve()}
    />,
  );
  expect(html).toContain('数据目录只读');
  expect(html).toContain('archive-health is-ok');
  expect(html).toContain('aria-label="存储空间：重试"');
  expect(html).not.toContain('aria-label="归档服务：重试"');
  expect(html).toContain('重试已执行，恢复情况见当前状态。');
});

it('shows the site error without a retry button when the server requires an account action', () => {
  const html = renderToStaticMarkup(
    <SystemSummary
      system={{
        ...system,
        retryableTargets: [],
        backgroundTasks: [
          { id: 'site-access', group: 'sync', state: 'error', error: 'site_verification_required' },
        ],
      }}
      autoRecordingCount={0}
      onRefresh={() => Promise.resolve()}
    />,
  );
  expect(html).toContain('绑定站点要求人机验证');
  expect(html).not.toContain('system-retry');
});
