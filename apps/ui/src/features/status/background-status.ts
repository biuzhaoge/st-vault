import type { BackgroundTask } from '@st-vault/api-schema';
import { ApiError } from '../../shared/lib/api';
import { messageFor } from '../../shared/lib/errors';
import { tr } from '../../shared/lib/i18n';
import { clockLabel, dayKey } from '../../shared/lib/date-label';

export interface StatusValue {
  text: string;
  tone?: 'ok' | 'busy' | 'warning' | 'error';
  note?: string;
}
export interface StatusLine {
  id: (typeof groups)[keyof typeof groups][number][0];
  label: string;
  value: StatusValue;
}

const errors: Record<string, string> = {
  account_reconnect: '请在账户面板更新 Cookies。',
  account_sync_failed: '关注清单同步未完成，请查看账户面板。',
  image_refresh_partial: '部分图片下载失败，已有图片继续使用。',
  cover_refresh_partial: '部分图片下载失败，已有图片继续使用。',
  avatar_refresh_partial: '部分图片下载失败，已有图片继续使用。',
  status_sync_failed: '本轮主播状态同步未完成，将重新尝试。',
  client_sync_failed: '客户端更新推送中断，正在重新连接。',
  site_unavailable: '绑定站点访问失败，将在该站点继续重试；换站需先退出账户。',
  site_verification_required: '绑定站点要求人机验证，现有数据会继续保留。',
  site_request_timeout: '绑定站点的数据请求超时，后续实际请求会重新确认状态。',
  site_network_unavailable: '容器连接绑定站点失败，请检查容器的网络与 DNS。',
  site_rate_limited: '站点暂时限制请求频率，后续请求将重新确认状态。',
  site_response_invalid: '站点接口返回了无法读取的数据，正在等待后续确认。',
  screenshot_storage_unavailable: '截图存储暂不可用，正在重试。',
  screenshot_cleanup_failed: '截图缓存回收未完成，将再次尝试。',
  screenshot_audit_failed: '截图校验未完成，将再次尝试。',
  favorite_materialization_failed: '喜欢标记已保存，后台整理将再次尝试。',
  library_checkpoint_failed: '媒体库检查点未完成，日志仍保留，将再次尝试。',
  library_write_recovery_required: '媒体库持久写入中断，请恢复存储后重启服务。',
  recording_unit_index_failed: '录像索引未完成，请检查归档状态。',
  orphan_cleanup_failed: '遗留文件检查未完成，请检查归档状态。',
  run_heartbeat_failed: '运行心跳未写入，正在重新尝试。',
  screenshot_invalidation_failed: '截图更新未完成，将再次尝试。',
  screenshot_claim_failed: '截图任务未能更新，将再次尝试。',
  archive_integrity_check_failed: '归档完整性巡检失败，请检查归档状态并确认已有备份。',
  retention_cleanup_failed: '保留期自动清理失败，请检查存储空间和目录权限。',
  empty_day_cleanup_failed: '无录像日期的历史清理未完成，将再次尝试。',
  deletion_retry: '文件回收已暂停，存储恢复后继续。',
};

const unobserved = 'task_status_unavailable';
const groups = {
  sync: [
    ['site-access', '账户绑定站点'],
    ['account-list', '关注清单同步'],
    ['capture-status', '主播状态同步'],
    ['archive-reasons', '归档原因核验'],
    ['cover-sync', '封面更新'],
    ['avatar-sync', '头像更新'],
    ['client-sync', '客户端更新'],
    ['public-status-evidence', '主播状态核验', true],
  ],
  media: [
    ['snapshots', '截图生成'],
    ['deletion', '录像删除'],
    ['snapshot-maintenance', '截图维护'],
    ['archive-index', '录像整理'],
    ['favorite-materialization', '收藏整理', true],
  ],
  storage: [
    ['retention', '保留期清理'],
    ['empty-day-cleanup', '无录像日期清理', true],
    ['integrity-scan', '完整性巡检'],
    ['library-checkpoint', '媒体库检查点', true],
    ['orphan-sweep', '遗留文件检查', true],
    ['run-heartbeat', '运行心跳', true],
  ],
} as const;

const syncAlarmAfter = 3;

export function isPeriodicSyncTask(id: string): boolean {
  return groups.sync.some(([taskId]) => taskId === id);
}

function needsAccountReconnect(task: BackgroundTask): boolean {
  return (
    task.id === 'account-list' &&
    (task.detail === 'account-reconnect' || task.error === 'account_reconnect')
  );
}

function persistentSyncFailure(task: BackgroundTask): boolean {
  return (task.consecutiveFailures ?? 0) >= syncAlarmAfter;
}

