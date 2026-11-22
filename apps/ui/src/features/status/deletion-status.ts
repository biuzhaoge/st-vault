import type { MediaDeletionJob, Subject } from '@st-vault/api-schema';
import { tr } from '../../shared/lib/i18n';

function deletionPriority(job: MediaDeletionJob): number {
  if (job.state === 'failed') return 3;
  if (job.state === 'retry' || job.error) return 2;
  return job.state === 'queued' ? 0 : 1;
}

/** Show the oldest job at the highest priority and count the remaining jobs. */
export function deletionStatus(jobs: MediaDeletionJob[], subjects: Subject[]) {
  const cancelled = (job: MediaDeletionJob) =>
    job.state === 'failed' && job.error === 'media_selection_stale';
  const jobsInView = jobs.filter((job) => job.state !== 'completed' && !cancelled(job));
  const job = jobsInView.reduce<MediaDeletionJob | undefined>(
    (first, job) =>
      !first ||
      deletionPriority(job) > deletionPriority(first) ||
      (deletionPriority(job) === deletionPriority(first) && job.createdAtMs < first.createdAtMs)
        ? job
        : first,
    undefined,
  );
  if (!job) {
    const latest = jobs.reduce<MediaDeletionJob | undefined>(
      (previous, item) => (!previous || item.updatedAtMs > previous.updatedAtMs ? item : previous),
      undefined,
    );
    if (latest && cancelled(latest))
      return {
        text: tr('上次删除已取消'),
        note: tr('准备期间收藏发生变化，原录像已保留。重新选区确认即可。'),
      };
    return undefined;
  }
  const name = subjects.find((subject) => subject.id === job.subjectId)?.handle ?? job.subjectId;
  const additional =
    jobsInView.length > 1 ? tr('另有 {{v0}} 项删除任务', { v0: jobsInView.length - 1 }) : '';
  const priority = deletionPriority(job);
  const prefix =
    priority === 3
      ? tr('删除未完成')
      : priority === 2
        ? tr('删除等待恢复')
        : job.state === 'preparing'
          ? tr('正在准备删除')
          : job.state === 'queued'
            ? tr('删除等待执行')
            : tr('正在删除');
  let detail = '';
  if (priority === 3) detail = tr('准备失败，原画面已保留。');
  else if (priority === 2) detail = tr('后台暂不可用，将自动继续。');
  else if (job.state === 'preparing') {
    if (job.phase === 'plan' && job.total)
      detail = tr('已核对 {{v0}} 个分片', { v0: job.total.toLocaleString() });
    else if (job.scannedUnits)
      detail = tr('已检查 {{v0}} 个单元', { v0: job.scannedUnits.toLocaleString() });
  } else if (job.state === 'running' && job.total > 0)
    detail = tr('已处理 {{v0}} / {{v1}} 个分片', {
      v0: Math.min(job.processed, job.total).toLocaleString(),
      v1: job.total.toLocaleString(),
    });
  return {
    text: [prefix, name, detail, additional].filter(Boolean).join(' · '),
    tone:
      priority === 3
        ? ('error' as const)
        : priority === 2
          ? ('warning' as const)
          : priority === 1
            ? ('busy' as const)
            : undefined,
  };
}
