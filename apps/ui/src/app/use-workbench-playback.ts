import type { LiveProgress, RecordingBoundsResponse, Subject } from '@st-vault/api-schema';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlayerHandle, PlayerSource } from '../features/player/Player';
import { closeSource } from '../features/player/MediaSlot';
import { PlaybackClock } from '../features/player/playback-clock';
import { PlaybackCoordinator } from '../features/player/playback-coordinator';
import { archiveRange } from '../features/player/archive-request';
import {
  openArchiveSource,
  openLiveSource,
  prepareArchiveContinuation,
} from '../features/player/playback-requests';
import { loadPlayerEngine } from '../features/player/player-engine';
import { requestNotice, type PlaybackNotice } from '../features/player/player-status';
import { playbackWindow } from '../features/player/replay-window';
import { deletionOverlaps, type MediaDeletionEvent } from '../features/snapshots/media-deletion';
import type { ViewWindow } from '../features/timeline/range-control';
import { mediaTimePosition } from '../features/timeline/timeline';
import { ApiError, request } from '../shared/lib/api';
import { useSyncRefresh } from '../shared/lib/sync';
import type { WorkspaceState } from '../shared/lib/workspace-state';
import type { useWorkbenchView } from './use-workbench-view';
import { useReviewWindow } from './use-review-window';