function issueStatus(task: BackgroundTask): StatusValue | undefined {
  const periodic = isPeriodicSyncTask(task.id);
  const failures = task.consecutiveFailures ?? 0;
  const reconnect = periodic && needsAccountReconnect(task);
  if (task.error === unobserved)
    return {
      text: tr('检查中'),
      ...(periodic ? {} : { tone: 'warning' }),
      note: tr('状态暂不可用，将自动重试。'),
    };
  if (
    !task.error &&
    task.state !== 'error' &&
    task.state !== 'retrying' &&
    !(periodic && failures > 0) &&
    !reconnect
  )
    return undefined;
  const reason = task.error ? errors[task.error] : undefined;
  const note = reason
    ? tr(reason)
    : task.id === 'account-list' && task.error
      ? messageFor(new ApiError(task.error, 400))
      : !periodic && task.state !== 'retrying'
        ? tr('任务异常，请查看运行日志。')
        : undefined;
  if (periodic) {
    if (reconnect)
      return {
        text: tr('需要更新 Cookies'),
        tone: 'warning',
        note: note ?? tr(errors.account_reconnect),
      };
    if (failures >= syncAlarmAfter) {
      const count = tr('连续 {{v0}} 轮未完成', {
        v0: failures.toLocaleString(),
      });
      return { text: tr('异常'), tone: 'error', note: note ? `${count} · ${note}` : count };
    }
    if (task.state === 'running')
      return { text: tr('正在刷新'), tone: 'busy', ...(note ? { note } : {}) };
    return { text: tr('本轮未完成'), ...(note ? { note } : {}) };
  }
  return {
    text: task.state === 'retrying' ? tr('等待重试') : tr('异常'),
    tone: task.state === 'retrying' ? 'warning' : 'error',
    ...(note ? { note } : {}),
  };
}

/** Top-level alarms use completed sync failures instead of the raw last error. */
export function backgroundTaskAlert(tasks: BackgroundTask[]): string | undefined {
  const alarms = tasks.filter(
    (task) =>
      task.id !== 'site-probe' &&
      task.error !== unobserved &&
      (isPeriodicSyncTask(task.id)
        ? persistentSyncFailure(task) || needsAccountReconnect(task)
        : Boolean(task.error)),
  );
  if (alarms.some(needsAccountReconnect)) return tr('需要更新 Cookies');
  if (alarms.some((task) => task.id === 'site-access')) return tr('绑定站点访问异常');
  if (alarms.some((task) => task.id === 'account-list')) return tr('关注清单同步异常');
  if (alarms.length) return tr('后台任务异常');
  return undefined;
}

function scheduledValue(task: BackgroundTask, now: number): StatusValue {
  const issue = issueStatus(task);
  if (issue) return issue;
  if (task.detail === 'screenshot-storage-opening')
    return { text: tr('正在打开截图存储'), tone: 'busy' };
  if (task.state === 'running') {
    if (task.id === 'snapshots' && task.active)
      return { text: tr('正在生成 {{v0}} 张截图', { v0: task.active }), tone: 'busy' };
    return { text: tr(task.group === 'sync' ? '正在刷新' : '处理中'), tone: 'busy' };
  }
  if (task.state === 'disabled')
    return { text: tr(task.id === 'account-list' ? '未连接账户' : '已关闭') };
  if (task.state === 'paused') return { text: tr('已暂停'), tone: 'warning' };
  if (task.id === 'site-access' && task.state === 'idle')
    return { text: task.target ?? tr('可用'), tone: 'ok' };
  if (task.detail === 'account-roster-pending' && task.pending)
    return {
      text: tr('原站清单缺项 · {{v0}} 位主播', { v0: task.pending.toLocaleString() }),
      tone: 'warning',
      note: tr('已保留这些主播，清单同步会继续核实。'),
    };
  if (task.pending) return { text: tr('待处理 {{v0}}', { v0: task.pending.toLocaleString() }) };
  const next = task.nextRunAtMs;
  if (task.state === 'waiting' && task.group === 'sync' && typeof next === 'number' && next > now) {
    const time = `${dayKey(next) === dayKey(now) ? '' : `${dayKey(next)} `}${clockLabel(next)}`;
    return { text: tr('下次刷新 {{v0}}', { v0: time }) };
  }
  return { text: tr(task.state === 'waiting' ? '等待' : '空闲') };
}

function withPendingProfiles(value: StatusValue, pending?: number): StatusValue {
  if (!pending) return value;
  const count = tr('待补资料 {{v0}}', { v0: pending.toLocaleString() });
  return { ...value, note: value.note ? `${value.note} ${count}` : count };
}

export function statusGroups(
  tasks: BackgroundTask[],
  now: number,
  deletion?: StatusValue,
  retrying?: ReadonlySet<string>,
): Record<keyof typeof groups, StatusLine[]> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const rows = (group: keyof typeof groups): StatusLine[] =>
    groups[group].flatMap(([id, title, optional]) => {
      const task = byId.get(id);
      const deletionValue = id === 'deletion' ? deletion : undefined;
      const taskValue =
        task && (optional && !retrying?.has(id) ? issueStatus(task) : scheduledValue(task, now));
      const value = deletionValue ?? taskValue;
      if (!value) return [];
      return [
        {
          id,
          label: tr(title),
          value: withPendingProfiles(value, task?.accountRoster?.pendingProfileCount),
        },
      ];
    });
  return { sync: rows('sync'), media: rows('media'), storage: rows('storage') };
}
