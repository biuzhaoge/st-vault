import { useLayoutEffect, useRef } from 'react';
import type { TrackData } from './track-data';
import type { TrackLoader, TrackPlan } from './track-loader';

interface PresentedTrack {
  data: TrackData;
  delayMs: number;
}

interface TrackPresentation {
  view: string;
  viewport: string;
  rows: ReadonlyMap<string, PresentedTrack>;
  delays: ReadonlyMap<string, number> | null;
}

const emptyRows: ReadonlyMap<string, PresentedTrack> = new Map();

export function useTrackPresentation(
  loader: TrackLoader,
  view: string,
  { visible, fromMs, toMs, buckets, paused }: Omit<TrackPlan, 'revision'>,
) {
  const committed = useRef<TrackPresentation | null>(null);
  const previous = committed.current?.view === view ? committed.current : null;
  const viewport = visible.join('|');
  let next = previous;
  const failures = new Set<string>();
  if (paused) {
    if (previous && previous.viewport !== viewport) {
      // Dropping departed rows keeps a fast scroll back inside the same gesture lightweight.
      const rows = new Map<string, PresentedTrack>();
      for (const id of visible) {
        const retained = previous.rows.get(id);
        if (retained) rows.set(id, retained);
      }
      next = { view, viewport, rows, delays: null };
    }
  } else {
    const entering = visible.filter((id) => !previous?.rows.has(id));
    const delays =
      (previous?.viewport === viewport ? previous.delays : null) ?? revealDelays(entering);
    const ready = loader.getVisible(entering, fromMs, toMs, buckets);
    const rows = new Map<string, PresentedTrack>();
    for (const id of visible) {
      const retained = previous?.rows.get(id);
      if (retained) {
        // An entering row waiting for data cannot blank a row already on screen.
        const data = loader.get(id, fromMs, toMs) ?? retained.data;
        rows.set(id, data === retained.data ? retained : { ...retained, data });
        continue;
      }
      const track = ready.get(id);
      if (track?.data) rows.set(id, { data: track.data, delayMs: delays.get(id) ?? 0 });
      else if (track?.failed) failures.add(id);
    }
    next = { view, viewport, rows, delays };
  }
  useLayoutEffect(() => {
    committed.current = next;
  }, [next]);
  return { rows: next?.rows ?? emptyRows, failures };
}

function revealDelays(ids: readonly string[]): ReadonlyMap<string, number> {
  const stepMs = Math.min(24, 240 / Math.max(1, ids.length - 1));
  return new Map(ids.map((id, index) => [id, index * stepMs]));
}
