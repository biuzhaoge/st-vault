import type {
  ArchiveHealthStatus,
  SiteRoutesStatus,
  BackgroundTask,
  MediaDeletionJob,
  SystemRetry,
  SystemRetryTarget,
} from '@st-vault/api-schema';
export interface SystemInfo {
  recordAll?: boolean;
  disk: {
    freeBytes: number;
    totalBytes: number;
    lowSpace: boolean;
    error?: string | null;
  };
  capture: { pollMs: number; active: number; starting?: number; retrying?: number };
  capturedAtMs?: number;
  backgroundTasks?: BackgroundTask[];
  retries?: SystemRetry[];
  retryableTargets?: SystemRetryTarget[];
  deletionJobs?: MediaDeletionJob[] | null;
  deletionWaiting?: number | null;
  version: string;
  maintenanceError?: string | null;
  archiveHealth?: ArchiveHealthStatus | null;
  siteRoutes?: SiteRoutesStatus | null;
  settings?: {
    pollMs: number;
    retentionDays: number;
    minFreeBytes: number;
  };
}
export type RuntimeSettings = NonNullable<SystemInfo['settings']>;
