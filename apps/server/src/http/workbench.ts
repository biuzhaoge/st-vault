import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type {
  CoverageResponse,
  PublicStatus,
  StatusHistoryBucket,
  StatusHistoryResponse,
} from '@st-vault/api-schema';
import type { ArchivePort } from '../ports.js';
import { ProviderError } from '../provider/http.js';
import { MediaBudget } from '../provider/media-budget.js';
import {
  archiveWindows,
  WORKBENCH_WINDOW_MS,
  type CalendarArchive,
} from '../archive/calendar-window.js';

export interface WorkbenchOptions {
  maxRequests?: number;
  rowConcurrency?: number;
  totalRowConcurrency?: number;
}

type WorkbenchArchive = Pick<ArchivePort, 'workbenchRow'> & CalendarArchive;
interface Row {
  subjectId: string;
  coverage: CoverageResponse;
  status: StatusHistoryResponse;
}
interface Task {
  cancel: () => void;
  done: Promise<void>;
}
type AbortSource = 'client' | 'shutdown' | 'read-error';
const statuses: PublicStatus[] = ['UNKNOWN', 'PUBLIC', 'PRIVATE', 'OFFLINE'];
const subject = z
  .string()
  .regex(/^stripchat:[1-9]\d*$/)
  .refine((value) => Number.isSafeInteger(Number(value.slice(10))));
const querySchema = z
  .object({
    ids: z
      .string()
      .max(2048)
      .transform((value) => [...new Set(value.split(','))])
      .pipe(z.array(subject).min(1).max(24)),
    from: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    to: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    buckets: z.coerce.number().int().min(1).max(720).default(360),
    protection: z
      .string()
      .max(2048)
      .transform((value) => [...new Set(value.split(','))])
      .pipe(z.array(subject).max(24))
      .optional(),
  })
  .strict()
  .refine((value) => value.to > value.from);
