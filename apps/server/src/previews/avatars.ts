import path from 'node:path';
import type { ArchivePort } from '../ports.js';
import type { SyncClock } from '../runtime/sync-clock.js';
import { createHttp } from '../provider/http.js';
import { coverSource } from '../provider/cover-source.js';
import { PreviewDiskCache } from './disk-cache.js';
import { LibraryImages } from '../library/images.js';
import { createPreviewImageReader, missingImageResponse, previewImageType } from './image-type.js';
import type { BackgroundTask } from '@st-vault/api-schema';
import { DerivativeDiagnostics } from './derivative-diagnostics.js';

/** Roster imports wake the portrait workers; browser reads only request a heartbeat check. */
export function createSubjectAvatars(options: {
  root: string;
  mediaRoot?: string;
  archive: Pick<ArchivePort, 'getSetting' | 'setSetting' | 'listSubjects'> &
    Partial<Pick<ArchivePort, 'getSubject' | 'withBackgroundReads'>>;
  clock?: SyncClock;
  fetch?: typeof fetch;
  concurrency?: number;
  publishConcurrency?: number;
}) {
  if (
    !Number.isInteger(options.concurrency ?? 2) ||
    (options.concurrency ?? 2) < 1 ||
    (options.concurrency ?? 2) > 64
  )
    throw Error('INVALID_AVATAR_CONCURRENCY');
  const disk = options.mediaRoot
    ? new LibraryImages(options.mediaRoot, 'avatar', options.publishConcurrency)
    : new PreviewDiskCache(path.join(options.root, 'avatars'), 64 * 1024 ** 2, 2048);
  const pending = new Set<string>();
  const roster = new Set<string>();
  const failures = new Map<
    string,
    {
      source: string | null;
      attempts: number;
      consecutiveFailures: number;
      retryAt: number;
      missing: boolean;
    }
  >();
  const diagnostics = new DerivativeDiagnostics();
  const controller = new AbortController();
  const readImage = createPreviewImageReader(
    createHttp({
      fetch: options.fetch,
      timeoutMs: 5000,
      allow: (url) => coverSource(url.href) !== null,
    }),
  );
  let work: Promise<void> | undefined;
  let lastRunAtMs: number | null = null,
    lastSuccessAtMs: number | null = null,
    runFailures = 0;
  const refresh = (manual = true): Promise<void> => {
    if (work) return work;
    if (controller.signal.aborted) return Promise.resolve();
    const batch = (retryNow = false) => {
      const now = Date.now();
      return [...new Set([...roster, ...pending, ...failures.keys()])].filter((id) => {
        const failure = failures.get(id);
        return !failure || failure.retryAt <= now || (retryNow && !failure.missing);
      });
    };
    let ids = batch(manual);
    if (!ids.length) return Promise.resolve();
    const process = async (ids: string[]) => {
      lastRunAtMs = Date.now();
      const subjects = new Set(
        (await options.archive.listSubjects({ activity: false })).map((row) => row.id),
      );
      let index = 0;
      const worker = async () => {
        while (!controller.signal.aborted) {
          const id = ids[index++];
          if (!id) return;
          pending.delete(id);
          if (!subjects.has(id)) {
            failures.delete(id);
            continue;
          }
          let source: string | null = null;
          try {
            source = coverSource(await options.archive.getSetting(`preview.avatar-source.${id}`));
            if (!source) {
              failures.delete(id);
              continue;
            }
            const key = `avatar:${id}`,
              versionKey = `preview.avatar-version.${id}`;
            const previous = await disk.get(key);
            if (
              previous &&
              previewImageType(previous) &&
              (await options.archive.getSetting(versionKey)) === source
            ) {
              failures.delete(id);
              continue;
            }
            const bytes = await readImage(source, controller.signal);
            const getSubject = options.archive.getSubject;
            const canPublish = getSubject
              ? async () => Boolean(await getSubject(id, { activity: false }))
              : undefined;
            if (!previous || !Buffer.from(previous).equals(bytes)) {
              const written =
                disk instanceof LibraryImages
                  ? await disk.put(key, bytes, canPublish)
                  : await disk.put(key, bytes);
              if (!written) {
                if (canPublish && !(await canPublish())) {
                  failures.delete(id);
                  continue;
                }
                throw Error('AVATAR_CACHE_WRITE_FAILED');
              }
            }
            await options.archive.setSetting(versionKey, source);
            failures.delete(id);
          } catch (error) {
            if (!controller.signal.aborted) {
              const previous = failures.get(id);
              const attempts = Math.min(7, (previous?.attempts ?? 0) + 1);
              const previousFailures =
                previous?.source === source ? previous.consecutiveFailures : 0;
              const missing = missingImageResponse(error);
              failures.set(id, {
                source,
                attempts,
                consecutiveFailures: missing ? 0 : Math.min(previousFailures + 1, 7),
                retryAt: Date.now() + Math.min(300000, 5000 * 2 ** (attempts - 1)),
                missing,
              });
              if (!missing)
                diagnostics.record(
                  'avatar_refresh_failed',
                  error,
                  'warn',
                  source ? new URL(source).hostname : undefined,
                );
            }
          }
        }
      };
      await Promise.all(Array.from({ length: options.concurrency ?? 2 }, () => worker()));
    };
    const run = async () => {
      while (ids.length && !controller.signal.aborted) {
        for (const id of ids) roster.delete(id);
        try {
          await process(ids);
        } catch (error) {
          // Roster reads can fail before workers record an individual retry.
          for (const id of ids) roster.add(id);
          throw error;
        }
        if (!roster.size) return;
        const remaining = new Set(roster);
        ids = batch().filter((id) => remaining.has(id));
      }
    };
    work = (options.archive.withBackgroundReads?.(run) ?? run())
      .then(() => {
        if (controller.signal.aborted) return;
        runFailures = 0;
        if (!issues().length) lastSuccessAtMs = Date.now();
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) runFailures++;
        throw error;
      })
      .finally(() => {
        work = undefined;
      });
    return work;
  };
  const issues = () => [...failures.values()].filter((failure) => !failure.missing);
  const stop = options.clock?.subscribe('subject-avatars', () => refresh(false));
  return {
    status: (): BackgroundTask => {
      const outstanding = issues();
      const failed = outstanding.length + Number(runFailures > 0);
      return {
        id: 'avatar-sync',
        group: 'sync',
        state: work
          ? 'running'
          : failed
            ? 'retrying'
            : roster.size || pending.size
              ? 'waiting'
              : 'idle',
        pending: new Set([...roster, ...pending, ...failures.keys()]).size,
        failed,
        consecutiveFailures: Math.max(
          runFailures,
          ...outstanding.map((issue) => issue.consecutiveFailures),
        ),
        lastRunAtMs,
        lastSuccessAtMs,
        nextRunAtMs: outstanding.length
          ? Math.min(...outstanding.map((item) => item.retryAt))
          : null,
        error: failed ? 'avatar_refresh_partial' : null,
      };
    },
    read: async (id: string): Promise<Uint8Array | null> => {
      if (controller.signal.aborted || !/^stripchat:[1-9]\d*$/.test(id)) return null;
      pending.add(id);
      if (pending.size > 2048) {
        const oldest = pending.values().next().value!;
        pending.delete(oldest);
      }
      const bytes = await disk.get(`avatar:${id}`);
      return bytes && previewImageType(bytes) ? bytes : null;
    },
    warm: (ids: readonly string[]): Promise<void> => {
      if (controller.signal.aborted) return Promise.resolve();
      for (const id of ids) roster.add(id);
      return work ? work.then(() => refresh(false)) : refresh(false);
    },
    refresh,
    close: async () => {
      stop?.();
      controller.abort();
      try {
        await work;
      } finally {
        pending.clear();
        roster.clear();
        failures.clear();
        diagnostics.close();
        await disk.close();
      }
    },
  };
}
