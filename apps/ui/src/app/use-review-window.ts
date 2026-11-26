import type { SnapshotSession } from '@st-vault/api-schema';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { replayWindow, REPLAY_SPAN_MS } from '../features/player/replay-window';
import type { ViewWindow } from '../features/timeline/range-control';

/** The displayed recording window may follow a session while new page reads use the polling clock. */
export function useReviewWindow(
  selectedId: string | null,
  selectedIdRef: React.RefObject<string | null>,
  targetMs: number | null,
  timelineStartMs: number,
  nowMs: number,
  dataNowMs: number,
) {
  const [selectionEndMs, setSelectionEndMs] = useState<number | null>(null);
  const [selectionDurationMs, setSelectionDurationMs] = useState(REPLAY_SPAN_MS);
  const hasSelection = selectionEndMs !== null;
  const [broadcast, setBroadcast] = useState<{
    id: string;
    session: SnapshotSession | null;
    window: ViewWindow;
  } | null>(null);
  const broadcastRef = useRef(broadcast);
  broadcastRef.current = broadcast;
  const [snapshotReference, setSnapshotReference] = useState(Date.now);
  const snapshotBoundary = useRef('');
  const { selection, requestedSelection, dataWindow } = useMemo(() => {
    const windowAt = (at: number): ViewWindow => {
      if (selectionEndMs !== null)
        // Resolved unit bounds are fixed media coordinates, not a rolling
        // wall-clock window. An open unit can extend beyond the last UI tick;
        // clamping only its end would incorrectly move the left edge backward.
        return { fromMs: selectionEndMs - selectionDurationMs, toMs: selectionEndMs };
      return replayWindow(at, timelineStartMs, at);
    };
    const requestedSelection = windowAt(nowMs);
    const selection = { ...requestedSelection };
    const anchor = broadcast?.id === selectedId ? broadcast.window.fromMs : undefined;
    if (selectionEndMs === null && anchor !== undefined && anchor < selection.toMs)
      selection.fromMs = anchor;
    return {
      selection,
      requestedSelection,
      dataWindow: selectionEndMs === null ? windowAt(dataNowMs) : requestedSelection,
    };
  }, [
    selectionEndMs,
    timelineStartMs,
    nowMs,
    dataNowMs,
    selectionDurationMs,
    broadcast,
    selectedId,
  ]);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const onSnapshotSession = useCallback(
    (id: string, value: SnapshotSession | null, window: ViewWindow) => {
      if (selectedIdRef.current === id) {
        setBroadcast((current) =>
          current?.id === id &&
          current.session === value &&
          current.window.fromMs === window.fromMs &&
          current.window.toMs === window.toMs
            ? current
            : { id, session: value, window },
        );
      }
    },
    [],
  );
  useEffect(() => {
    const end = broadcast?.id === selectedId ? broadcast.session?.selectionToMs : undefined;
    if (selectionEndMs !== null && end !== undefined && end > selectionEndMs) {
      setSelectionDurationMs((duration) => duration + end - selectionEndMs);
      setSelectionEndMs(end);
    }
  }, [broadcast, selectedId, selectionEndMs]);
  const updateSnapshotReference = (id: string, at: number): void => {
    const current = broadcastRef.current;
    if (
      current?.id !== id ||
      !current.session ||
      at < current.session.fromMs ||
      (current.session.ended && at >= current.session.toMs)
    )
      setSnapshotReference(Math.round(at));
  };
  useEffect(() => {
    const active = broadcast?.id === selectedId ? broadcast.session : null;
    if (selectionEndMs === null || !active || targetMs === null) return;
    if (targetMs >= active.fromMs && (!active.ended || targetMs < active.toMs)) {
      snapshotBoundary.current = '';
      return;
    }
    const key = `${selectedId}:${active.fromMs}:${active.toMs}`;
    if (snapshotBoundary.current !== key) {
      snapshotBoundary.current = key;
      setSnapshotReference(Math.round(targetMs));
    }
  }, [broadcast, selectedId, targetMs, selectionEndMs]);
  function fix(range: ViewWindow): void {
    setSelectionEndMs(range.toMs);
    setSelectionDurationMs(range.toMs - range.fromMs);
    selectionRef.current = range;
  }
  function follow(): void {
    setSelectionEndMs(null);
    setSelectionDurationMs(REPLAY_SPAN_MS);
  }
  function resetReference(at: number): void {
    setBroadcast(null);
    setSnapshotReference(at);
  }
  const close = useCallback(() => {
    setSelectionEndMs(null);
    setBroadcast(null);
  }, []);
  return {
    selection,
    selectionRef,
    requestedSelection,
    dataWindow,
    hasSelection,
    snapshotReference,
    onSnapshotSession,
    updateSnapshotReference,
    fix,
    follow,
    resetReference,
    close,
  };
}
