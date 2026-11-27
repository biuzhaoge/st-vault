import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { setTimeZone } from './shared/lib/time';
import { Icon } from './design/Icon';
import { AccountTools } from './features/account/AccountTools';
import { AuthGate } from './features/auth/AuthGate';
import { useSession } from './features/auth/use-session';
import { SubjectFilters } from './features/directory/SubjectFilters';
import { GlobalRecordingSettings } from './features/directory/RecordingMode';
import { subjectCounts, subjectGroup, visibleSubjects } from './features/directory/subjects';
import { HistoryPanel } from './features/history/HistoryPanel';
import { KeyTools } from './features/keys/KeyTools';
import { MonitorWall } from './features/monitor/MonitorWall';
import { RoutingOptions } from './features/network/RoutingOptions';
import { FocusTimeline } from './features/player/FocusTimeline';
import { Player } from './features/player/Player';
import { RowConnection } from './features/player/RowConnection';
import { RowAnchorStore } from './features/player/row-anchor';
import { SnapshotGrid } from './features/snapshots/SnapshotGrid';
import { systemHealthStatus } from './features/status/display';
import { TrackBoard } from './features/timeline/TrackBoard';
import { tr } from './shared/lib/i18n';
import { coverImages, snapshotImages } from './shared/lib/image-loader';
import type { WorkspaceState } from './shared/lib/workspace-state';
import { BrandName } from './shared/ui/BrandName';
import { PanelFeedback } from './shared/ui/PanelContent';
import { ProgressRing } from './shared/ui/ProgressRing';
import { ToolPopover } from './shared/ui/ToolPopover';

import { HeaderTools, type Tool } from './app/HeaderTools';
import { RuntimeSettingsForm } from './features/settings/RuntimeSettingsForm';
import { backgroundTaskAlert } from './features/status/background-status';
import { SystemSummary } from './features/status/SystemSummary';
import { useWorkbenchView } from './app/use-workbench-view';
import { useWorkbenchData } from './app/use-workbench-data';
import { useWorkbenchPlayback } from './app/use-workbench-playback';

function WorkbenchSurface({
  alternate,
  workspace,
  children,
}: {
  alternate?: ReactNode;
  workspace: RefObject<HTMLDivElement>;
  children: ReactNode;
}): ReactNode {
  return (
    alternate ?? (
      <div className="studio-workspace" id="top" ref={workspace}>
        {children}
      </div>
    )
  );
}

