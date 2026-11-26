import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { systemRetryTargets } from '@st-vault/api-schema';
import type {
  ArchiveHealthStatus,
  BackgroundTask,
  MediaDeletionQueue,
  SiteRoutesStatus,
  SnapshotJobsStatus,
  SystemRetry,
  SystemRetryTarget,
} from '@st-vault/api-schema';
import type { NetworkRouting } from '../network/network-routing.js';
import type { AccountSyncPort, ArchivePort, PreviewsPort, SupervisorPort } from '../ports.js';
import { backgroundOverview } from '../runtime/background-status.js';
import { buildInfo } from '../runtime/build-info.js';
import type { ResourceMonitor } from '../runtime/resources.js';
import { defaultRuntimeSettings, type SettingsStore } from '../runtime/settings.js';
import type { SyncClock } from '../runtime/sync-clock.js';
import type { createSyncHub } from './sync.js';

interface SystemOptions {
  archive: Pick<
    ArchivePort,
    | 'backgroundTasks'
    | 'deletionJobs'
    | 'deletionInventory'
    | 'withBackgroundReads'
    | 'retryDeletions'
  >;
  supervisor: Pick<SupervisorPort, 'states'>;
  clock: Pick<SyncClock, 'status' | 'runNow'>;
  accountSync: Pick<AccountSyncPort, 'status' | 'refresh'>;
  previews: Pick<
    PreviewsPort,
    | 'jobs'
    | 'backgroundTasks'
    | 'retryCovers'
    | 'retryAvatars'
    | 'retryScreenshots'
    | 'retryScreenshotMaintenance'
  >;
  sync: Pick<ReturnType<typeof createSyncHub>, 'status' | 'notify'>;
  now: () => number;
  recordAll: () => boolean;
  settings?: Pick<SettingsStore, 'get'>;
  resources?: Pick<
    ResourceMonitor,
    'get' | 'maintenanceError' | 'backgroundTasks' | 'retry' | 'checkDisk'
  >;
  archiveHealth?: () => ArchiveHealthStatus;
  retryArchiveHealth?: () => Promise<void>;
  siteRoutes?: () => SiteRoutesStatus;
  network?: Pick<NetworkRouting, 'status' | 'sites'>;
  backgroundTasks?: () => BackgroundTask[];
  ingressStats?: () => { subjects: number; retainedBytes: number; maxBytes: number };
}
const retryRequest = z.object({ target: z.enum(systemRetryTargets) }).strict();