function dominant(bucket: StatusHistoryBucket): PublicStatus {
  return statuses.reduce(
    (best, status) => (bucket.durationsMs[status] > bucket.durationsMs[best] ? status : best),
    'UNKNOWN',
  );
}
function compactStatus(response: StatusHistoryResponse): StatusHistoryResponse {
  const buckets: StatusHistoryBucket[] = [];
  let previousStatus: PublicStatus | undefined;
  for (const bucket of response.buckets) {
    const state = dominant(bucket),
      last = buckets.at(-1);
    if (last && previousStatus === state && last.toMs === bucket.fromMs) {
      last.toMs = bucket.toMs;
      for (const status of statuses) last.durationsMs[status] += bucket.durationsMs[status];
    } else buckets.push({ ...bucket, durationsMs: { ...bucket.durationsMs } });
    previousStatus = state;
  }
  return { ...response, buckets };
}
/** Hold the request slot while a slow client still owns its JSON payload. */
async function deliver(reply: FastifyReply, rows: Row[], signal: AbortSignal): Promise<void> {
  if (signal.aborted || reply.raw.destroyed) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      reply.raw.removeListener('finish', done);
      reply.raw.removeListener('close', done);
      signal.removeEventListener('abort', cancel);
    };
    const done = (): void => {
      cleanup();
      resolve();
    };
    const cancel = (): void => {
      reply.raw.destroy();
    };
    reply.raw.once('finish', done);
    reply.raw.once('close', done);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      reply.send({ rows });
    } catch (error) {
      cleanup();
      reject(error instanceof Error ? error : new Error('WORKBENCH_SEND_FAILED'));
    }
  });
}
/** Register in the authenticated app scope; batches contain no upstream requests or cache. */
export function registerWorkbench(
  app: FastifyInstance,
  archive: WorkbenchArchive,
  options: WorkbenchOptions = {},
): void {
  const tasks = new Set<Task>();
  const rowSlots = new MediaBudget(options.totalRowConcurrency ?? 8);
  let closed = false;
  let lastDiagnosticAt = -Infinity;
  app.get('/api/workbench', async (request, reply) => {
    const query = querySchema.parse(request.query);
    reply.header('cache-control', 'private, no-store');
    if (closed) return reply.code(503).send({ error: 'workbench_unavailable' });
    if (tasks.size >= (options.maxRequests ?? 4))
      return reply.code(429).send({ error: 'workbench_busy' });
    const started = performance.now();
    const controller = new AbortController();
    const { signal } = controller;
    let abortedAt: number | undefined;
    let abortSource: AbortSource | undefined;
    let maxRowQueueMs = 0,
      maxArchiveReadMs = 0,
      rowsAdmitted = 0,
      rowsBuilt = 0,
      rowsCancelledWhileWaiting = 0;
    const abort = (source: AbortSource): void => {
      if (signal.aborted) return;
      abortSource = source;
      abortedAt = performance.now();
      controller.abort();
    };
    const cancel = (): void => abort('client');
    const disconnected = (): void => {
      if (!reply.raw.writableFinished) cancel();
    };
    request.raw.once('aborted', cancel);
    reply.raw.once('close', disconnected);
    if (request.raw.aborted || reply.raw.destroyed) cancel();
    const done = (async () => {
      if (query.to - query.from > WORKBENCH_WINDOW_MS)
        await archiveWindows(archive, query.from, query.to, WORKBENCH_WINDOW_MS);
      const rows: Row[] = new Array<Row>(query.ids.length);
      let index = 0;
      const read = <T>(start: () => Promise<T>): Promise<T | null> =>
        Promise.resolve()
          .then(() => (signal.aborted ? null : start()))
          .catch((error: unknown) => {
            if (signal.aborted && error === signal.reason) return null;
            abort('read-error');
            throw error;
          });
      const readRow = async (subjectId: string): Promise<Row | null> => {
        const queuedAt = performance.now();
        let release: () => void;
        try {
          release = await rowSlots.acquire(signal);
        } catch (error) {
          if (signal.aborted && error instanceof ProviderError && error.code === 'cancelled') {
            // An aborted waiter must not mask the read failure that cancelled it.
            rowsCancelledWhileWaiting++;
            return null;
          }
          throw error;
        } finally {
          maxRowQueueMs = Math.max(maxRowQueueMs, performance.now() - queuedAt);
        }
        try {
          if (signal.aborted) return null;
          rowsAdmitted++;
          const admittedAt = performance.now();
          const result = await read(() =>
            archive.workbenchRow(
              subjectId,
              query.from,
              query.to,
              query.buckets,
              query.protection?.includes(subjectId) ?? false,
              signal,
            ),
          ).finally(() => {
            maxArchiveReadMs = Math.max(maxArchiveReadMs, performance.now() - admittedAt);
          });
          if (signal.aborted || !result) return null;
          rowsBuilt++;
          return {
            subjectId,
            coverage: {
              ...result.coverage,
              buckets: result.coverage.buckets.filter((bucket) => bucket.coveredMs > 0),
            },
            status: compactStatus(result.status),
          };
        } finally {
          release();
        }
      };
      const worker = async (): Promise<void> => {
        while (!signal.aborted && index < query.ids.length) {
          const position = index++;
          const row = await readRow(query.ids[position]);
          if (row) rows[position] = row;
        }
      };
      const results = await Promise.allSettled(
        Array.from({ length: options.rowConcurrency ?? 3 }, () => worker()),
      );
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      if (!signal.aborted) await deliver(reply, rows, signal);
    })();
    const task: Task = {
      done,
      cancel: () => {
        abort('shutdown');
        if (!reply.raw.writableFinished) reply.raw.destroy();
      },
    };
    tasks.add(task);
    try {
      await done;
      return reply;
    } finally {
      tasks.delete(task);
      request.raw.removeListener('aborted', cancel);
      reply.raw.removeListener('close', disconnected);
      const finished = performance.now(),
        elapsedMs = finished - started;
      if ((signal.aborted || elapsedMs >= 500) && finished - lastDiagnosticAt >= 10000) {
        lastDiagnosticAt = finished;
        request.log.info({
          event: 'workbench_batch_timing',
          spanHours: (query.to - query.from) / 3600000,
          buckets: query.buckets,
          rowsRequested: query.ids.length,
          rowsAdmitted,
          rowsBuilt,
          rowsCancelledWhileWaiting,
          maxRowQueueMs: Math.round(maxRowQueueMs),
          maxArchiveReadMs: Math.round(maxArchiveReadMs),
          elapsedMs: Math.round(elapsedMs),
          abortSource,
          ...(abortedAt === undefined ? {} : { drainMs: Math.round(finished - abortedAt) }),
        });
      }
    }
  });
  app.addHook('preClose', async () => {
    closed = true;
    for (const task of tasks) task.cancel();
    await Promise.allSettled([...tasks].map((task) => task.done));
  });
}