export function useWorkbenchPlayback(
  subjects: Subject[],
  authenticated: boolean,
  view: Pick<
    ReturnType<typeof useWorkbenchView>,
    'nowMs' | 'dataNowMs' | 'timelineStartMs' | 'revealRange' | 'showAt' | 'rememberCursor'
  >,
  handleUnauthorized: () => void,
) {
  const { timelineStartMs } = view;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selected = subjects.find((subject) => subject.id === selectedId) ?? null;
  const [targetMs, setNavigationTarget] = useState<number | null>(null);
  const playbackClockRef = useRef<PlaybackClock | null>(null);
  playbackClockRef.current ??= new PlaybackClock();
  const playbackClock = playbackClockRef.current;
  const explicitUnitId = useRef<string | undefined>(undefined);
  const setTargetMs = useCallback(
    (at: number | null, unitId?: string): void => {
      explicitUnitId.current = unitId;
      playbackClock.set(at, unitId);
      setNavigationTarget(at);
    },
    [playbackClock],
  );
  const [playbackNavigation, setPlaybackNavigation] = useState<{ id: number; atMs: number | null }>(
    {
      id: 0,
      atMs: null,
    },
  );
  const player = useRef<PlayerHandle>(null);
  const playbackKind = useRef<'live' | 'archive'>('live');
  const coordinatorRef = useRef<PlaybackCoordinator<PlayerSource> | null>(null);
  coordinatorRef.current ??= new PlaybackCoordinator(closeSource);
  const coordinator = coordinatorRef.current;
  const review = useReviewWindow(
    selectedId,
    selectedIdRef,
    targetMs,
    timelineStartMs,
    view.nowMs,
    view.dataNowMs,
  );
  const {
    selection,
    selectionRef,
    hasSelection,
    updateSnapshotReference,
    close: closeReview,
  } = review;
  const [deletionReselection, setDeletionReselection] = useState<{
    subjectId: string;
    controller: AbortController;
  } | null>(null);
  const rangeIntent = useRef(0);
  const [source, setSource] = useState<PlayerSource | null>(null);
  const [playBusy, setPlayBusy] = useState(false);
  const [playerNotice, setPlayerNotice] = useState<PlaybackNotice | null>(null);
  const [liveProgress, setLiveProgress] = useState<LiveProgress | null>(null);
  useSyncRefresh(
    ['playback'],
    async (signal) => {
      if (!selectedId) return;
      const version = coordinator.stamp();
      const progress = await request<LiveProgress | null>(
        `/api/subjects/${encodeURIComponent(selectedId)}/live-progress`,
        { signal },
      );
      if (!signal.aborted && progress && version === coordinator.stamp()) setLiveProgress(progress);
    },
    authenticated &&
      !!selectedId &&
      (playBusy || source?.kind === 'live') &&
      playbackKind.current === 'live',
    selectedId ?? '',
  );
  const invalidatePlayback = useCallback(
    (keepSource = false) => {
      coordinator.invalidate();
      if (!keepSource) setSource(null);
      setPlayBusy(false);
      setPlayerNotice(null);
      setLiveProgress(null);
    },
    [coordinator],
  );
  const closePlayer = useCallback(() => {
    if (document.fullscreenElement)
      void document
        .exitFullscreen()
        .catch((cause) => console.warn('Player fullscreen exit failed', cause));
    // Revoke media ownership before React commits the disconnected view.
    selectedIdRef.current = null;
    player.current?.stop();
    invalidatePlayback();
    setSelectedId(null);
    setTargetMs(null);
    closeReview();
  }, [invalidatePlayback, setTargetMs, closeReview]);
  useEffect(
    () => () => {
      coordinator.invalidate();
    },
    [coordinator],
  );
  function applyRange(next: ViewWindow): void {
    review.fix(next);
    view.revealRange(next);
  }
  async function selectRange(
    subject: Subject,
    next: ViewWindow,
    signal?: AbortSignal,
    resumeAt?: number,
    restoreFixed = hasSelection,
  ): Promise<ViewWindow | null> {
    const reselecting = resumeAt !== undefined;
    if (!reselecting) rangeIntent.current++;
    const intent = rangeIntent.current;
    const controller = coordinator.begin('range');
    if (reselecting) setDeletionReselection({ subjectId: subject.id, controller });
    const cancel = (): void => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    try {
      const value = await request<RecordingBoundsResponse>(
        `/api/subjects/${encodeURIComponent(subject.id)}/recording-bounds?from=${Math.round(next.fromMs)}&to=${Math.round(next.toMs)}`,
        { signal: controller.signal },
      );
      if (!coordinator.owns('range', controller) || rangeIntent.current !== intent) return null;
      if (value.fromMs === null || value.toMs === null) {
        if (reselecting) closePlayer();
        return null;
      }
      const range = { fromMs: value.fromMs, toMs: value.toMs };
      coordinator.settled('range', controller);
      // Only a manual range or recovery of an already fixed selection pins the timeline.
      const fixed = !reselecting || restoreFixed;
      if (fixed) applyRange(range);
      const target = Math.max(range.fromMs, Math.min(range.toMs - 1, resumeAt ?? range.fromMs));
      void open(subject, target, range, {
        intent: fixed ? 'select' : 'seek',
        preserveWindow: reselecting,
        reselecting,
      });
      return range;
    } finally {
      signal?.removeEventListener('abort', cancel);
      coordinator.settled('range', controller);
      if (reselecting)
        setDeletionReselection((current) => (current?.controller === controller ? null : current));
    }
  }
  async function open(
    subject: Subject,
    utc?: number,
    requestedRange = selectionRef.current,
    options: {
      restart?: boolean;
      restoring?: boolean;
      preserveWindow?: boolean;
      intent?: 'select' | 'seek';
      reselecting?: boolean;
      unitId?: string;
    } = {},
  ): Promise<void> {
    const { restart = false, restoring = false, preserveWindow = false } = options;
    const selecting = options.intent === 'select';
    const changingSubject = selectedIdRef.current !== subject.id;
    const following = !selecting && (!hasSelection || changingSubject);
    setPlaybackNavigation((previous) => ({ id: previous.id + 1, atMs: utc ?? null }));
    const range =
      utc === undefined ? requestedRange : playbackWindow(utc, requestedRange, timelineStartMs);
    coordinator.cancel('range');
    if (
      !options.reselecting &&
      !restart &&
      utc !== undefined &&
      selectedIdRef.current === subject.id &&
      source?.kind === 'archive' &&
      source.playback.rangeFromMs === range.fromMs &&
      source.playback.rangeToMs === range.toMs &&
      utc >= range.fromMs &&
      utc < range.toMs &&
      player.current?.seek(utc, false, options.unitId)
    ) {
      setTargetMs(utc, options.unitId);
      if (!following) updateSnapshotReference(subject.id, utc);
      return;
    }
    invalidatePlayback(preserveWindow && source?.subject.id === subject.id);
    playbackKind.current = utc === undefined ? 'live' : 'archive';
    selectedIdRef.current = subject.id;
    setSelectedId(subject.id);
    if (utc === undefined) {
      const now = Date.now();
      review.follow();
      review.resetReference(now);
      if (!restoring) view.showAt(now);
    } else if (selecting) {
      // Selection metadata drives the timeline and snapshot requests independently
      // of manifest creation, decoder initialization and the first video frame.
      review.fix(range);
      review.resetReference(Math.round(utc));
    } else if (changingSubject) {
      review.follow();
      review.resetReference(Date.now());
    }
    setTargetMs(utc ?? null, options.unitId);
    setPlayBusy(true);
    void loadPlayerEngine().catch((error) =>
      console.warn('Playback engine preparation failed', error),
    );
    const controller = coordinator.begin('playback');
    const version = coordinator.stamp();
    try {
      const result =
        utc === undefined
          ? await openLiveSource(
              subject,
              controller.signal,
              source?.kind === 'live' ? source.stream.sessionId : undefined,
            )
          : await openArchiveSource(
              subject,
              utc,
              following ? null : range,
              controller.signal,
              options,
            );
      if (!coordinator.adopt(version, controller.signal, result)) return;
      setSource(result);
      if (result.kind === 'archive') {
        const actualRange = archiveRange(result.playback, range);
        if (selecting && restoring) {
          review.fix(actualRange);
        } else if (selecting) applyRange(preserveWindow ? range : actualRange);
        if (!following && !selecting)
          updateSnapshotReference(subject.id, result.playback.actualAtMs);
        setTargetMs(
          result.playback.actualAtMs,
          options.unitId ??
            mediaTimePosition(result.playback.segments, result.playback.seekOffsetSeconds)?.unitId,
        );
      }
    } catch (cause) {
      if (controller.signal.aborted || version !== coordinator.stamp()) return;
      if (cause instanceof ApiError && cause.status === 401) handleUnauthorized();
      else if (options.reselecting && cause instanceof ApiError && cause.message === 'coverage_gap')
        closePlayer();
      else setPlayerNotice(requestNotice(cause, utc === undefined));
    } finally {
      if (version === coordinator.stamp()) setPlayBusy(false);
      coordinator.settled('playback', controller);
    }
  }
  async function prepareNext(
    current: Extract<PlayerSource, { kind: 'archive' }>,
    signal: AbortSignal,
  ): Promise<Extract<PlayerSource, { kind: 'archive' }> | null> {
    if (selectedIdRef.current !== current.subject.id) return null;
    return prepareArchiveContinuation(current, selectionRef.current, hasSelection, signal);
  }
  function advancePlayback(next: Extract<PlayerSource, { kind: 'archive' }>): void {
    if (selectedIdRef.current !== next.subject.id) return;
    const range = archiveRange(next.playback, selectionRef.current);
    if (hasSelection) {
      applyRange(range);
      updateSnapshotReference(next.subject.id, next.playback.actualAtMs);
    }
    setSource(next);
    setTargetMs(
      next.playback.actualAtMs,
      mediaTimePosition(next.playback.segments, next.playback.seekOffsetSeconds)?.unitId,
    );
  }
  const deletionRecovery = useRef<{
    commandId: string;
    window: ViewWindow;
    at: number;
    stamp: number;
    intent: number;
    suspended: boolean;
    closed: Subject | null;
  } | null>(null);
  function onMediaDeletion(event: MediaDeletionEvent): void {
    const recovery =
      deletionRecovery.current?.commandId === event.commandId ? deletionRecovery.current : null;
    if (recovery) deletionRecovery.current = null;
    const owner = recovery?.closed ?? selected;
    if (!owner) return;
    if (recovery?.closed) {
      if (!event.failed || selectedIdRef.current !== null) return;
    } else if (owner.id !== selectedIdRef.current) return;
    const { fromMs, toMs } = event.plan;
    const range =
      recovery?.window ??
      (event.optimisticRanges && fromMs !== null && toMs !== null
        ? { fromMs, toMs }
        : selectionRef.current);
    if (!deletionOverlaps(event, owner.id, range)) return;
    if (
      recovery &&
      (!coordinator.current(recovery.stamp) || recovery.intent !== rangeIntent.current)
    )
      return;
    const stamp = coordinator.stamp();
    const intent = rangeIntent.current;
    const at = recovery?.at ?? playbackClock.snapshot() ?? range.fromMs;
    if (event.optimisticRanges && event.commandId) {
      const suspended =
        playbackKind.current === 'archive' &&
        event.optimisticRanges.some(({ fromMs, toMs }) => fromMs <= at && at < toMs);
      if (event.knownEmpty) closePlayer();
      else if (suspended) player.current?.suspend();
      deletionRecovery.current = {
        commandId: event.commandId,
        window: range,
        at,
        stamp: coordinator.stamp(),
        intent,
        suspended,
        closed: event.knownEmpty ? owner : null,
      };
      return;
    }
    if (event.failed && !recovery?.suspended && !recovery?.closed) return;
    if (playbackKind.current === 'archive') player.current?.suspend();
    void selectRange(owner, range, undefined, at, !!recovery?.closed || hasSelection).catch(
      (cause: unknown) => {
        if (!coordinator.current(stamp) || rangeIntent.current !== intent) return;
        if (cause instanceof ApiError && cause.status === 401) handleUnauthorized();
        else setPlayerNotice(requestNotice(cause, false));
      },
    );
  }
  function playSnapshot(at: number, range: ViewWindow, unitId: string): void {
    if (!selected) return;
    rangeIntent.current++;
    if (source?.kind === 'archive' && player.current?.seek(at, true, unitId)) {
      setPlaybackNavigation((previous) => ({ id: previous.id + 1, atMs: at }));
      setTargetMs(at, unitId);
      return;
    }
    // A thumbnail changes media position, never the presentation mode or range.
    void open(selected, at, range, { preserveWindow: true, intent: 'seek', unitId });
  }
  async function scrubPlayback(at: number): Promise<void> {
    if (!selected) return;
    rangeIntent.current++;
    const owner = selected;
    await coordinator.scrub(
      at,
      async (target) => {
        setPlaybackNavigation((previous) => ({ id: previous.id + 1, atMs: target }));
        if (player.current?.seek(target)) setTargetMs(target);
        else
          await open(owner, target, selectionRef.current, { preserveWindow: true, intent: 'seek' });
      },
      () => selectedIdRef.current === owner.id,
    );
  }
  function restore(subject: Subject, saved: NonNullable<WorkspaceState['playback']>): void {
    if (saved.view === 'selection') review.fix(saved.range);
    void open(subject, saved.kind === 'archive' ? saved.atMs! : undefined, saved.range, {
      restoring: true,
      intent: saved.view === 'selection' ? 'select' : 'seek',
      unitId: saved.explicitUnitId,
    });
  }
  const position: WorkspaceState['playback'] = selectedId
    ? {
        subjectId: selectedId,
        kind: playbackKind.current,
        atMs: playbackClock.snapshot() === null ? null : Math.round(playbackClock.snapshot()!),
        range: selection,
        view: hasSelection ? 'selection' : 'following',
        explicitUnitId: explicitUnitId.current,
      }
    : null;
  function cursor(at: number, unitId?: string): void {
    if (selectedId !== null && selectedIdRef.current === selectedId && !playBusy) {
      explicitUnitId.current = unitId;
      playbackClock.set(at, unitId);
      view.rememberCursor(at, unitId);
    }
  }
  function followLive(): void {
    setPlaybackNavigation((previous) => ({ id: previous.id + 1, atMs: null }));
    review.follow();
  }
  function retry(): void {
    if (selected)
      void open(
        selected,
        playbackKind.current === 'archive'
          ? (playbackClock.snapshot() ?? selection.fromMs)
          : undefined,
        selection,
        {
          restart: true,
          intent: 'seek',
          unitId: playbackKind.current === 'archive' ? explicitUnitId.current : undefined,
        },
      );
  }
  return {
    selectedId,
    selected,
    player,
    source,
    playBusy,
    playerNotice,
    liveProgress,
    live: playbackKind.current === 'live',
    selection,
    hasSelection,
    targetMs,
    playbackClock,
    playbackNavigation,
    requestedSelection: review.requestedSelection,
    dataWindow: review.dataWindow,
    snapshotReference: review.snapshotReference,
    onSnapshotSession: review.onSnapshotSession,
    reselecting: deletionReselection?.subjectId === selectedId,
    prepareNext,
    advancePlayback,
    scrubPlayback,
    selectRange,
    open,
    playSnapshot,
    onMediaDeletion,
    closePlayer,
    position,
    restore,
    cursor,
    followLive,
    retry,
    closeMissing: (directory: Subject[]) => {
      if (
        selectedIdRef.current &&
        !directory.some((subject) => subject.id === selectedIdRef.current)
      )
        closePlayer();
    },
  };
}
