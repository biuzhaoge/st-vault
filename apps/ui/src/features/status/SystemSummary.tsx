import type { MediaDeletionJob, Subject } from '@st-vault/api-schema';
import { systemRetryTargets } from '@st-vault/api-schema';
import type { ReactNode } from 'react';
import { tr } from '../../shared/lib/i18n';
import { PanelStatus } from '../../shared/ui/PanelContent';
import { ArchiveHealth } from './ArchiveHealth';
import { statusGroups, type StatusLine, type StatusValue } from './background-status';
import { deletionStatus } from './deletion-status';
import { diskUnobserved, systemHealthStatus } from './display';
import { StatusRetry } from './StatusRetry';
import type { SystemInfo } from './system';
import './system-summary.css';

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

function StatusRow({
  name,
  label,
  value,
  accessory,
}: {
  name: string;
  label: string;
  value: StatusValue;
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
  const tasks = system?.backgroundTasks ?? [];
  const disk = system?.disk;
  const recording = system?.capture;
  const diskRatio = disk?.totalBytes
    ? Math.min(1, Math.max(0, disk.freeBytes / disk.totalBytes))
    : 0;
  const empty = { text: '—' };
  const groups = statusGroups(
    tasks,
    system?.capturedAtMs ?? Date.now(),
    deletionStatus(deletions, subjects),
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
  const diskHealth = disk && systemHealthStatus({ lowSpace: disk.lowSpace, diskError: disk.error });
  const diskChecking = tasks.some((task) => task.id === 'disk-check' && task.state === 'running');
  const statusRows = (rows: StatusLine[]) =>
    rows.map(({ id, label, value }) => (
      <StatusRow
        key={id}
        name={id}
        label={label}
        value={value}
        accessory={retryButton(id, label)}
      />
    ));
  return (
    <section className="system-summary" aria-label={tr('系统状态')}>
      <section className="system-group" aria-label={tr('录制')}>
        <h3>{tr('录制')}</h3>
        <StatusRow
          name="recording"
          label={tr('录制中')}
          value={recording ? { text: String(recording.active) } : empty}
        />
        <StatusRow
          name="auto-recording"
          label={tr('自动录制')}
          value={{ text: String(autoRecordingCount) }}
        />
        <StatusRow
          name="recording-start"
          label={tr('启动中')}
          value={
            recording
              ? { text: String(recording.starting), tone: recording.starting ? 'busy' : undefined }
              : empty
          }
        />
        <StatusRow
          name="recording-reconnect"
          label={tr('重连中')}
          value={
            recording
              ? {
                  text: String(recording.retrying),
                  tone: recording.retrying ? 'warning' : undefined,
                }
              : empty
          }
        />
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
        />
        <StatusRow
          name="disk-check"
          label={tr('存储空间')}
          value={
            disk
              ? {
                  text: diskChecking
                    ? tr('检查中')
                    : disk.totalBytes
                      ? tr('剩余 {{v0}}', { v0: formatBytes(disk.freeBytes) })
                      : tr('容量待确认'),
                  tone: diskChecking
                    ? 'busy'
                    : diskUnobserved(disk.error)
                      ? undefined
                      : disk.error
                        ? 'error'
                        : disk.lowSpace
                          ? 'warning'
                          : undefined,
                  note: diskHealth?.messages[0],
                }
              : empty
          }
          accessory={
            <>
              {disk && !disk.error && disk.totalBytes > 0 && (
                <div
                  className="disk-track"
                  role="progressbar"
                  aria-label={tr('磁盘剩余空间')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(diskRatio * 100)}
                >
                  <span style={{ width: `${diskRatio * 100}%` }} />
                </div>
              )}
              {retryButton('disk-check', tr('存储空间'))}
            </>
          }
        />
        {statusRows(groups.storage)}
      </section>
    </section>
  );
}
