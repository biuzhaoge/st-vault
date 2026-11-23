import { statfs, open, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ArchivePort } from '../ports.js';
import type { RuntimeSettings } from './settings.js';
import type { SyncClock } from './sync-clock.js';
import type { BackgroundTask } from '@st-vault/api-schema';

export interface DiskState {
  freeBytes: number;
  totalBytes: number;
  lowSpace: boolean;
  error: string | null;
  checkedAtMs: number;
}
interface ResourceOptions {
  clock?: SyncClock;
  root: string;
  dataRoot?: string;
  databaseRoot?: string;
  archive: Pick<ArchivePort, 'pruneBefore' | 'scrub'>;
  settings: () => RuntimeSettings;
  changed?: () => void;
  readDisk?: (root: string) => Promise<{ freeBytes: number; totalBytes: number }>;
  writeProbe?: (root: string) => Promise<void>;
  now?: () => number;
}
export class ResourceMonitor {
  private disk: DiskState = {
    freeBytes: 0,
    totalBytes: 0,
    lowSpace: true,
    error: 'not_checked',
    checkedAtMs: 0,
  };
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private diskPending: Promise<void> | undefined;
  private closed = false;
  private detachClock?: () => void;
  private lastPrune = 0;
  private pruneError: string | null = null;
  private integrityError: string | null = null;
  private lastScrub = 0;
  private scrubCursor: string | undefined;
  private lastWriteProbe = -Infinity;
  private writeError: string | null = null;
  private pruning: Promise<void> | undefined;
  private scrubbing: Promise<void> | undefined;
  private pruneSuccess: number | null = null;
  private scrubSuccess: number | null = null;
  private checkedFiles = 0;
  constructor(private readonly options: ResourceOptions) {}
  backgroundTasks(): BackgroundTask[] {
    const disk = this.get(),
      retention = this.options.settings().retentionDays > 0,
      now = this.options.now?.() ?? Date.now();
    return [
      {
        id: 'disk-check',
        group: 'protection',
        state: this.diskPending
          ? 'running'
          : disk.error === 'not_checked'
            ? 'waiting'
            : disk.error
              ? 'error'
              : disk.lowSpace
                ? 'paused'
                : 'idle',
        lastRunAtMs: disk.checkedAtMs || null,
        error:
          disk.error === 'not_checked'
            ? null
            : (disk.error ?? (disk.lowSpace ? 'disk_low_space' : null)),
      },
      {
        id: 'retention',
        group: 'protection',
        state: !retention
          ? 'disabled'
          : this.pruning
            ? 'running'
            : disk.error
              ? 'paused'
              : this.pruneError
                ? 'retrying'
                : 'waiting',
        lastRunAtMs: this.lastPrune || null,
        lastSuccessAtMs: this.pruneSuccess,
        nextRunAtMs: retention && !disk.error ? Math.max(now, this.lastPrune + 60000) : null,
        error: retention ? this.pruneError : null,
        detail: !retention ? 'keep-forever' : undefined,
      },
      {
        id: 'integrity-scan',
        group: 'protection',
        state: !this.options.archive.scrub
          ? 'disabled'
          : this.scrubbing
            ? 'running'
            : this.integrityError
              ? 'error'
              : disk.error
                ? 'paused'
                : 'waiting',
        lastRunAtMs: this.lastScrub || null,
        lastSuccessAtMs: this.scrubSuccess,
        nextRunAtMs:
          this.options.archive.scrub && !disk.error ? Math.max(now, this.lastScrub + 60000) : null,
        processed: this.checkedFiles,
        detail: 'checked-files',
        error: this.integrityError,
      },
    ];
  }
  get(): DiskState {
    const now = this.options.now?.() ?? Date.now();
    if (now - this.disk.checkedAtMs > Math.max(30000, this.options.settings().pollMs * 2))
      return { ...this.disk, lowSpace: true, error: this.disk.error ?? 'disk_check_stale' };
    return { ...this.disk };
  }
  maintenanceError(): string | null {
    return this.integrityError ?? this.pruneError;
  }
  canRecord = (): boolean => {
    const disk = this.get();
    return !this.closed && !disk.lowSpace && disk.error === null;
  };
  check(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.closed) return Promise.resolve();
    this.pending = this.checkDisk()
      .then(() => this.maintain())
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  async retry(target: 'disk-check' | 'retention' | 'integrity-scan'): Promise<void> {
    if (this.closed) return;
    if (target === 'disk-check') {
      if (this.writeError) this.lastWriteProbe = -Infinity;
      await this.checkDisk();
      return;
    }
    if (this.get().error) throw Error('STORAGE_UNAVAILABLE');
    const now = this.options.now?.() ?? Date.now();
    if (target === 'retention') {
      const days = this.options.settings().retentionDays;
      if (days > 0) await this.prune(now, days);
    } else {
      await this.scrub(now);
    }
  }
  /** The media commit path must not queue behind retention or integrity scans. */
  checkDisk(): Promise<void> {
    if (this.diskPending) return this.diskPending;
    if (this.closed) return Promise.resolve();
    this.diskPending = this.performDiskCheck().finally(() => {
      this.diskPending = undefined;
    });
    return this.diskPending;
  }
  private async performDiskCheck(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    const settings = this.options.settings();
    const previously = this.canRecord();
    try {
      const { root, dataRoot, databaseRoot } = this.options;
      const paths = [
        ...new Set([root, ...[dataRoot, databaseRoot].filter((item): item is string => !!item)]),
      ];
      const readDisk =
        this.options.readDisk ??
        ((directory: string) =>
          statfs(directory, { bigint: true }).then((value) => ({
            freeBytes: Math.min(Number.MAX_SAFE_INTEGER, Number(value.bavail * value.bsize)),
            totalBytes: Math.min(Number.MAX_SAFE_INTEGER, Number(value.blocks * value.bsize)),
          })));
      const all = await Promise.all(paths.map(readDisk));
      const [stats, ...data] = all;
      if (
        all.some(
          (stats) =>
            !Number.isFinite(stats.freeBytes) ||
            !Number.isFinite(stats.totalBytes) ||
            stats.freeBytes < 0 ||
            stats.totalBytes <= 0,
        )
      )
        throw new Error('INVALID_DISK_STATS');
      const dataLow = data.some((info) => info.freeBytes < settings.minFreeBytes);
      if (stats.freeBytes >= settings.minFreeBytes && now - this.lastWriteProbe >= 30000) {
        this.lastWriteProbe = now;
        try {
          for (const directory of paths)
            await (this.options.writeProbe?.(directory) ?? probeWritableDirectory(directory));
          this.writeError = null;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          this.writeError =
            code === 'EROFS'
              ? 'disk_read_only'
              : code === 'EACCES' || code === 'EPERM'
                ? 'disk_permission_denied'
                : code === 'ENOSPC'
                  ? 'disk_full'
                  : 'disk_write_failed';
          console.warn(
            JSON.stringify({ event: 'storage_write_probe_failed', reason: this.writeError }),
          );
        }
      }
      this.disk = {
        ...stats,
        lowSpace: stats.freeBytes < settings.minFreeBytes || dataLow,
        error: this.writeError ?? (dataLow ? 'data_disk_low_space' : null),
        checkedAtMs: now,
      };
    } catch {
      this.disk = { ...this.disk, lowSpace: true, error: 'disk_unavailable', checkedAtMs: now };
    }
    if (previously !== this.canRecord()) this.options.changed?.();
  }
  private async maintain(): Promise<void> {
    if (this.closed) return;
    const settings = this.options.settings(),
      now = this.options.now?.() ?? Date.now();
    if (settings.retentionDays === 0) this.pruneError = null;
    if (this.disk.error) return;
    if (settings.retentionDays > 0 && now - this.lastPrune >= 60000)
      await this.prune(now, settings.retentionDays);
    if (now - this.lastScrub >= 60000) await this.scrub(now);
  }
  private prune(now: number, days: number): Promise<void> {
    if (this.pruning) return this.pruning;
    this.lastPrune = now;
    this.pruning = Promise.resolve()
      .then(() => this.options.archive.pruneBefore(Math.max(0, now - days * 86400000)))
      .then(() => {
        this.pruneError = null;
        this.pruneSuccess = this.options.now?.() ?? Date.now();
      })
      .catch(() => {
        this.pruneError = 'retention_cleanup_failed';
      })
      .finally(() => {
        this.pruning = undefined;
      });
    return this.pruning;
  }
  private async scrub(now: number): Promise<void> {
    if (!this.options.archive.scrub || this.closed) return;
    if (this.scrubbing) return this.scrubbing;
    this.lastScrub = now;
    this.scrubbing = Promise.resolve()
      .then(() => this.options.archive.scrub!({ limit: 16, delayMs: 5, cursor: this.scrubCursor }))
      .then((result) => {
        this.scrubCursor = result.nextCursor ?? undefined;
        this.integrityError = null;
        this.checkedFiles += result.checked;
        this.scrubSuccess = this.options.now?.() ?? Date.now();
      })
      .catch(() => {
        this.integrityError = 'archive_integrity_check_failed';
      })
      .finally(() => {
        this.scrubbing = undefined;
      });
    return this.scrubbing;
  }
  start(): void {
    if (this.options.clock) {
      this.detachClock ??= this.options.clock.subscribe('resources', () => this.check());
      return;
    }
    const schedule = (): void => {
      if (this.closed) return;
      this.timer = setTimeout(() => {
        void this.check().finally(schedule);
      }, 15000);
      this.timer.unref();
    };
    if (!this.timer && !this.closed) schedule();
  }
  async close(): Promise<void> {
    this.closed = true;
    this.detachClock?.();
    if (this.timer) clearTimeout(this.timer);
    await Promise.all([this.pending, this.diskPending, this.pruning, this.scrubbing]);
  }
}

/** Own a unique one-byte file; never overwrite or remove an existing data file. */
export async function probeWritableDirectory(root: string): Promise<void> {
  const filename = path.join(root, `.write-probe-${randomUUID()}.tmp`);
  const file = await open(filename, 'wx', 0o600);
  try {
    await file.writeFile(new Uint8Array([0]));
    await file.sync();
  } finally {
    try {
      await file.close();
    } finally {
      await unlink(filename);
    }
  }
}
