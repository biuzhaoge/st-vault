import { useCallback, useEffect, useRef } from 'react';
import type { MediaDeletionJob } from '@st-vault/api-schema';
import { adoptDeletionProjection } from '../../shared/lib/deletion-projection';
import { useSyncRefresh } from '../../shared/lib/sync';
import { DeletionObserver } from './media-deletion';

/** Use the shared system snapshot and recover independently when its source is unavailable. */
export function useDeletionJobs({
  snapshot,
  read,
  receipt,
  onJobs,
  onAccepted,
}: {
  snapshot: MediaDeletionJob[] | null | undefined;
  read: (signal: AbortSignal) => Promise<MediaDeletionJob[]>;
  receipt: (id: string, signal: AbortSignal) => Promise<MediaDeletionJob | null>;
  onJobs?: (jobs: MediaDeletionJob[]) => void;
  onAccepted: (jobs: MediaDeletionJob[]) => void;
}) {
  const observer = useRef(new DeletionObserver());
  const unresolved = useRef(
    new Map<string, { missing: () => void; controller?: AbortController }>(),
  );
  const callbacks = useRef({ onJobs, onAccepted, receipt });
  callbacks.current = { onJobs, onAccepted, receipt };
  const publish = useCallback(
    ({ jobs, accepted }: { jobs: MediaDeletionJob[]; accepted: MediaDeletionJob[] }) => {
      for (const job of [...jobs, ...accepted]) {
        adoptDeletionProjection(job);
        unresolved.current.delete(job.id);
      }
      if (accepted.length) callbacks.current.onAccepted(accepted);
      callbacks.current.onJobs?.(jobs);
    },
    [],
  );
  const verifyReceipt = useCallback(
    async (id: string) => {
      const pending = unresolved.current.get(id);
      if (!pending || pending.controller) return;
      const controller = new AbortController();
      pending.controller = controller;
      try {
        const job = await callbacks.current.receipt(id, controller.signal);
        if (unresolved.current.get(id) !== pending) return;
        unresolved.current.delete(id);
        if (job) publish(observer.current.remember(job));
        else pending.missing();
      } catch (cause) {
        if (!controller.signal.aborted)
          console.warn(
            'Media operation reconciliation unavailable',
            cause instanceof Error ? cause.name : 'unknown',
          );
      } finally {
        pending.controller = undefined;
      }
    },
    [publish],
  );
  const inventory = useCallback(
    (jobs: MediaDeletionJob[]) => {
      publish(observer.current.update(jobs));
      // Recent history can omit an accepted command. Only its own receipt can disprove admission.
      for (const id of unresolved.current.keys()) void verifyReceipt(id);
    },
    [publish, verifyReceipt],
  );
  useEffect(() => {
    const pending = unresolved.current;
    return () => {
      for (const item of pending.values()) item.controller?.abort();
      pending.clear();
    };
  }, []);
  useEffect(() => {
    if (snapshot) inventory(snapshot);
  }, [snapshot, inventory]);
  useSyncRefresh(
    ['system', 'timeline'],
    async (signal) => {
      for (const id of unresolved.current.keys()) void verifyReceipt(id);
      const jobs = await read(signal);
      if (!signal.aborted) inventory(jobs);
    },
    snapshot === null,
    '',
    { onClock: true },
  );
  return {
    submit: (id: string) => observer.current.submit(id),
    remember: (job: MediaDeletionJob) => publish(observer.current.remember(job)),
    verify: async (id: string, uncertain: () => void, missing: () => void) => {
      if (observer.current.has(id)) return;
      unresolved.current.set(id, { missing });
      uncertain();
      // A later system heartbeat resolves the same command if this read fails.
      await verifyReceipt(id);
    },
  };
}
