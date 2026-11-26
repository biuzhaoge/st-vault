import { addAbortListener } from 'node:events';
import type { BackgroundTask } from '@st-vault/api-schema';
import type { Metadata } from './metadata.js';

/** One backfill is shared by live reads. A caller can cancel only its own wait. */
export class RecordingUnitIndex {
  private work: Promise<void> | undefined;
  private readonly waiters = new Set<(error?: Error) => void>();
  private ready = false;
  private error: Error | undefined;
  private closing = false;

  constructor(private readonly db: Metadata) {}

  async status(): Promise<BackgroundTask> {
    const index = await this.db.read<{
      ready: boolean;
      processed: number;
      lastRunAtMs: number | null;
      lastSuccessAtMs: number | null;
    }>('unitIndexStatus');
    return {
      id: 'archive-index',
      group: 'processing',
      state: this.error ? 'retrying' : index.ready ? 'idle' : this.work ? 'running' : 'waiting',
      processed: index.processed,
      detail: 'index-batches',
      lastRunAtMs: index.lastRunAtMs,
      lastSuccessAtMs: index.lastSuccessAtMs,
      error: this.error ? 'recording_unit_index_failed' : null,
    };
  }

  start(): void {
    if (this.ready || this.work || this.closing) return;
    this.error = undefined;
    this.work = (async () => {
      // Recovery can defer the index only before this instance starts serving;
      // subsequent commits append synchronously to an already-ready index.
      while (!this.closing) {
        if (!(await this.db.call<boolean>('buildRecordingUnits', { limit: 32 }))) {
          this.ready = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 15));
      }
    })()
      .catch((error) => {
        this.error =
          error instanceof Error ? error : new Error('UNIT_INDEX_FAILED', { cause: error });
        console.error('recording_unit_index_failed', error);
      })
      .finally(() => {
        this.work = undefined;
        for (const settle of this.waiters) settle(this.error);
        this.waiters.clear();
      });
  }
  async wait(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.start();
    if (this.work) {
      // Abandoned reads must detach while the archive's shared backfill continues.
      await new Promise<void>((resolve, reject) => {
        const settle = (error?: Error): void => {
          listener?.[Symbol.dispose]();
          if (error) reject(error);
          else resolve();
        };
        const listener = signal
          ? addAbortListener(signal, () => {
              this.waiters.delete(settle);
              resolve();
            })
          : undefined;
        this.waiters.add(settle);
      });
    }
    signal?.throwIfAborted();
    if (this.error) throw this.error;
  }

  stop(): Promise<void> | undefined {
    this.closing = true;
    return this.work;
  }
}
