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
    task('site-access', { state: 'error', error: 'site_unavailable', consecutiveFailures: 3 }),
    task('account-list', {
      state: 'error',
      error: 'cookies_domain_mismatch',
      consecutiveFailures: 3,
    }),
    task('cover-sync', {
      state: 'retrying',
      error: 'cover_refresh_partial',
      consecutiveFailures: 1,
    }),
    task('avatar-sync', { state: 'idle' }),
  ];
  const rows = statusGroups(tasks, now).sync;
  expect(rows.map((item) => item.value.tone)).toEqual(['error', 'error', undefined, undefined]);
  expect(rows[1].value.note).toContain('Cookies 与所选站点域名不匹配');
  expect(rows[2].value.note).toContain('下载失败');
  expect(backgroundTaskAlert(tasks)).toBe('绑定站点访问异常');
});

it('only raises a sync alert after three failed rounds and keeps the original reason', () => {
  for (const consecutiveFailures of [undefined, 1, 2]) {
    const cover = task('cover-sync', {
      state: 'retrying',
      error: 'cover_refresh_partial',
      consecutiveFailures,
      failed: 41,
    });
    expect(statusGroups([cover], now).sync[0].value).toEqual({
      text: '本轮未完成',
      note: '部分图片下载失败，已有图片继续使用。',
    });
    expect(backgroundTaskAlert([cover])).toBeUndefined();
  }
  const capture = task('capture-status', {
    state: 'running',
    consecutiveFailures: 3,
    error: 'status_sync_failed',
  });
  const alarm = statusGroups([capture], now).sync[0].value;
  expect(alarm).toMatchObject({ text: '异常', tone: 'error' });
  expect(alarm.note).toContain('连续 3 轮未完成');
  expect(backgroundTaskAlert([capture])).toBe('后台任务异常');
  const recovered = { ...capture, state: 'waiting', consecutiveFailures: 0, error: null } as const;
  expect(backgroundTaskAlert([recovered])).toBeUndefined();
  expect(statusGroups([recovered], now).sync[0].value).toEqual({ text: '等待' });
});

it('keeps a stopped account connection actionable without promising a scheduled retry', () => {
  const account = task('account-list', {
    state: 'error',
    detail: 'account-reconnect',
    error: 'cookies_expired',
    consecutiveFailures: 1,
  });
  const reconnect = statusGroups([account], now).sync[0].value;
  expect(reconnect).toMatchObject({ text: '需要更新 Cookies', tone: 'warning' });
  expect(reconnect.note).toContain('更新 Cookies');
  expect(backgroundTaskAlert([account])).toBe('需要更新 Cookies');
});

it('explains how many followed broadcasters are retained while the list is rechecked', () => {
  const account = task('account-list', { detail: 'account-roster-pending', pending: 18 });
  expect(statusGroups([account], now).sync[0].value).toEqual({
    text: '原站清单缺项 · 18 位主播',
    tone: 'warning',
    note: '已保留这些主播，清单同步会继续核实。',
  });
  expect(backgroundTaskAlert([account])).toBeUndefined();
});

it('shows pending profiles without repeating the following total', () => {
  const account = task('account-list', {
    detail: 'account-roster-pending',
    pending: 18,
    accountRoster: { favoritesIndexCount: 132, pendingProfileCount: 4 },
  });
  expect(statusGroups([account], now).sync[0].value).toEqual({
    text: '原站清单缺项 · 18 位主播',
    tone: 'warning',
    note: '已保留这些主播，清单同步会继续核实。 待补资料 4',
  });
  const empty = task('account-list', {
    accountRoster: { favoritesIndexCount: 0, pendingProfileCount: 0 },
  });
  expect(statusGroups([empty], now).sync[0].value.note).toBeUndefined();
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
