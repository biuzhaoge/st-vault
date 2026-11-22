import { expect, it } from 'vitest';
import type { BackgroundTask } from '@st-vault/api-schema';
import { backgroundTaskAlert, statusGroups } from './background-status';

const now = Date.UTC(2026, 10, 12, 7);
const task = (id: string, patch?: Partial<BackgroundTask>): BackgroundTask => ({
  id,
  group: 'sync',
  state: 'waiting',
  ...patch,
});

it('shows schedule, healthy cached images and disconnected account as independent rows', () => {
  const tasks = [
    task('capture-status', { nextRunAtMs: now + 60000 }),
    task('account-list', { state: 'disabled' }),
    task('cover-sync', { state: 'idle', lastSuccessAtMs: now }),
  ];
  expect(statusGroups(tasks, now).sync.map(({ id, value }) => [id, value.text])).toEqual([
    ['account-list', '未连接账户'],
    ['capture-status', '下次刷新 15:01:00'],
    ['cover-sync', '空闲'],
  ]);
  expect(backgroundTaskAlert(tasks)).toBeUndefined();
});

it('keeps real failures and their reasons on the affected item', () => {
  const tasks = [
    task('site-access', { state: 'error', error: 'site_unavailable' }),
    task('account-list', { state: 'error', error: 'cookies_domain_mismatch' }),
    task('cover-sync', { state: 'retrying', error: 'cover_refresh_partial' }),
    task('avatar-sync', { state: 'idle' }),
  ];
  const rows = statusGroups(tasks, now).sync;
  expect(rows.map((item) => item.value.tone)).toEqual(['error', 'error', 'warning', undefined]);
  expect(rows[1].value.note).toContain('Cookies 与所选站点域名不匹配');
  expect(rows[2].value.note).toContain('下载失败');
  expect(backgroundTaskAlert(tasks)).toBe('绑定站点访问异常');
});

it('keeps manual site testing separate and treats an unreadable task as unconfirmed', () => {
  const probe = task('site-probe', { state: 'error', error: 'site_probe_failed' });
  const snapshot = task('snapshots', { state: 'error', error: 'task_status_unavailable' });
  expect(backgroundTaskAlert([probe, snapshot])).toBeUndefined();
  expect(statusGroups([probe, snapshot], now).sync).toEqual([]);
  expect(statusGroups([snapshot], now).media[0].value).toMatchObject({
    tone: 'warning',
    text: '检查中',
  });
});

it('shows deletion and screenshot progress without hiding the result of another check', () => {
  const screenshot = task('snapshots', {
    group: 'processing',
    state: 'running',
    active: 2,
    pending: 7,
  });
  const deletion = { tone: 'busy' as const, text: '正在删除 · Model' };
  expect(statusGroups([screenshot], now, deletion).media.map((item) => item.value.text)).toEqual([
    '正在生成 2 张截图',
    '正在删除 · Model',
  ]);
  const maintenance = task('snapshot-maintenance', { state: 'error', error: 'private-path' });
  const result = statusGroups([screenshot, maintenance], now, deletion).media;
  expect(result[2].value.note).toContain('任务异常，请查看运行日志');
  expect(JSON.stringify(result)).not.toContain('private-path');
});

it('surfaces failed internal checks without listing routine heartbeat activity', () => {
  expect(statusGroups([task('run-heartbeat', { state: 'running' })], now).storage).toEqual([]);
  expect(
    statusGroups([task('run-heartbeat', { state: 'error', error: 'run_heartbeat_failed' })], now)
      .storage[0].value.tone,
  ).toBe('error');
});
