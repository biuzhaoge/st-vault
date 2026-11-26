import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SystemSummary } from './SystemSummary';
import type { SystemInfo } from './system';
import {
  beginDeletionProjection,
  clearDeletionProjections,
  failDeletionProjection,
} from '../../shared/lib/deletion-projection';

it('shows the most recent local deletion rejection in the status panel', () => {
  const target = { kind: 'range', mode: 'unliked', fromMs: 60000, toMs: 120000 } as const;
  try {
    beginDeletionProjection('rejected', 'stripchat:42', target, [], []);
    failDeletionProjection('rejected', '删除任务队列已满，请等待已有任务完成。');
    const render = () =>
      renderToStaticMarkup(<SystemSummary system={null} autoRecordingCount={0} />);
    expect(render()).toMatch(/data-status-row="deletion"[^>]*>.*?删除任务队列已满/);
    beginDeletionProjection('next', 'stripchat:42', target, [], []);
    expect(render()).not.toContain('删除任务队列已满');
  } finally {
    clearDeletionProjections();
  }
});
const system: SystemInfo = {
  version: 'test',
  capturedAtMs: 1000,
  disk: { freeBytes: 7 * 1024 ** 3, totalBytes: 10 * 1024 ** 3, lowSpace: false },
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
  expect(html).toMatch(/data-status-row="recording"[^>]*>.*?class="panel-badge is-success"/);
  expect(html).toMatch(
    /aria-label="媒体处理"[^>]*>.*?data-status-row="archive-index"[^>]*>.*?录像整理/,
  );
  expect(html).toMatch(/aria-label="归档与存储"[^>]*>.*?归档服务.*?data-status-row="disk-check"/);
  expect(html).toMatch(
    /data-status-row="disk-check"[^>]*>.*?class="panel-badge is-success"><span class="disk-capacity" role="meter"[^>]*aria-valuenow="30"[^>]*style="--disk-used:30%">剩余 7\.0 GiB<\/span>/,
  );
  expect(html).toContain('aria-valuetext="已用 30%，剩余 7.0 GiB"');
  expect(html).not.toContain('<details');
  expect(html).not.toContain('overflow-text');
  expect(html).not.toContain('index-batches');
});

it('gives every displayed status row a help button with current settings', () => {
  const html = renderToStaticMarkup(
    <SystemSummary
      system={{
        ...system,
        settings: { pollMs: 7250, retentionDays: 21, minFreeBytes: 3 * 1024 ** 3 },
        backgroundTasks: [
          ...system.backgroundTasks!,
          { id: 'account-list', group: 'sync', state: 'waiting' },
          { id: 'retention', group: 'protection', state: 'waiting' },
          { id: 'library-checkpoint', group: 'protection', state: 'error' },
        ],
      }}
      autoRecordingCount={5}
    />,
  );
  expect(html.match(/class="status-help-trigger"/g)).toHaveLength(
    html.match(/class="panel-row panel-status-row"/g)!.length,
  );
  expect(html).toContain('统一同步间隔 7.25 秒');
  expect(html).toContain('录像保留天数 21 天');
  expect(html).toContain('最低剩余空间 3 GiB');
  expect(html).toContain('检查点');
});
it('does not draw a fake disk progress bar before capacity is known', () => {
  const html = renderToStaticMarkup(
    <SystemSummary
      system={{ ...system, disk: { freeBytes: 0, totalBytes: 0, lowSpace: true } }}
      autoRecordingCount={0}
    />,
  );
  expect(html).not.toContain('role="meter"');
});

it('leaves the entire bar unfilled when the reported capacity is all free', () => {
  const html = renderToStaticMarkup(
    <SystemSummary
      system={{ ...system, disk: { ...system.disk, freeBytes: system.disk.totalBytes } }}
      autoRecordingCount={0}
    />,
  );
  expect(html).toMatch(/role="meter"[^>]*aria-valuenow="0"[^>]*style="--disk-used:0%"/);
});

it('shows low capacity and a disk check in the same status position', () => {
  const lowDisk = { ...system.disk, freeBytes: 0, lowSpace: true };
  const low = renderToStaticMarkup(
    <SystemSummary system={{ ...system, disk: lowDisk }} autoRecordingCount={0} />,
  );
  expect(low).toMatch(
    /data-status-row="disk-check"[^>]*>.*?class="panel-badge is-warning"><span class="disk-capacity" role="meter"[^>]*aria-valuenow="100"[^>]*style="--disk-used:100%">剩余 0 B<\/span>/,
  );
  const checking = renderToStaticMarkup(
    <SystemSummary
      system={{
        ...system,
        disk: lowDisk,
        backgroundTasks: [{ id: 'disk-check', group: 'protection', state: 'running' }],
      }}
      autoRecordingCount={0}
    />,
  );
  expect(checking).toMatch(/data-status-row="disk-check"[^>]*>.*?panel-badge is-busy.*?检查中/);
  expect(checking).not.toContain('role="meter"');
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
  expect(html).toMatch(/data-status-row="disk-check"[^>]*>.*?panel-badge is-error">异常/);
  expect(html).not.toContain('role="meter"');
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
