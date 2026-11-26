import type { EventMeta, MediaDeletionJob, Subject } from '@st-vault/api-schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  useDeletionProjections,
  clearDeletionProjections,
} from '../shared/lib/deletion-projection';
import { ApiError, request } from '../shared/lib/api';
import { messageFor } from '../shared/lib/errors';
import { tr } from '../shared/lib/i18n';
import {
  usePageSync,
  useSyncRefresh,
  syncReadFailure,
  type SyncReadResult,
} from '../shared/lib/sync';
import { reconcileSubjects } from '../features/directory/subjects';
import type { KeyInfo } from '../features/keys/KeyTools';
import type { SystemInfo } from '../features/status/system';

/** Polls shared workbench resources and invalidates older reads when recording policy changes. */
export function useWorkbenchData(
  authenticated: boolean,
  historyOpen: boolean,
  onUnauthorized: () => void,
  onSubjectsRead: (subjects: Subject[]) => void,
) {
  const handlers = useRef({ onUnauthorized, onSubjectsRead });
  handlers.current = { onUnauthorized, onSubjectsRead };
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [systemError, setSystemError] = useState('');
  const [eventMeta, setEventMeta] = useState<EventMeta | null>(null);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const subjectsVersion = useRef(0);
  const systemVersion = useRef(0);
  const [serverDeletionJobs, setDeletionJobs] = useState<MediaDeletionJob[]>([]);
  const deletionProjections = useDeletionProjections();
  const deletionSnapshot = systemError ? null : system?.deletionJobs;
  const observedDeletions = deletionSnapshot ?? serverDeletionJobs;
  const observedAt = deletionSnapshot ? (system?.capturedAtMs ?? 0) : 0;
  const deletionJobs = [
    ...observedDeletions,
    ...deletionProjections
      .filter((entry) => !entry.unconfirmed)
      .map((entry) => entry.job)
      .filter(
        (job) =>
          job.updatedAtMs >= observedAt &&
          !observedDeletions.some((server) => server.id === job.id),
      ),
  ];
  useEffect(() => {
    if (!authenticated) {
      systemVersion.current++;
      setSystem(null);
      setSystemError('');
      setDeletionJobs([]);
      clearDeletionProjections();
    }
  }, [authenticated]);
  const [error, setError] = useState('');
  const [keyInfo, setKeyInfo] = useState<KeyInfo | null>(null);
  const [keySaving, setKeySaving] = useState(false);
  const keyBusy = keySaving;
  const subjectsRequest = useRef<Promise<SyncReadResult> | null>(null);
  const [subjectsLoaded, setSubjectsLoaded] = useState(false);
  usePageSync(authenticated, system?.settings?.pollMs ?? 5000);
  const loadSubjects = useCallback(
    async (force = false, signal?: AbortSignal): Promise<SyncReadResult> => {
      if (subjectsRequest.current) {
        const previous = await subjectsRequest.current;
        if (force) return loadSubjects(true);
        return previous;
      }
      const running = (async (): Promise<SyncReadResult> => {
        const version = subjectsVersion.current;
        try {
          const data = await request<Subject[]>('/api/subjects', { signal });
          if (signal?.aborted || version !== subjectsVersion.current) return;
          setSubjects((current) => reconcileSubjects(current, data));
          setSubjectsLoaded(true);
          setError('');
          handlers.current.onSubjectsRead(data);
        } catch (cause) {
          const result = syncReadFailure(cause, signal);
          if (signal?.aborted && result.status !== 'retry') return result;
          if (cause instanceof ApiError && cause.status === 401) handlers.current.onUnauthorized();
          else if (!subjectsLoaded || result.status !== 'retry')
            setError(tr('主播清单读取失败：{{v0}}', { v0: messageFor(cause) }));
          return result;
        }
      })();
      subjectsRequest.current = running;
      const result = await running;
      if (subjectsRequest.current === running) subjectsRequest.current = null;
      return result;
    },
    [subjectsLoaded],
  );
  const loadSystem = useCallback(async (signal?: AbortSignal): Promise<SyncReadResult> => {
    const version = systemVersion.current;
    try {
      const value = await request<SystemInfo>('/api/system', { signal });
      if (signal?.aborted || version !== systemVersion.current) return;
      setSystem(value);
      setSystemError('');
    } catch (cause) {
      const result = syncReadFailure(cause, signal);
      if (version !== systemVersion.current) return;
      if (signal?.aborted && result.status !== 'retry') return result;
      if (cause instanceof ApiError && cause.status === 401) handlers.current.onUnauthorized();
      else setSystemError(messageFor(cause));
      return result;
    }
  }, []);
  const loadKeys = useCallback(async (signal?: AbortSignal): Promise<SyncReadResult> => {
    try {
      const value = await request<KeyInfo>('/api/keys', { signal });
      setKeyInfo(value);
    } catch (cause) {
      const result = syncReadFailure(cause, signal);
      if (signal?.aborted && result.status !== 'retry') return result;
      if (cause instanceof ApiError && cause.status === 401) handlers.current.onUnauthorized();
      return result;
    }
  }, []);
  useSyncRefresh(['subjects'], (signal) => loadSubjects(false, signal), authenticated);
  useSyncRefresh(['keys'], loadKeys, authenticated);
  useSyncRefresh(['system'], loadSystem, authenticated, '', { onClock: true });
  useSyncRefresh(
    ['events'],
    async (signal) => {
      setEventMeta(await request<EventMeta>('/api/events/meta', { signal }));
    },
    authenticated && !historyOpen,
  );
  async function setGlobalRecording(enabled: boolean): Promise<void> {
    systemVersion.current++;
    subjectsVersion.current++;
    try {
      await request('/api/subjects/recording-default', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      setSystem((current) => (current ? { ...current, recordAll: enabled } : current));
      setSubjects((rows) =>
        rows.map((row) =>
          row.archived ? row : { ...row, autoRecord: enabled, monitorEnabled: true },
        ),
      );
    } finally {
      systemVersion.current++;
      subjectsVersion.current++;
      void loadSystem();
      void loadSubjects(true).catch((cause: unknown) => setError(messageFor(cause)));
    }
  }
  async function setRecording(id: string, record: boolean): Promise<void> {
    subjectsVersion.current++;
    try {
      const updated = await request<Subject>(`/api/subjects/${encodeURIComponent(id)}/policy`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoRecord: record, monitorEnabled: true }),
      });
      setSubjects((rows) => rows.map((row) => (row.id === id ? updated : row)));
    } finally {
      subjectsVersion.current++;
      void loadSubjects(true).catch((cause: unknown) => setError(messageFor(cause)));
    }
  }
  function clearSubjects(): void {
    subjectsVersion.current++;
    setSubjectsLoaded(false);
    setSubjects([]);
  }
  return {
    system,
    setSystem,
    systemError,
    eventMeta,
    setEventMeta,
    subjects,
    subjectsLoaded,
    deletionJobs,
    setDeletionJobs,
    error,
    keyInfo,
    setKeyInfo,
    keyBusy,
    setKeySaving,
    loadSystem,
    loadSubjects,
    setGlobalRecording,
    setRecording,
    clearSubjects,
  };
}
