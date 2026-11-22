import { startTransition, useEffect, useReducer, useRef, useState } from 'react';
import type { SyncTopic } from '@st-vault/api-schema';
import { useSyncRefresh } from '../../shared/lib/sync';
import type { ViewWindow } from './range-control';
import { trackData, type TrackData } from './track-data';
import { TrackLoader, type TrackPlan } from './track-loader';
import { readWorkbench } from './workbench-read';

const trackTopics: SyncTopic[] = ['timeline', 'subjects', 'personal', 'seen'];

export function useTrackData(plan: Omit<TrackPlan, 'revision'>): TrackLoader {
  const [revision, setRevision] = useState(0);
  const [, changed] = useReducer((value: number) => value + 1, 0),
    loader = useRef<TrackLoader | null>(null);
  loader.current ??= new TrackLoader(
    async (ids, current, signal) => {
      const packet = await readWorkbench(
        ids,
        current.fromMs,
        current.toMs,
        current.buckets,
        signal,
      );
      return packet.rows.map((row) => ({
        subjectId: row.subjectId,
        data: trackData(row),
      }));
    },
    () => startTransition(changed),
  );
  const latest = useRef(plan);
  latest.current = plan;
  const visible = plan.visible.join('|');
  useEffect(() => {
    loader.current!.update({ ...latest.current, revision });
  }, [visible, plan.fromMs, plan.toMs, plan.buckets, plan.paused, revision]);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current) loader.current?.close();
      });
    };
  }, []);
  useSyncRefresh(
    trackTopics,
    (_signal, change) => {
      if (change?.timelineSubjectIds) loader.current?.invalidate(change.timelineSubjectIds);
      else setRevision((value) => value + 1);
      return Promise.resolve();
    },
    true,
    '',
    { readOnMount: false },
  );
  return loader.current;
}

export function useFocusTrackData(
  subjectId: string | null,
  window: ViewWindow,
  queryScope: ViewWindow,
  buckets: number,
): TrackData | undefined {
  const [result, setResult] = useState<{ id: string; data: TrackData } | null>(null);
  useSyncRefresh(
    trackTopics,
    async (signal) => {
      if (!subjectId || window.toMs <= window.fromMs) return;
      const packet = await readWorkbench([subjectId], window.fromMs, window.toMs, buckets, signal);
      if (!signal.aborted && packet.rows[0])
        setResult({ id: subjectId, data: trackData(packet.rows[0]) });
    },
    !!subjectId,
    `${subjectId}:${queryScope.fromMs}:${queryScope.toMs}:${buckets}`,
    { timelineSubjectId: subjectId ?? undefined },
  );
  return result?.id === subjectId ? result.data : undefined;
}