export default function App(): JSX.Element {
  useTranslation();
  const { session, setSession, sessionError, retrySession, logoutState, revokeSession } =
    useSession();
  const [tool, setTool] = useState<Tool | null>(null);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [monitorReturnRequested, setMonitorReturnRequested] = useState(false);
  const savedWorkbenchPlayback = useRef<WorkspaceState['playback']>(null);
  const currentListPosition = useRef<WorkspaceState['list']>(null);
  const [returnPosition, setReturnPosition] = useState<WorkspaceState['list']>(null);
  const returnFocus = useRef(false);
  const [revealSubject, setRevealSubject] = useState<{ id: string; token: number } | null>(null);
  const workspace = useRef<HTMLDivElement>(null),
    viewer = useRef<HTMLElement>(null);
  const [anchor] = useState(() => new RowAnchorStore());
  const calendar = useWorkbenchView(session);
  const { storageKey } = calendar;
  const data = useWorkbenchData(
    session?.authenticated === true,
    tool === 'history',
    handleUnauthorized,
    (rows) => media.closeMissing(rows),
  );
  const { subjects, system } = data;
  const media = useWorkbenchPlayback(
    subjects,
    session?.authenticated === true,
    calendar,
    handleUnauthorized,
  );
  const { selected, selection } = media;
  const counts = useMemo(() => subjectCounts(subjects), [subjects]);
  const filtered = useMemo(
    () => visibleSubjects(subjects, calendar.directoryFilters),
    [subjects, calendar.directoryFilters],
  );
  useEffect(() => {
    if (monitorOpen) return;
    const saved = calendar.takeSavedPlayback(data.subjectsLoaded);
    const subject = subjects.find((row) => row.id === saved?.subjectId);
    if (saved && subject) media.restore(subject, saved);
  }, [storageKey, calendar.preferencesReady, data.subjectsLoaded, subjects, monitorOpen]);
  calendar.rememberPlayback(monitorOpen ? savedWorkbenchPlayback.current : media.position);
  useEffect(() => {
    if (monitorOpen || !returnFocus.current) return;
    returnFocus.current = false;
    workspace.current?.querySelector<HTMLButtonElement>('.monitor-wall-trigger')?.focus();
  }, [monitorOpen]);

  function openMonitor(): void {
    const position = media.position;
    savedWorkbenchPlayback.current =
      position?.kind === 'archive' && position.atMs === null ? null : position;
    setReturnPosition(currentListPosition.current);
    setTool(null);
    media.closePlayer();
    setMonitorOpen(true);
  }
  function closeMonitor(released: Promise<void>): void {
    media.trackMonitorRelease(released);
    const saved = savedWorkbenchPlayback.current;
    savedWorkbenchPlayback.current = null;
    returnFocus.current = true;
    setTool(null);
    setMonitorReturnRequested(false);
    setMonitorOpen(false);
    const subject = subjects.find(({ id }) => id === saved?.subjectId);
    if (saved && subject) media.restore(subject, saved);
  }

  function handleUnauthorized(): void {
    coverImages.clear();
    snapshotImages.clear();
    calendar.clear();
    data.clearSubjects();
    media.closePlayer();
    savedWorkbenchPlayback.current = null;
    currentListPosition.current = null;
    returnFocus.current = false;
    setMonitorReturnRequested(false);
    setMonitorOpen(false);
    setReturnPosition(null);
    setSession({ authenticated: false, setupRequired: false });
  }
  useEffect(() => {
    const cleared = (event: StorageEvent): void => {
      if (storageKey && event.key === storageKey && event.newValue === null) handleUnauthorized();
    };
    window.addEventListener('storage', cleared);
    return () => window.removeEventListener('storage', cleared);
  }, [storageKey, session, media.closePlayer]);
  async function logout(): Promise<void> {
    setRevealSubject(null);
    handleUnauthorized();
    await revokeSession();
  }
  const health =
    system || data.systemError
      ? systemHealthStatus({
          diskError: system?.disk.error,
          lowSpace: system?.disk.lowSpace ?? false,
          maintenanceError: system?.maintenanceError,
          archiveError: system?.archiveHealth ? system.archiveHealth.error : 'archive_checking',
          restarting: system?.archiveHealth?.recovery === 'restart-requested',
          serviceError: !!data.systemError,
        })
      : null;
  if (logoutState !== 'idle')
    return (
      <main className="loading-page">
        {logoutState === 'sending' ? (
          <p role="status">{tr('正在退出…')}</p>
        ) : (
          <>
            <p role="alert">{tr('此页已锁定，服务器尚未确认退出。')}</p>
            <button type="button" onClick={() => void revokeSession()}>
              {tr('重试退出')}
            </button>
          </>
        )}
      </main>
    );
  if (!session)
    return (
      <main className="loading-page">
        {sessionError ? (
          <>
            <p role="alert">{sessionError}</p>
            <button type="button" onClick={retrySession}>
              {tr('重新连接')}
            </button>
          </>
        ) : (
          <>
            <span className="spinner" />
            <p role="status">{tr('连接本地归档…')}</p>
          </>
        )}
      </main>
    );
  if (!session.authenticated)
    return (
      <AuthGate
        session={session}
        onDone={(next) => {
          setTimeZone(next.timeZone ?? 'Asia/Shanghai');
          setSession(next);
        }}
      />
    );
  const content = (
    <main className="app-shell studio-shell">
      <header className="topbar">
        <div className="brand">
          <img src="/assets/st-vault-mark.png" alt={tr('ST-Vault 标识')} />
          <BrandName />
        </div>
        <HeaderTools
          statusAlert={
            health && health.kind !== 'ok' && health.kind !== 'checking'
              ? health.title
              : backgroundTaskAlert(system?.backgroundTasks ?? [])
          }
          open={tool}
          setOpen={setTool}
          unread={data.eventMeta?.unreadCount ?? 0}
          history={
            <HistoryPanel
              active={tool === 'history'}
              meta={data.eventMeta}
              onMeta={data.setEventMeta}
              subjects={subjects}
              onReveal={(id) => {
                const subject = subjects.find((row) => row.id === id);
                if (!subject) return;
                if (monitorOpen) setMonitorReturnRequested(true);
                calendar.includeDirectoryFilter(subjectGroup(subject));
                setRevealSubject((previous) => ({ id, token: (previous?.token ?? 0) + 1 }));
                setTool(null);
              }}
            />
          }
          deletionBusy={data.deletionJobs.some(
            (job) => !['completed', 'failed'].includes(job.state),
          )}
          onLogout={() => void logout()}
          status={
            <SystemSummary
              system={system}
              deletions={data.deletionJobs}
              subjects={subjects}
              autoRecordingCount={subjects.filter((subject) => subject.autoRecord).length}
              onRefresh={data.loadSystem}
            />
          }
          settings={
            system?.settings ? (
              <RuntimeSettingsForm
                settings={system.settings}
                recording={
                  <GlobalRecordingSettings
                    value={system.recordAll ?? false}
                    onChange={data.setGlobalRecording}
                  />
                }
                onSaved={async (settings) => {
                  data.setSystem((current) => (current ? { ...current, settings } : current));
                  await data.loadSystem();
                }}
              />
            ) : (
              <PanelFeedback kind={data.systemError ? 'error' : 'info'}>
                {data.systemError || tr('正在读取状态')}
              </PanelFeedback>
            )
          }
        />
      </header>
      <WorkbenchSurface
        workspace={workspace}
        alternate={
          monitorOpen ? (
            <MonitorWall
              subjects={subjects}
              onClose={closeMonitor}
              onUnauthorized={handleUnauthorized}
              returnRequested={monitorReturnRequested}
            />
          ) : null
        }
      >
        <aside className="studio-viewer" ref={viewer}>
          <Player
            siteOrigin={system?.siteRoutes?.selectedOrigin}
            ref={media.player}
            range={media.source || media.hasSelection || media.playBusy ? selection : null}
            controlsPinned={tool === 'keys' || tool === 'cdn'}
            tools={
              <>
                <ToolPopover
                  title={tr('视频 CDN')}
                  icon="network"
                  size="compact"
                  className="cdn-tool"
                  open={tool === 'cdn'}
                  onToggle={() => setTool((current) => (current === 'cdn' ? null : 'cdn'))}
                  onClose={() => setTool((current) => (current === 'cdn' ? null : current))}
                  trigger={<Icon name="network" />}
                >
                  <RoutingOptions
                    kind="cdn"
                    subjectId={selected?.id}
                    onCdnChanged={() => {
                      if (
                        selected &&
                        media.live &&
                        (media.playerNotice?.action === 'choose-cdn' ||
                          (media.liveProgress?.phase === 'stopped' &&
                            (media.liveProgress.reason === 'timeout' ||
                              media.liveProgress.reason === 'source' ||
                              media.liveProgress.reason === 'network')))
                      ) {
                        setTool(null);
                        void media.open(selected, undefined, selection, { restart: true });
                      }
                    }}
                  />
                </ToolPopover>
                <ToolPopover
                  title={tr('密钥')}
                  icon="key"
                  size="compact"
                  className={`key-tool${(data.keyInfo?.keyCount ?? 0) > 0 ? ' has-keys' : ''}${data.keyBusy ? ' is-busy' : ''}`}
                  busy={data.keyBusy}
                  open={tool === 'keys'}
                  onToggle={() => setTool((current) => (current === 'keys' ? null : 'keys'))}
                  onClose={() => setTool((current) => (current === 'keys' ? null : current))}
                  trigger={data.keyBusy ? <ProgressRing /> : <Icon name="key" />}
                >
                  <KeyTools onChanged={data.setKeyInfo} onBusyChange={data.setKeySaving} />
                </ToolPopover>
              </>
            }
            source={media.source}
            busy={media.playBusy}
            subject={selected}
            notice={media.playerNotice}
            liveProgress={media.liveProgress}
            live={media.live}
            onImportKeys={() => setTool('keys')}
            onChooseCdn={() => setTool('cdn')}
            onRetry={media.retry}
            timeline={
              <>
                <FocusTimeline
                  subjectId={media.selectedId}
                  window={selection}
                  queryWindow={media.dataWindow}
                  timelineStartMs={calendar.timelineStartMs}
                  calendar={calendar.archiveCalendar}
                  atMs={media.targetMs}
                  playbackClock={media.playbackClock}
                  onSeek={(utc) => {
                    void media.scrubPlayback(utc);
                  }}
                />
              </>
            }
            calendar={calendar.archiveCalendar}
            onSeek={(utc) => void media.scrubPlayback(utc)}
            snapshots={
              <SnapshotGrid
                subject={selected}
                referenceMs={media.snapshotReference}
                window={media.requestedSelection}
                queryWindow={media.dataWindow}
                followLive={!media.hasSelection}
                playingLive={
                  media.source?.kind === 'live' && media.source.subject.id === media.selectedId
                }
                navigation={media.playbackNavigation}
                atMs={media.targetMs}
                playbackClock={media.playbackClock}
                onSession={media.onSnapshotSession}
                onSeek={media.playSnapshot}
                onDeletion={media.onMediaDeletion}
                reselecting={media.reselecting}
                onJobs={data.setDeletionJobs}
                jobSnapshot={
                  data.systemError ? null : system ? (system.deletionJobs ?? null) : undefined
                }
              />
            }
            onCursor={media.cursor}
            onFollowLive={media.followLive}
            onPrepareNext={media.prepareNext}
            onAdvance={media.advancePlayback}
          />
        </aside>
        <section className="aligned-arrangement">
          <TrackBoard
            key={storageKey}
            restorePosition={returnPosition ?? calendar.restorePosition}
            onPosition={(position) => {
              currentListPosition.current = position;
              calendar.rememberList(position);
            }}
            reveal={revealSubject}
            subjects={filtered}
            filterKey={calendar.directoryFilters.join(',')}
            selectedId={media.selectedId}
            fromMs={calendar.view.fromMs}
            toMs={calendar.view.toMs}
            selection={selection}
            timelineStartMs={calendar.timelineStartMs}
            calendar={calendar.archiveCalendar}
            nowMs={calendar.nowMs}
            account={
              <AccountTools
                onImported={async () => {
                  await data.loadSubjects();
                }}
                open={tool === 'account'}
                onToggle={() => setTool((current) => (current === 'account' ? null : 'account'))}
                onClose={() => setTool((current) => (current === 'account' ? null : current))}
              />
            }
            filters={
              <SubjectFilters
                filters={calendar.directoryFilters}
                counts={counts}
                onToggle={calendar.toggleDirectoryFilter}
              />
            }
            onChoose={(subject, utc, range) => void media.open(subject, utc, range)}
            onRangeChoose={media.selectRange}
            onAnchor={anchor.set}
            onViewChange={calendar.resize}
            onMove={calendar.move}
            onRecordingChange={(subject, record) => data.setRecording(subject.id, record)}
            onUnfollow={data.unfollow}
            onOpenMonitor={openMonitor}
          />
          {data.error && (
            <p className="form-error" role="status">
              {data.error}
            </p>
          )}
        </section>
        <RowConnection
          anchor={anchor}
          workspace={workspace}
          viewer={viewer}
          name={selected?.handle ?? ''}
          onClose={media.closePlayer}
        />
      </WorkbenchSurface>
    </main>
  );
  return content;
}
