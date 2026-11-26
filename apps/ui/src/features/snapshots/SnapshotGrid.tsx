import { tr } from '../../shared/lib/i18n';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { Icon } from '../../design/Icon';
import type { MediaDeletionEvent } from './media-deletion';
import type {
  SnapshotSession,
  Subject,
  MediaDeletionTarget,
  MediaTimeRange,
  MediaDeletionJob,
} from '@st-vault/api-schema';
import { ApiError, MutationOutcomeUnknown } from '../../shared/lib/api';
import { formatDateTime } from '../timeline/timeline';
import { overlappingWindows } from './snapshot-page';
import { UnitImage } from './UnitImage';
import { isSnapshotLiked, snapshotKey } from './snapshot-identity';
import { messageFor } from '../../shared/lib/errors';
import { MediaDeleteDialog } from './MediaDeleteDialog';
import { SnapshotNotice } from './SnapshotNotice';
import { snapshotEmptyNotice } from './snapshot-status';
import { clockLabel, dayLabel } from '../../shared/lib/date-label';
import { durationLabel } from '../../shared/lib/duration';
import { useLayoutMotion } from '../../design/use-layout-motion';
import { useReducedMotion } from '../../design/use-reduced-motion';
import { SnapshotCommands } from './snapshot-commands';
import { newCommandId } from '../../shared/lib/command-id';
import {
  beginDeletionProjection,
  failDeletionProjection,
  uncertainDeletionProjection,
  withdrawDeletionProjection,
} from '../../shared/lib/deletion-projection';
import type { FavoritePreview } from './favorite-state';
import { WheelPager } from './wheel-pager';
import { SnapshotToolbar } from './SnapshotToolbar';
import { SnapshotPageMotion } from './snapshot-page-motion';
import { animateSnapshotAction } from './snapshot-action-motion';
import { SnapshotGestureMotion } from './snapshot-gesture-motion';
import { useSnapshotView } from './use-snapshot-view';
import { useSnapshotSelection } from './use-snapshot-selection';
import { useDeletionJobs } from './use-deletion-jobs';
import {
  usePlaybackClock,
  usePlaybackPosition,
  type PlaybackClock,
} from '../player/playback-clock';

