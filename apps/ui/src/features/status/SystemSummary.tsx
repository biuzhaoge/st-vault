import type { MediaDeletionJob, Subject } from '@st-vault/api-schema';
import { systemRetryTargets } from '@st-vault/api-schema';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { tr } from '../../shared/lib/i18n';
import { useDeletionProjections } from '../../shared/lib/deletion-projection';
import { PanelStatus } from '../../shared/ui/PanelContent';
import { ArchiveHealth } from './ArchiveHealth';
import { statusGroups, type StatusLine, type StatusValue } from './background-status';
import { deletionStatus } from './deletion-status';
import { systemHealthStatus } from './display';
import { StatusRetry } from './StatusRetry';
import { StatusHelp } from './StatusHelp';
import { statusHelpFor, type StatusHelpId } from './status-help';
import type { SystemInfo } from './system';
import './system-summary.css';

type RowValue = Omit<StatusValue, 'text'> & { text: ReactNode };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit += 1;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function storageValue(disk: SystemInfo['disk'] | undefined, checking: boolean): RowValue {
  if (!disk) return { text: '—' };

  const health = systemHealthStatus({ lowSpace: disk.lowSpace, diskError: disk.error });
  const note = health.messages[0];
  if (checking) return { text: tr('检查中'), tone: 'busy', note };
  if (health.kind === 'unavailable') return { text: tr('异常'), tone: 'error', note };
  const lowSpace = health.kind === 'low-space';
  if (disk.error || disk.totalBytes <= 0)
    return lowSpace ? { text: health.title, tone: 'warning', note } : { text: tr('容量待确认') };

  const usedPercent = Math.min(
    100,
    Math.max(0, ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100),
  );
  const used = Math.round(usedPercent);
  const remaining = formatBytes(disk.freeBytes);
  return {
    text: (
      <span
        className="disk-capacity"
        role="meter"
        aria-label={tr('存储空间')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
        aria-valuetext={tr('已用 {{v0}}%，剩余 {{v1}}', { v0: used, v1: remaining })}
        style={{ '--disk-used': `${usedPercent}%` } as CSSProperties}
      >
        {tr('剩余 {{v0}}', { v0: remaining })}
      </span>
    ),
    tone: lowSpace ? 'warning' : 'ok',
    note,
  };
}

function StatusRow({
  name,
  label,
  value,
  accessory,
}: {
  name: string;
  label: ReactNode;
  value: RowValue;
  accessory?: ReactNode;
}): JSX.Element {
  const { text, tone, note } = value;
  return (
    <PanelStatus
      className="system-row"
      rowId={name}
      label={label}
      value={text}
      kind={tone ?? 'neutral'}
      accessory={accessory}
      live={false}
    >
      {note && <p className="system-row-note">{note}</p>}
    </PanelStatus>
  );
}

export function SystemSummary({
  deletions = [],
  subjects = [],
  system,
  autoRecordingCount,
  onRefresh,
}: {
  deletions?: MediaDeletionJob[];
  subjects?: Subject[];
  system: SystemInfo | null;
  autoRecordingCount: number;
  onRefresh?: () => Promise<unknown>;
}): JSX.Element {
  const [helpOpen, setHelpOpen] = useState<StatusHelpId | null>(null);
  const tasks = system?.backgroundTasks ?? [];
  const disk = system?.disk;
  const recording = system?.capture;
  const empty = { text: '—' };
  const latestSubmission = useDeletionProjections().at(-1)?.job;
  const submissionError =
    latestSubmission?.state === 'failed' && latestSubmission.deletionRevision === undefined
      ? latestSubmission.error
      : null;
  const deletion = deletionStatus(deletions, subjects, system?.deletionWaiting ?? undefined);
  const groups = statusGroups(
    tasks,
    system?.capturedAtMs ?? Date.now(),
    submissionError
      ? {
          ...(deletion ?? { text: tr('删除提交已拒绝'), tone: 'warning' as const }),
          note: submissionError,
        }
      : deletion,
    new Set(
      system?.retries?.filter((attempt) => attempt.state === 'running').map(({ target }) => target),
    ),
  );
  const retryButton = (id: string, label: string) => {
    const target = systemRetryTargets.find((item) => item === id);
    if (!onRefresh || !target) return null;
    return (
      <StatusRetry
        target={target}
        label={label}
        available={system?.retryableTargets?.includes(target) ?? false}
        observed={system?.retries?.find((attempt) => attempt.target === target)}
        onRefresh={onRefresh}
      />
    );
  };
  const archive = system?.archiveHealth;
  const archiveHealth = archive
    ? systemHealthStatus({
        lowSpace: false,
        archiveError: archive.error,
        restarting: archive.recovery === 'restart-requested',
      })
    : null;
  const diskChecking = tasks.some((task) => task.id === 'disk-check' && task.state === 'running');
  const describe = statusHelpFor(system);
  const help = (id: StatusHelpId, label: string) => (
    <StatusHelp
      label={label}
      {...describe(id)}
      open={helpOpen === id}
      onOpenChange={(open) => setHelpOpen((active) => (open ? id : active === id ? null : active))}
    />
  );
  const statusRow = (id: StatusHelpId, label: string, value: RowValue) => (
    <StatusRow
      key={id}
      name={id}
      label={
        <>
          {label}
          {help(id, label)}
        </>
      }
      value={value}
      accessory={retryButton(id, label)}
    />
  );
  const statusRows = (rows: StatusLine[]) =>
    rows.map(({ id, label, value }) => statusRow(id, label, value));
  return (
    <section className="system-summary" aria-label={tr('系统状态')}>
      <section className="system-group" aria-label={tr('录制')}>
        <h3>{tr('录制')}</h3>
        {statusRow(
          'recording',
          tr('录制中'),
          recording
            ? { text: String(recording.active), tone: recording.active ? 'ok' : undefined }
            : empty,
        )}
        {statusRow('auto-recording', tr('自动录制'), { text: String(autoRecordingCount) })}
        {statusRow(
          'recording-start',
          tr('启动中'),
          recording
            ? {
                text: String(recording.starting),
                tone: recording.starting ? 'busy' : undefined,
              }
            : empty,
        )}
        {statusRow(
          'recording-reconnect',
          tr('重连中'),
          recording
            ? {
                text: String(recording.retrying),
                tone: recording.retrying ? 'warning' : undefined,
              }
            : empty,
        )}
      </section>
      {!!groups.sync.length && (
        <section className="system-group" aria-label={tr('数据同步')}>
          <h3>{tr('数据同步')}</h3>
          {statusRows(groups.sync)}
        </section>
      )}
      {!!groups.media.length && (
        <section className="system-group" aria-label={tr('媒体处理')}>
          <h3>{tr('媒体处理')}</h3>
          {statusRows(groups.media)}
        </section>
      )}
      <section className="system-group" aria-label={tr('归档与存储')}>
        <h3>{tr('归档与存储')}</h3>
        <ArchiveHealth
          health={archiveHealth}
          accessory={retryButton('archive-health', tr('归档服务'))}
          help={help('archive-health', tr('归档服务'))}
        />
        {statusRow('disk-check', tr('存储空间'), storageValue(disk, diskChecking))}
        {statusRows(groups.storage)}
      </section>
    </section>
  );
}
