import { tr } from '../../shared/lib/i18n';
import type { StatusLine } from './background-status';
import type { SystemInfo } from './system';

export type StatusHelpId =
  | StatusLine['id']
  | 'recording'
  | 'auto-recording'
  | 'recording-start'
  | 'recording-reconnect'
  | 'archive-health'
  | 'disk-check';

type Setting = 'pollMs' | 'retentionDays' | 'minFreeBytes';
const entries: Record<StatusHelpId, { description: string; setting?: Setting }> = {
  recording: {
    description: '统计正在保存公开直播的主播。直播结束或触发存储保护时停止录制。',
    setting: 'minFreeBytes',
  },
  'auto-recording': {
    description:
      '统计已开启自动录制的主播。可用封面上的开关单独调整，也可在设置中使用「全部主播录制」。',
  },
  'recording-start': {
    description: '统计正在排队或获取直播流的主播。收到并写入首个分片后计入录制中。',
  },
  'recording-reconnect': {
    description:
      '统计正在等待重连的录制。自动录制开启且主播仍可录制时，系统会在等待期结束后再拉流。',
  },
  'site-access': {
    description: '根据访问结果检查账户绑定域名是否可用。更换域名时，在账户面板断开并重新连接。',
  },
  'account-list': {
    description:
      '通过已导入的 Cookies 更新关注清单和账户资料。会话失效时，在账户面板更新 Cookies。',
    setting: 'pollMs',
  },
  'capture-status': {
    description: '匿名查询主播的公开状态，更新在线分组和状态时间线。',
    setting: 'pollMs',
  },
  'cover-sync': {
    description: '连接账户后预取关注主播的默认封面。清单刷新时补齐新图，直播预览随状态更新。',
  },
  'avatar-sync': {
    description:
      '连接账户后预取关注主播的头像。清单刷新时下载新增或有变化的头像，供历史等位置使用。',
    setting: 'pollMs',
  },
  'client-sync': {
    description: '通过 SSE 通知浏览器更新列表、时间线和状态。重连后刷新当前视图。',
    setting: 'pollMs',
  },
  'public-status-evidence': {
    description:
      '复核可疑的主播状态变化。确认后把转换时间记在首次有效观测处，查询失败时保留原有观测。',
    setting: 'pollMs',
  },
  snapshots: {
    description: '后台从每个录像单元选取可解码画面并保存 JPEG。新录像落盘后入队，重启后继续处理。',
  },
  deletion: {
    description:
      '执行已确认的录像删除任务，先更新可见范围，再分批回收文件。刷新页面或重启后可以继续。',
  },
  'snapshot-maintenance': {
    description: '定期分批校验已有截图、补做缺失项并回收临时文件。读取或写入失败会安排重试。',
  },
  'archive-index': {
    description:
      '为录像分片整理单元索引，供时间线、截图和回放定位使用。需要补建的历史索引在后台处理。',
  },
  'favorite-materialization': {
    description: '将已保存的收藏操作分批写入媒体库索引，供收藏列表和保留期清理使用。',
  },
  'archive-health': {
    description: '检查归档索引能否读取。确认归档工作进程故障、且存储允许时，服务会尝试恢复。',
    setting: 'pollMs',
  },
  'disk-check': {
    description: '显示媒体盘容量，并检查数据和媒体目录能否写入。低于阈值时暂停录制，恢复后继续。',
    setting: 'minFreeBytes',
  },
  retention: {
    description: '按录像保留天数清理过期媒体，收藏的录像受保护。设为 0 天可永久保留。',
    setting: 'retentionDays',
  },
  'integrity-scan': {
    description: '按计划分批读取归档文件，核验文件与索引记录是否一致。出现错误时可按需重试。',
  },
  'library-checkpoint': {
    description: '按媒体库变更和时间条件保存一致快照。重建索引时会用到该快照和后续日志。',
  },
  'orphan-sweep': {
    description: '在恢复时分批核对媒体文件，将索引中没有登记的文件隔离，便于后续核查。',
  },
  'run-heartbeat': {
    description: '记录服务的最后运行时间，重启后用于识别上次是否异常退出。',
    setting: 'pollMs',
  },
};

export function statusHelpFor(system: SystemInfo | null) {
  const settings = system?.settings;
  const pollMs = settings?.pollMs ?? system?.capture?.pollMs;
  const parameters = {
    pollMs: pollMs == null ? undefined : tr('统一同步间隔 {{v0}} 秒', { v0: pollMs / 1000 }),
    retentionDays: settings
      ? tr('录像保留天数 {{v0}} 天', { v0: settings.retentionDays })
      : undefined,
    minFreeBytes: settings
      ? tr('最低剩余空间 {{v0}} GiB', { v0: settings.minFreeBytes / 1024 ** 3 })
      : undefined,
  };
  return (id: StatusHelpId) => {
    const { description, setting } = entries[id];
    return { description: tr(description), parameter: setting && parameters[setting] };
  };
}