export function registerSystem(app: FastifyInstance, options: SystemOptions): void {
  const { archive, supervisor, clock, accountSync, previews, sync, now } = options;
  const failedTaskReaders = new Set<string>();
  const readStatus = async <T>(scope: string, read: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      const result = await read();
      if (failedTaskReaders.delete(scope))
        app.log.info({ event: 'background_status_recovered', scope });
      return result;
    } catch (error) {
      if (!failedTaskReaders.has(scope)) {
        failedTaskReaders.add(scope);
        app.log.warn({
          event: 'background_status_unavailable',
          scope,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
      }
      return fallback;
    }
  };
  const readTasks = (
    scope: string,
    read: () => Promise<BackgroundTask[]>,
    fallback: BackgroundTask[],
  ) =>
    readStatus(
      scope,
      read,
      fallback.map((task) => ({
        ...task,
        state: 'error' as const,
        error: 'task_status_unavailable',
      })),
    );
  const inspectTasks = () => {
    const archiveFallback: BackgroundTask[] = [
      { id: 'archive-index', group: 'processing', state: 'disabled' },
      { id: 'favorite-materialization', group: 'processing', state: 'disabled' },
      { id: 'library-checkpoint', group: 'protection', state: 'disabled' },
      { id: 'orphan-sweep', group: 'processing', state: 'disabled' },
    ];
    const previewFallback: BackgroundTask[] = [
      { id: 'cover-sync', group: 'sync', state: 'disabled' },
      { id: 'avatar-sync', group: 'sync', state: 'disabled' },
      { id: 'snapshot-maintenance', group: 'processing', state: 'disabled' },
    ];
    const read = () =>
      Promise.all([
        readStatus<SnapshotJobsStatus | null>(
          'snapshots',
          () => previews.jobs?.() ?? Promise.resolve(null),
          {
            mode: 'unavailable',
            pending: 0,
            failed: 0,
            completed: 0,
            averageMs: 0,
            error: 'task_status_unavailable',
          },
        ),
        readTasks(
          'archive',
          () => archive.backgroundTasks?.() ?? Promise.resolve(archiveFallback),
          archiveFallback,
        ),
        readTasks(
          'previews',
          () => previews.backgroundTasks?.() ?? Promise.resolve(previewFallback),
          previewFallback,
        ),
        readStatus<MediaDeletionQueue | null>(
          'deletions',
          async () => {
            if (archive.deletionInventory) return archive.deletionInventory();
            const jobs = (await archive.deletionJobs?.()) ?? [];
            return { jobs, waiting: jobs.filter((job) => job.state === 'waiting').length };
          },
          null,
        ),
      ]);
    return archive.withBackgroundReads?.(read) ?? read();
  };
  let taskReading: ReturnType<typeof inspectTasks> | undefined;
  const retries = new Map<SystemRetryTarget, SystemRetry>();
  const retryDeletions = async (): Promise<void> => {
    if (!archive.retryDeletions) return;
    await options.resources?.checkDisk();
    const disk = options.resources?.get();
    // A writable media disk below the recording reserve still needs to permit cleanup.
    if (disk?.error) throw new Error('STORAGE_LOW_OR_UNAVAILABLE');
    await archive.retryDeletions();
  };
  const retryPlan = (status: Awaited<ReturnType<typeof readSystem>>) => {
    const plan: Partial<Record<SystemRetryTarget, () => unknown>> = {};
    const tasks = new Map(status.backgroundTasks.map((task) => [task.id, task]));
    const issue = (id: string): boolean => {
      const task = tasks.get(id);
      return Boolean(
        task &&
        task.state !== 'running' &&
        task.error !== 'task_status_unavailable' &&
        (task.state === 'error' || task.state === 'retrying'),
      );
    };
    const health = status.archiveHealth;
    if (
      options.retryArchiveHealth &&
      health?.error &&
      !['archive_checking', 'archive_timeout'].includes(health.error) &&
      health.recovery !== 'restart-requested'
    )
      plan['archive-health'] = options.retryArchiveHealth;
    const resources = options.resources;
    if (resources) {
      const disk = status.disk;
      if (
        tasks.get('disk-check')?.state !== 'running' &&
        disk.error !== 'not_checked' &&
        (disk.error || disk.lowSpace)
      )
        plan['disk-check'] = () => resources.retry('disk-check');
      if (!disk.error) {
        if (issue('retention')) plan.retention = () => resources.retry('retention');
        if (issue('integrity-scan'))
          plan['integrity-scan'] = () => resources.retry('integrity-scan');
      }
    }

    const account = accountSync.status();
    const access = status.siteRoutes?.access;
    const siteError = access?.origin === account.origin ? access?.error : null;
    const siteBlocked =
      siteError === 'upstream-http:429' || siteError?.startsWith('upstream-challenge');
    if (account.connected && !siteBlocked) {
      if (!account.running && account.error && !account.needsReconnect)
        plan['account-list'] = () => accountSync.refresh();
      const sites = options.network?.sites;
      if (siteError && sites) plan['site-access'] = () => sites.recheck();
    }
    if (previews.retryCovers && issue('cover-sync'))
      plan['cover-sync'] = () => previews.retryCovers?.();
    if (previews.retryAvatars && issue('avatar-sync'))
      plan['avatar-sync'] = () => previews.retryAvatars?.();

    const clockTasks = {
      'capture-status': 'capture-status',
      'public-status-evidence': 'public-status-evidence',
      'client-sync': 'ui-sync',
    } as const;
    const scheduled = clock.status();
    for (const [id, job] of Object.entries(clockTasks)) {
      if (issue(id) && scheduled.some((item) => item.name === job && !item.running))
        plan[id as keyof typeof clockTasks] = () => clock.runNow(job);
    }

    if (
      previews.retryScreenshots &&
      status.snapshotJobs &&
      ['realtime', 'catching-up'].includes(status.snapshotJobs.mode) &&
      issue('snapshots')
    )
      plan.snapshots = () => previews.retryScreenshots?.();
    if (previews.retryScreenshotMaintenance && issue('snapshot-maintenance'))
      plan['snapshot-maintenance'] = () => previews.retryScreenshotMaintenance?.();
    if (
      archive.retryDeletions &&
      status.deletionJobs?.some(
        (job) => job.state === 'retry' || (job.state === 'preparing' && job.error),
      )
    )
      plan.deletion = retryDeletions;
    return plan;
  };
  app.post('/api/system/retry', { bodyLimit: 1024 }, async (request, reply) => {
    const { target } = retryRequest.parse(request.body);
    const current = (): SystemRetry | undefined => {
      const previous = retries.get(target);
      if (previous && (previous.state === 'running' || now() - previous.startedAtMs < 5000))
        return previous;
      return undefined;
    };
    const inFlight = current();
    if (inFlight) return reply.code(202).send(inFlight);
    const action = retryPlan(await readSystem())[target];
    const concurrent = current();
    if (concurrent) return reply.code(202).send(concurrent);
    if (!action) return reply.code(409).send({ error: 'system_retry_not_applicable' });
    const attempt: SystemRetry = { target, state: 'running', startedAtMs: now() };
    retries.set(target, attempt);
    sync.notify('system');
    const finish = (state: 'finished' | 'failed'): void => {
      retries.set(target, { ...attempt, state });
      sync.notify('system');
    };
    void Promise.resolve()
      .then(action)
      .then(
        () => finish('finished'),
        (error: unknown) => {
          app.log.warn({
            event: 'system_retry_failed',
            target,
            errorName: error instanceof Error ? error.name : 'unknown',
          });
          finish('failed');
        },
      );
    return reply.code(202).send(attempt);
  });
  async function readSystem() {
    const settings = options.settings?.get() ?? defaultRuntimeSettings;
    taskReading ??= inspectTasks().finally(() => {
      taskReading = undefined;
    });
    const [snapshotJobs, archiveTasks, previewTasks, deletionQueue] = await taskReading;
    const deletions = deletionQueue?.jobs ?? null;
    const capturedAtMs = now(),
      states = Object.values(supervisor.states()),
      network = options.network?.status(),
      siteRoutes = options.siteRoutes?.() ?? network?.sites;
    const tasks = backgroundOverview({
      clock: clock.status(),
      account: accountSync.status(),
      sites: siteRoutes,
      snapshots: snapshotJobs,
      deletions,
      deletionWaiting: deletionQueue?.waiting,
      tasks: [
        ...archiveTasks,
        ...previewTasks,
        ...(options.resources?.backgroundTasks() ?? []),
        ...(options.backgroundTasks?.() ?? []),
      ],
      client: sync.status(),
    });
    return {
      capturedAtMs,
      backgroundTasks: tasks,
      retries: [...retries.values()],
      ingress: options.ingressStats?.() ?? null,
      ...buildInfo,
      settings,
      recordAll: options.recordAll(),
      deletionJobs: deletions,
      deletionWaiting: deletionQueue?.waiting ?? null,
      snapshotJobs,
      disk: options.resources?.get() ?? {
        freeBytes: 0,
        totalBytes: 0,
        lowSpace: true,
        error: 'not_configured',
        checkedAtMs: 0,
      },
      maintenanceError: options.resources?.maintenanceError() ?? null,
      archiveHealth: options.archiveHealth?.() ?? null,
      siteRoutes: siteRoutes ?? null,
      capture: {
        pollMs: settings.pollMs,
        active: states.filter((state) => state === 'CAPTURING').length,
        starting: states.filter((state) => state === 'RESOLVING' || state === 'QUEUED').length,
        retrying: states.filter((state) => state === 'BACKOFF').length,
      },
    };
  }
  app.get('/api/system', async (_request, reply) => {
    const status = await readSystem();
    const plan = retryPlan(status);
    return reply.send({
      ...status,
      retryableTargets: systemRetryTargets.filter((target) => plan[target]),
    });
  });
}