export function SnapshotGrid({
  subject,
  referenceMs,
  window: range,
  queryWindow = range,
  followLive,
  playingLive = false,
  navigation,
  atMs: requestedAtMs,
  playbackClock,
  onSeek,
  onSession,
  onDeletion,
  reselecting = false,
  onJobs,
  jobSnapshot,
}: {
  subject: Subject | null;
  referenceMs: number;
  window: MediaTimeRange;
  // Display seconds move the shared frame; only heartbeat bounds read metadata.
  queryWindow?: MediaTimeRange;
  followLive: boolean;
  playingLive?: boolean;
  navigation: { id: number; atMs: number | null };
  atMs: number | null;
  playbackClock?: PlaybackClock;
  onSeek: (utc: number, window: MediaTimeRange, unitId: string) => void;
  onSession: (id: string, session: SnapshotSession | null, window: MediaTimeRange) => void;
  onDeletion: (event: MediaDeletionEvent) => void;
  reselecting?: boolean;
  onJobs?: (jobs: MediaDeletionJob[]) => void;
  jobSnapshot?: MediaDeletionJob[] | null;
}): JSX.Element {
  const atMs = usePlaybackClock(playbackClock, requestedAtMs);
  const { unitId: playingUnitId } = usePlaybackPosition(playbackClock);
  const section = useRef<HTMLElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const [gestureMotion] = useState(() => new SnapshotGestureMotion(grid));
  const commandsRef = useRef<SnapshotCommands | null>(null);
  commandsRef.current ??= new SnapshotCommands();
  const commands = commandsRef.current;
  const {
    scope,
    page,
    setPage,
    error,
    retryRead,
    current,
    shown,
    catalog,
    pagePending,
    holdingPage,
    acceptPersonal,
    acceptUnitFavorite,
    navigate,
    markers,
    displayMarkers,
    items,
    occupiedPages,
    pages,
    pageIndex,
    displayRange,
    playing,
    slots,
    favoritesReady,
  } = useSnapshotView({
    subject,
    referenceMs,
    range,
    queryWindow,
    followLive,
    playingLive,
    navigation,
    atMs,
    playingUnitId,
    onSession,
    commands,
    reselecting,
  });
  const [activity, setActivity] = useState<'favorite' | null>(null),
    [feedback, setFeedback] = useState('');

  const [pendingFavorites, setPendingFavorites] = useState<ReadonlyMap<string, boolean | null>>(
    () => new Map(),
  );
  const busy = activity !== null || pendingFavorites.size > 0;
  const [favoritePreview, setFavoritePreview] = useState<FavoritePreview | null>(null);
  useEffect(() => {
    if (
      favoritePreview &&
      (favoritePreview.scope !== scope ||
        (favoritePreview.revision !== undefined &&
          favoritesReady &&
          markers &&
          markers.revision >= favoritePreview.revision))
    )
      setFavoritePreview(null);
  }, [favoritePreview, scope, favoritesReady, markers]);
  const [deletion, setDeletion] = useState<{
    scope: string;
    target: MediaDeletionTarget;
    ranges: MediaTimeRange[];
    protectedIds: string[];
    protectedRanges: MediaTimeRange[];
  } | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const selectionScope = `${subject?.id}:${followLive ? 'live' : `${range.fromMs}:${range.toMs}`}`;
  const mounted = useRef(true);
  const favoriteRead = useRef<AbortController | null>(null);
  useEffect(() => {
    const read = new AbortController();
    favoriteRead.current = read;
    setActivity(null);
    return () => {
      read.abort();
      commands.cancelPreparation();
    };
  }, [scope, selectionScope]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      commands.dispose();
    };
  }, []);
  const deletedCallback = useRef(onDeletion);
  const unconfirmedCommand = useRef<string | null>(null);
  deletedCallback.current = onDeletion;
  const deletionJobs = useDeletionJobs({
    snapshot: jobSnapshot,
    read: (signal) => commands.jobs(signal),
    receipt: (id, signal) => commands.receipt(id, signal),
    onJobs,
    onAccepted: (jobs) => {
      for (const job of jobs) {
        if (unconfirmedCommand.current === job.id) {
          unconfirmedCommand.current = null;
          setFeedback('');
        }
        deletedCallback.current({
          commandId: job.id,
          subjectId: job.subjectId,
          plan: { fromMs: job.fromMs, toMs: job.toMs },
          failed: job.state === 'failed',
        });
      }
    },
  });
  const wheel = useRef(new WheelPager());
  const paging = useRef({ pageIndex, occupiedPages, setPage });
  paging.current = { pageIndex, occupiedPages, setPage };
  const turnPage = useCallback((direction: -1 | 0 | 1): void => {
    const current = paging.current;
    if (!direction || current.pageIndex < 0) return;
    const next = current.occupiedPages[current.pageIndex + direction];
    if (next !== undefined) current.setPage(next);
  }, []);
  const selection = useSnapshotSelection({
    motion: gestureMotion,
    scope: selectionScope,
    page,
    items,
    pagePending: pagePending || holdingPage,
    canTurnPage: (direction) =>
      !followLive && pageIndex >= 0 && occupiedPages[pageIndex + direction] !== undefined,
    turnPage,
    onPlay: (item) => {
      animateSnapshotAction(grid.current, item.unitId, 'play');
      navigate(item.atMs);
      onSeek(item.atMs, displayRange, item.unitId);
    },
    onDoubleClick: (item) => void toggleFavorite(item),
    canCommitRange: () => !commands.busy && !commands.hasFavoriteWrites,
    onRangeCommit: (ids) => void updateFavorites(ids),
  });
  useEffect(() => {
    const node = section.current;
    if (!node) return;
    const turn = (event: WheelEvent): void => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault();
      if (selection.dragging) return;
      turnPage(
        wheel.current.step(event.deltaY, event.deltaMode, node.clientHeight, performance.now()),
      );
    };
    node.addEventListener('wheel', turn, { passive: false });
    return () => node.removeEventListener('wheel', turn);
  }, [turnPage, selection.dragging]);
  const motionTo = followLive ? queryWindow.toMs : displayRange.toMs;
  const motionRevision = useMemo(
    () => ({ items, page, from: displayRange.fromMs, to: motionTo }),
    [items, page, displayRange.fromMs, motionTo],
  );
  const reducedMotion = useReducedMotion();
  useLayoutEffect(() => {
    if (reducedMotion || pagePending || holdingPage) gestureMotion.cancel();
  }, [gestureMotion, reducedMotion, pagePending, holdingPage]);
  useLayoutMotion(reducedMotion ? null : grid, `${subject?.id ?? ''}:${page}`, motionRevision);
  const pageMotion = useRef<SnapshotPageMotion | null>(null);
  pageMotion.current ??= new SnapshotPageMotion();
  useLayoutEffect(() => {
    if (reducedMotion) pageMotion.current!.clear();
    else if (grid.current) pageMotion.current!.update(grid.current, scope, page);
  });
  useEffect(() => () => pageMotion.current!.clear(), []);
  const changed = () =>
    window.dispatchEvent(
      new CustomEvent('stv-sync', { detail: ['personal', 'timeline', 'subjects'] }),
    );
  const priorWindow = useRef({ id: subject?.id, range });
  useEffect(() => {
    const previous = priorWindow.current;
    priorWindow.current = { id: subject?.id, range };
    if (previous.id !== subject?.id || !overlappingWindows(previous.range, range)) {
      setFeedback('');

      commands.cancelPreparation();
      setActivity(null);
    }
  }, [subject?.id, range.fromMs, range.toMs]);
  useEffect(() => {
    setDeletion(null);
  }, [scope, page]);
  function openDeletion(): void {
    if (!subject || commands.busy || commands.hasFavoriteWrites || !catalog?.total) return;
    setFeedback('');
    setDeletion({
      scope,
      target: { kind: 'range', ...displayRange, mode: 'unliked' },
      // Optimistically remove only known non-favorites. Unseen pages stay owned
      // by the server's frozen selection rather than guessing their protection.
      ranges: favoritesReady
        ? items
            .filter((item) => !isSnapshotLiked(item, markers?.favorites ?? []))
            .map((item) => ({ fromMs: item.slotFromMs, toMs: item.slotToMs }))
        : [],
      protectedIds: markers?.favorites.map((item) => item.id) ?? [],
      protectedRanges: markers?.favorites.map(({ fromMs, toMs }) => ({ fromMs, toMs })) ?? [],
    });
  }
  async function confirmDeletion(): Promise<void> {
    const draft = deletion;
    if (draft?.scope !== scope || !subject) return;
    // This request owns an immutable target, not the browser preparation promise.
    const commandId = newCommandId();
    deletionJobs.submit(commandId);
    const result = commands.admitDeletion(subject.id, commandId, draft.target);
    flushSync(() => {
      beginDeletionProjection(
        commandId,
        subject.id,
        draft.target,
        draft.ranges,
        draft.protectedIds,
        draft.protectedRanges,
      );
      setDeletion(null);
      setFeedback('');
    });
    deletedCallback.current({
      commandId,
      subjectId: subject.id,
      plan: { fromMs: draft.target.fromMs, toMs: draft.target.toMs },
      optimisticRanges: draft.ranges,
      knownEmpty:
        !followLive &&
        !pagePending &&
        favoritesReady &&
        shown?.total === items.length &&
        draft.ranges.length === items.length,
    });
    try {
      const job = await result;
      if (mounted.current) deletionJobs.remember(job);
    } catch (cause) {
      if (cause instanceof MutationOutcomeUnknown) {
        if (!mounted.current) return;
        await deletionJobs.verify(
          commandId,
          () => {
            uncertainDeletionProjection(commandId);
            unconfirmedCommand.current = commandId;
            setFeedback(messageFor(cause));
          },
          () => {
            withdrawDeletionProjection(commandId);
            if (mounted.current) {
              deletedCallback.current({
                commandId,
                subjectId: subject.id,
                plan: draft.target,
                failed: true,
              });
              if (unconfirmedCommand.current === commandId)
                setFeedback(tr('暂未查到本次删除的接纳记录，已重新核对录像。'));
            }
          },
        );
        return;
      }
      const message = messageFor(cause);
      failDeletionProjection(commandId, message);
      if (mounted.current && scopeRef.current === draft.scope) setFeedback(message);
      deletedCallback.current({
        commandId,
        subjectId: subject.id,
        plan: draft.target,
        failed: true,
      });
    } finally {
      changed();
    }
  }
  function favoriteId(subjectId: string, unitId: string): string {
    return `${subjectId}/${unitId}`;
  }
  function favoriteFor(item: (typeof items)[number]) {
    const preview =
      favoritePreview?.scope === scope && favoritePreview.likedById.has(item.unitId)
        ? favoritePreview
        : null;
    const pending = subject ? pendingFavorites.get(favoriteId(subject.id, item.unitId)) : undefined;
    return {
      liked:
        pending ??
        preview?.likedById.get(item.unitId) ??
        isSnapshotLiked(item, displayMarkers?.favorites ?? []),
      writing: pending !== undefined || (!!preview && preview.revision === undefined),
    };
  }
  async function toggleFavorite(item: (typeof items)[number]): Promise<void> {
    if (!subject || commands.busy) return;
    const subjectId = subject.id;
    const ownerScope = scope;
    const signal = favoriteRead.current?.signal;
    const id = favoriteId(subjectId, item.unitId);
    if (pendingFavorites.has(id)) return;
    gestureMotion.favorite(item.unitId);
    const knownToggle = favoritesReady && markers ? !favoriteFor(item).liked : null;
    let feedbackMotion: Animation | undefined;
    setPendingFavorites((pending) => new Map(pending).set(id, knownToggle));
    setFeedback('');
    try {
      // Thumbnails can be interactive before their page-wide favorite read returns.
      const facts =
        knownToggle !== null && markers
          ? markers
          : await commands.queryFavorites(subjectId, [item.unitId], signal);
      if (signal?.aborted || !mounted.current || scopeRef.current !== ownerScope) return;
      const liked = knownToggle ?? !isSnapshotLiked(item, facts.favorites);
      if (knownToggle === null) setPendingFavorites((pending) => new Map(pending).set(id, liked));
      feedbackMotion = animateSnapshotAction(
        grid.current,
        item.unitId,
        liked ? 'favorite' : 'unfavorite',
      );
      const result = await commands.setFavorite(subjectId, item, liked, facts.revision, signal);
      if (mounted.current) acceptUnitFavorite(subjectId, item.unitId, result, facts);
    } catch (cause) {
      feedbackMotion?.cancel();
      if (!signal?.aborted && mounted.current && scopeRef.current === ownerScope)
        setFeedback(messageFor(cause));
    } finally {
      if (mounted.current)
        setPendingFavorites((pending) => {
          const next = new Map(pending);
          next.delete(id);
          return next;
        });
      queueMicrotask(() => {
        if (!commands.hasFavoriteWrites) changed();
      });
    }
  }
  async function updateFavorites(target: string[] | null): Promise<void> {
    if (!subject || commands.hasFavoriteWrites || (!target && !catalog?.total)) return;
    const operation = commands.begin(scope);
    if (!operation) return;
    const selected = target ? new Set(target) : null;
    const facts = favoritesReady ? markers : null;
    const likedById = new Map<string, boolean>();
    for (const item of items) {
      if (!selected) likedById.set(item.unitId, false);
      else if (facts && selected.has(item.unitId))
        likedById.set(item.unitId, !isSnapshotLiked(item, facts.favorites));
    }
    let retainPreview = false;
    setFavoritePreview({
      owner: operation.revision,
      scope,
      likedById,
    });
    const ownsUI = () => mounted.current && commands.current(operation, scopeRef.current);
    setActivity('favorite');
    setFeedback('');
    try {
      const result = target
        ? await commands.setFavorites(
            subject.id,
            target,
            'toggle',
            facts?.revision,
            operation.signal,
          )
        : await commands.unlikeRange(subject.id, displayRange, operation.signal);
      if (ownsUI()) {
        retainPreview = true;
        const accepted = 'favorites' in result ? result.favorites : undefined;
        const confirmed = target && accepted ? new Set(accepted.map((item) => item.id)) : null;
        setFavoritePreview((old) =>
          old?.owner === operation.revision
            ? {
                ...old,
                likedById:
                  target && confirmed
                    ? new Map(target.map((id) => [id, confirmed.has(id)]))
                    : old.likedById,
                revision: result.revision,
              }
            : old,
        );
        acceptPersonal(null);
      }
    } catch (cause) {
      if (ownsUI()) {
        setFeedback(messageFor(cause));
        if (
          (cause instanceof ApiError && cause.status === 409) ||
          cause instanceof MutationOutcomeUnknown
        )
          acceptPersonal(null);
      }
    } finally {
      if (!retainPreview)
        setFavoritePreview((old) => (old?.owner === operation.revision ? null : old));
      changed();
      if (commands.current(operation)) {
        commands.release(operation);
        if (mounted.current) setActivity(null);
      }
    }
  }
  const toolbar = (
    <SnapshotToolbar
      total={followLive ? items.length : (catalog?.total ?? 0)}
      pageIndex={pageIndex}
      pages={pages}
      live={followLive}
      connected={!!subject}
      busy={busy}
      status={feedback}
      onPrevious={() => turnPage(-1)}
      onNext={() => turnPage(1)}
      onUnlike={() => void updateFavorites(null)}
      onDelete={openDeletion}
      selection={
        selection.selectionActive
          ? {
              count: selection.selected.size,
              onClear: selection.dragging ? undefined : selection.clearSelection,
            }
          : undefined
      }
    />
  );

  return (
    <section
      ref={section}
      className="snapshot-section"
      aria-label={tr('时间段截图')}
      onClick={(event) => {
        if (selection.selectionActive && event.target === event.currentTarget)
          selection.clearSelection();
      }}
      data-from={displayRange.fromMs}
      data-to={displayRange.toMs}
    >
      {toolbar}
      {deletion?.scope === scope && (
        <MediaDeleteDialog
          anchor={section.current}
          onClose={() => {
            setDeletion(null);
          }}
          onConfirm={() => void confirmDeletion()}
        />
      )}
      {!holdingPage && (error !== null || (!items.length && !pagePending)) && (
        <SnapshotNotice
          scope={subject?.id ?? 'snapshots'}
          notice={
            error ??
            snapshotEmptyNotice(
              !subject
                ? 'idle'
                : !shown
                  ? 'loading'
                  : current?.total
                    ? 'page-empty'
                    : followLive &&
                        subject.providerStatus !== 'OFFLINE' &&
                        ['QUEUED', 'RESOLVING', 'CAPTURING'].includes(subject.captureState ?? '')
                      ? 'recording'
                      : 'empty',
              subject
                ? {
                    subjectName: subject.handle,
                    window: displayRange,
                    following: followLive,
                    offline: subject.providerStatus === 'OFFLINE',
                  }
                : undefined,
            )
          }
          compact={items.length > 0}
          onRetry={retryRead}
        />
      )}
      <div
        className="snapshot-viewport"
        {...selection.viewportProps}
        data-selecting={selection.dragging}
        data-edge={
          selection.edgeDirection === -1
            ? 'previous'
            : selection.edgeDirection === 1
              ? 'next'
              : undefined
        }
      >
        <div
          className="snapshot-grid"
          ref={grid}
          data-total-slots={slots.length}
          aria-busy={busy || pagePending || (!!subject && !shown)}
        >
          {slots.map((item, index) => {
            if (!item)
              return (
                <div
                  key={`empty:${index}`}
                  data-slot={index}
                  className={`snapshot-slot-empty${pagePending ? ' is-loading' : ''}`}
                  aria-hidden="true"
                />
              );
            if ('kind' in item)
              return (
                <div
                  data-slot={index}
                  key={
                    item.kind === 'pending'
                      ? `pending:${item.fromMs}`
                      : `gap:${item.fromMs}:${item.toMs}:${item.part}`
                  }
                  className={`snapshot-gap snapshot-gap--${item.kind}${playing?.kind === 'pending' && playing.fromMs === item.fromMs ? ' is-playing' : ''}`}
                  aria-current={
                    playing?.kind === 'pending' && playing.fromMs === item.fromMs
                      ? 'time'
                      : undefined
                  }
                  data-gap-from={item.fromMs}
                  data-gap-to={item.toMs}
                >
                  {item.part === Math.floor((item.parts ?? 1) / 2) && (
                    <span>
                      {item.kind === 'pending'
                        ? tr('等待落盘')
                        : tr('无录像 {{v0}}', { v0: durationLabel(item.toMs - item.fromMs) })}
                    </span>
                  )}
                </div>
              );
            const from = item.slotFromMs,
              to = item.slotToMs;
            const { liked, writing } = favoriteFor(item);
            const selected = selection.selected.has(item.unitId);
            const currentUnit = playing?.kind === 'unit' && playing.item === item;
            return (
              <div
                className="snapshot-cell"
                data-liked={liked}
                data-selected={selected}
                key={snapshotKey(item)}
                data-at={item.atMs}
                data-key={snapshotKey(item)}
                data-motion-key={snapshotKey(item)}
                data-slot={index}
                title={`${dayLabel(from)} ${clockLabel(from)} — ${dayLabel(to)} ${clockLabel(to)}`}
              >
                <button
                  data-unit-index={index}
                  data-liked={liked}
                  data-favorite-ready={favoritesReady && !pagePending && !activity}
                  aria-pressed={selected}
                  aria-busy={writing || undefined}
                  aria-keyshortcuts="F Shift+Space Enter Escape"
                  data-at={item.atMs}
                  data-key={snapshotKey(item)}
                  aria-current={currentUnit ? 'time' : undefined}
                  className={currentUnit ? 'selected' : ''}
                  disabled={pagePending}
                  aria-label={tr(
                    selection.selectionActive ? '选择 {{v0}}{{v1}}' : '播放 {{v0}}{{v1}}',
                    {
                      v0: formatDateTime(item.atMs),
                      v1: liked ? tr(' · 有喜欢标记') : '',
                    },
                  )}
                >
                  <div className="snapshot-picture">
                    <UnitImage
                      src={item.url}
                      subjectId={subject!.id}
                      unitId={item.unitId}
                      toMs={item.slotToMs}
                    />
                  </div>
                  <span className="snapshot-mark snapshot-favorite-mark" aria-hidden="true">
                    <Icon name="heart" />
                  </span>
                  <span className="snapshot-mark snapshot-playing-mark" aria-hidden="true">
                    <Icon name="play" />
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
