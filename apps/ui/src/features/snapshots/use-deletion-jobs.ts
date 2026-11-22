import { useCallback, useEffect, useRef } from 'react';
import type { MediaDeletionJob } from '@st-vault/api-schema';
import { adoptDeletionProjection } from '../../shared/lib/deletion-projection';
import { useSyncRefresh } from '../../shared/lib/sync';
import { DeletionObserver } from './media-deletion';

/** Use the shared system snapshot and recover independently when its source is unavailable. */
export function useDeletionJobs({
  snapshot,
  read,
  onJobs,
  onAccepted,
}: {
  snapshot: MediaDeletionJob[] | null | undefined;
  read: (signal: AbortSignal) => Promise<MediaDeletionJob[]>;
  onJobs?: (jobs: MediaDeletionJob[]) => void;
  onAccepted: (jobs: MediaDeletionJob[]) => void;
}) {
  const observer = useRef(new DeletionObserver());
  const callbacks = useRef({ onJobs, onAccepted });
  callbacks.current = { onJobs, onAccepted };
  const publish = useCallback(
    ({ jobs, accepted }: { jobs: MediaDeletionJob[]; accepted: MediaDeletionJob[] }) => {
      jobs.forEach(adoptDeletionProjection);
      if (accepted.length) callbacks.current.onAccepted(accepted);
      callbacks.current.onJobs?.(jobs);
    },
    [],
  );
  useEffect(() => {
    if (snapshot) publish(observer.current.update(snapshot));
  }, [snapshot, publish]);
  useSyncRefresh(
    ['system', 'timeline'],
    async (signal) => {
      const jobs = await read(signal);
      if (!signal.aborted) publish(observer.current.update(jobs));
    },
    snapshot === null,
    '',
    { onClock: true },
  );
  return {
    submit: (id: string) => observer.current.submit(id),
    remember: (job: MediaDeletionJob) => publish(observer.current.remember(job)),
  };
}
