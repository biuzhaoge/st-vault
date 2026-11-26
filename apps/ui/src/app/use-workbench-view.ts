import type { MediaTimeRange, SessionInfo } from '@st-vault/api-schema';
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_SUBJECT_FILTERS, type SubjectFilter } from '../features/directory/subjects';
import { dayStart } from '../shared/lib/time';
import { syncReadFailure, useDisplayClock, useSyncClock, useSyncRefresh } from '../shared/lib/sync';
import { request } from '../shared/lib/api';
import { ArchiveCalendar, fullCalendar } from '../features/timeline/archive-calendar';
import {
  readWorkspace,
  writeWorkspace,
  type ListPosition,
  type WorkspaceState,
} from '../shared/lib/workspace-state';
import {
  calendarWindow,
  DEFAULT_RANGE_MS,
  moveWindow,
  restoreViewWindow,
  type ViewWindow,
} from '../features/timeline/range-control';
import {
  clearPreferences,
  preferenceKey,
  readPreferences,
  writePreferences,
} from '../features/timeline/view-preferences';

/** Owns the visible calendar window and the per-user browser storage that restores it. */
export function useWorkbenchView(session: SessionInfo | null) {
  const [directoryFilters, setDirectoryFilters] = useState(DEFAULT_SUBJECT_FILTERS);
  const [view, setView] = useState<ViewWindow>(() => calendarWindow(Date.now(), DEFAULT_RANGE_MS));
  const [preferencesReady, setPreferencesReady] = useState<string | null>(null);
  const [requestedSpan, setRequestedSpan] = useState(DEFAULT_RANGE_MS);
  const [nowMs, setNowMs] = useState(Date.now);
  const [dataNowMs, setDataNowMs] = useState(Date.now);
  const timelineStartFallback = useRef(nowMs);
  const timelineStartMs = session?.timelineStartMs ?? timelineStartFallback.current;
  const storageKey = preferenceKey(session);
  const [days, setDays] = useState<{
    key: string;
    signature: string;
    calendar: ArchiveCalendar;
  } | null>(null);
  const loadedCalendar = days?.key === storageKey ? days.calendar : null;
  const archiveCalendar = loadedCalendar ?? fullCalendar;
  const pendingView = useRef<{ viewToMs: number | null; durationMs: number } | null>(null);
  useSyncRefresh(
    ['timeline'],
    async (signal, change) => {
      if (!storageKey || (loadedCalendar && change?.timelineSubjectIds?.length)) return;
      try {
        const { emptyDays } = await request<{ emptyDays: MediaTimeRange[] }>(
          '/api/archive-calendar',
          { signal },
        );
        if (signal.aborted) return;
        const signature = JSON.stringify(emptyDays);
        setDays((previous) =>
          previous?.key === storageKey && previous.signature === signature
            ? previous
            : { key: storageKey, signature, calendar: new ArchiveCalendar(emptyDays) },
        );
      } catch (error) {
        return syncReadFailure(error, signal);
      }
      return undefined;
    },
    session?.authenticated === true,
    `${storageKey}:${dayStart(nowMs)}`,
  );
  const [restorePosition, setRestorePosition] = useState<ListPosition | null>(null);
  const workspaceState = useRef<WorkspaceState>({ list: null, playback: null });
  const workspaceRestored = useRef(false);
  const pendingWorkspace = useRef<WorkspaceState | null>(null);
  useEffect(() => {
    if (!storageKey) {
      pendingView.current = null;
      setPreferencesReady(null);
      return;
    }
    const saved = readPreferences(storageKey),
      now = Date.now();
    pendingWorkspace.current = readWorkspace(storageKey);
    workspaceRestored.current = false;
    workspaceState.current = pendingWorkspace.current;
    setRestorePosition(pendingWorkspace.current.list);
    setDirectoryFilters(saved.filters);
    setRequestedSpan(saved.durationMs);
    pendingView.current = loadedCalendar
      ? null
      : { viewToMs: saved.viewToMs ?? null, durationMs: saved.durationMs };
    setView(
      restoreViewWindow(saved.viewToMs, saved.durationMs, now, timelineStartMs, archiveCalendar),
    );
    setPreferencesReady(storageKey);
  }, [storageKey, timelineStartMs]);
  function takeSavedPlayback(subjectsLoaded: boolean): WorkspaceState['playback'] {
    if (
      !storageKey ||
      preferencesReady !== storageKey ||
      !subjectsLoaded ||
      workspaceRestored.current
    )
      return null;
    workspaceRestored.current = true;
    return pendingWorkspace.current?.playback ?? null;
  }
  useEffect(() => {
    if (!storageKey) return;
    const save = (): void => {
      if (!workspaceRestored.current) return;
      writeWorkspace(storageKey, workspaceState.current);
      if (pendingView.current) return;
      writePreferences(storageKey, {
        filters: directoryFilters,
        durationMs: requestedSpan,
        viewToMs: storedViewTo,
      });
    };
    window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, [storageKey, directoryFilters, requestedSpan, view.toMs]);
  const storedViewTo = view.toMs;
  useEffect(() => {
    if (!storageKey || preferencesReady !== storageKey || pendingView.current) return;
    const timer = window.setTimeout(
      () =>
        writePreferences(storageKey, {
          filters: directoryFilters,
          durationMs: requestedSpan,
          viewToMs: storedViewTo,
        }),
      200,
    );
    return () => window.clearTimeout(timer);
  }, [storageKey, preferencesReady, directoryFilters, requestedSpan, storedViewTo, loadedCalendar]);

  useDisplayClock((at) => setNowMs(at), session?.authenticated === true);
  useSyncClock((at) => setDataNowMs(at), session?.authenticated === true);
  useEffect(() => {
    // Restoration installs span and position together. Do not normalize that
    // window using the default span from the render that started restoration.
    if (!storageKey || preferencesReady !== storageKey) return;
    if (pendingView.current) {
      if (!loadedCalendar) return;
      const saved = pendingView.current;
      pendingView.current = null;
      setView(
        restoreViewWindow(saved.viewToMs, saved.durationMs, nowMs, timelineStartMs, loadedCalendar),
      );
      return;
    }
    setView((current) => {
      const next = calendarWindow(
        current.fromMs,
        requestedSpan,
        timelineStartMs,
        nowMs,
        archiveCalendar,
      );
      return next.fromMs === current.fromMs && next.toMs === current.toMs ? current : next;
    });
  }, [
    nowMs,
    timelineStartMs,
    requestedSpan,
    storageKey,
    preferencesReady,
    archiveCalendar,
    loadedCalendar,
  ]);
  function resize(next: ViewWindow): void {
    const duration = archiveCalendar.visibleSpan(next.fromMs, next.toMs);
    setRequestedSpan(duration);
    setView(calendarWindow(next.fromMs, duration, timelineStartMs, Date.now(), archiveCalendar));
  }
  function move(direction: -1 | 1): void {
    setView((current) =>
      moveWindow(current, direction, timelineStartMs, Date.now(), requestedSpan, archiveCalendar),
    );
  }
  function showAt(at: number): void {
    setView(calendarWindow(at, requestedSpan, timelineStartMs, Date.now(), archiveCalendar));
  }
  function revealRange(range: ViewWindow): void {
    if (range.toMs <= view.fromMs || range.fromMs >= view.toMs) showAt(range.fromMs);
  }
  function toggleDirectoryFilter(filter: SubjectFilter): void {
    setDirectoryFilters((current) =>
      current.includes(filter)
        ? current.filter((selected) => selected !== filter)
        : [...current, filter],
    );
  }
  function includeDirectoryFilter(filter: SubjectFilter): void {
    setDirectoryFilters((current) => (current.includes(filter) ? current : [...current, filter]));
  }
  function clear(): void {
    clearPreferences(storageKey);
    if (storageKey) writeWorkspace(storageKey, null);
    workspaceRestored.current = false;
    setPreferencesReady(null);
    setDays(null);
  }
  function rememberPlayback(playback: WorkspaceState['playback']): void {
    if (workspaceRestored.current) workspaceState.current.playback = playback;
  }
  function rememberCursor(at: number, unitId?: string): void {
    if (workspaceState.current.playback) {
      workspaceState.current.playback.atMs = Math.round(at);
      workspaceState.current.playback.explicitUnitId = unitId;
    }
  }
  return {
    directoryFilters,
    toggleDirectoryFilter,
    includeDirectoryFilter,
    view,
    archiveCalendar,
    nowMs,
    dataNowMs,
    timelineStartMs,
    storageKey,
    preferencesReady,
    restorePosition,
    takeSavedPlayback,
    rememberPlayback,
    rememberCursor,
    clear,
    rememberList: (position: ListPosition) => {
      workspaceState.current.list = position;
    },
    resize,
    move,
    showAt,
    revealRange,
  };
}
