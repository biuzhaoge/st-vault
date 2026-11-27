import {
  createContext,
  memo,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { subjectDirectory, type LiveProgress, type Subject } from '@st-vault/api-schema';
import { ApiError, request } from '../../shared/lib/api';
import { tr } from '../../shared/lib/i18n';
import { useSyncClock, useSyncRefresh } from '../../shared/lib/sync';
import { MediaSlot, sourceKey, type MediaSlotHandle, type PlayerSource } from '../player/MediaSlot';
import { PlaybackNoticeContent } from '../player/PlaybackNoticeContent';
import { PlaybackPosterImage } from '../player/PlaybackPoster';
import {
  liveNotice,
  mediaNotice,
  requestNotice,
  type MediaPhase,
  type PlaybackNotice,
} from '../player/player-status';
import { useNoticeStage } from '../player/use-notice-stage';
import {
  isMonitorOpenConnectionFailure,
  monitorConnectionRetryAt,
  startMonitorStream,
  type StopMonitorStream,
} from './monitor-stream';
import '../player/player-controls.css';
import './monitor-tile.css';

interface Props {
  subject: Subject;
  onUnauthorized: () => void;
  registerStream: (stop: StopMonitorStream) => () => void;
}

type OpenResult =
  | { attempt: number; source: PlayerSource }
  | { attempt: number; notice: PlaybackNotice; retryAt?: number; retryOnPublicFrom?: number };

const ignore = (): void => undefined;
const CoverRevisionContext = createContext(0);

export function MonitorCoverRefresh({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}): JSX.Element {
  const [revision, setRevision] = useState(0);
  useSyncClock(() => setRevision((previous) => previous + 1), enabled);
  return <CoverRevisionContext.Provider value={revision}>{children}</CoverRevisionContext.Provider>;
}

function MonitorPoster({ subject }: { subject: Subject }): JSX.Element {
  const revision = useContext(CoverRevisionContext);
  return (
    <div className="playback-poster" aria-hidden="true">
      <PlaybackPosterImage subject={subject} revision={revision} />
    </div>
  );
}

function Picture({
  subject,
  notice,
  children,
  hasFrame = false,
  onRetry,
  retryLabel = tr('重新连接'),
}: {
  subject: Subject;
  notice: PlaybackNotice | null;
  children?: ReactNode;
  hasFrame?: boolean;
  onRetry?: () => void;
  retryLabel?: string;
}): JSX.Element {
  const stage = useNoticeStage(notice, subject.id);
  return (
    <>
      {children}
      {!hasFrame && <MonitorPoster subject={subject} />}
      {notice && stage !== 'hidden' && (
        <div
          className={`playback-status${hasFrame ? ' playback-status--compact' : ''}${stage === 'brief' ? ' playback-status--brief' : ''}`}
          data-kind={notice.kind}
          role="status"
          aria-live="off"
        >
          <PlaybackNoticeContent
            notice={notice}
            brief={stage === 'brief'}
            onRetry={onRetry}
            retryLabel={retryLabel}
          />
        </div>
      )}
    </>
  );
}

function MonitorPlayback({
  subject,
  source,
  progress,
  onRetry,
  onConnectionFailure,
  onStablePlayback,
}: {
  subject: Subject;
  source: PlayerSource;
  progress: LiveProgress | null;
  onRetry: () => void;
  onConnectionFailure: (notice: PlaybackNotice) => void;
  onStablePlayback: () => void;
}): JSX.Element {
  const slot = useRef<MediaSlotHandle>(null);
  const [phase, setPhase] = useState<MediaPhase>('engine');
  const [hasFrame, setHasFrame] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const serverNotice =
    progress && (progress.phase !== 'ended' || phase === 'ended') ? liveNotice(progress) : null;
  const blocked = phase === 'blocked';
  const failure: PlaybackNotice | null = error
    ? {
        kind: blocked ? 'action' : 'error',
        title: blocked ? tr('等待点击播放') : tr('播放已中断'),
        detail: error,
        retry: true,
      }
    : null;
  const notice = failure ?? (ready ? null : (serverNotice ?? mediaNotice(phase, true)));
  const readyFrame = (): void => {
    setHasFrame(true);
    setReady(true);
  };
  return (
    <Picture
      subject={subject}
      notice={notice}
      hasFrame={hasFrame}
      retryLabel={blocked ? tr('开始播放') : tr('重新连接')}
      onRetry={blocked ? () => void slot.current?.play() : onRetry}
    >
      <MediaSlot
        ref={slot}
        source={source}
        active
        muted
        volume={0}
        manageSession={false}
        observeProgress={false}
        onProgress={ignore}
        onReady={readyFrame}
        onBuffering={() => setReady(false)}
        onEnded={() => {
          setPhase('ended');
          setReady(false);
        }}
        onPlaying={ignore}
        onAudio={ignore}
        onError={setError}
        onConnectionFailure={(detail) =>
          onConnectionFailure({ kind: 'error', title: tr('播放已中断'), detail, retry: true })
        }
        onStablePlayback={onStablePlayback}
        onRecovered={() => {
          setError('');
          readyFrame();
        }}
        onPhase={setPhase}
      />
    </Picture>
  );
}

function MonitorStream({ subject, onUnauthorized, registerStream }: Props): JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<OpenResult>();
  const [progress, setProgress] = useState<{ attempt: number; value: LiveProgress }>();
  const busyCount = useRef(0);
  const connectionRetries = useRef(0);
  const failedAttempt = useRef(-1);
  const publicGeneration = useRef(0);
  const closeStream = useRef<StopMonitorStream>();
  const latest = useRef({ subject, onUnauthorized });
  latest.current = { subject, onUnauthorized };
  const current = result?.attempt === attempt ? result : undefined;
  const update = progress?.attempt === attempt ? progress.value : null;
  const retry = (): void => {
    busyCount.current = 0;
    connectionRetries.current = 0;
    setAttempt((value) => value + 1);
  };
  const connectionFailure = (notice: PlaybackNotice, notBeforeMs = 0): void => {
    // The media slot and server can both report the same stopped stream.
    if (failedAttempt.current === attempt) return;
    failedAttempt.current = attempt;
    void closeStream.current?.();
    const retryAt = monitorConnectionRetryAt(connectionRetries.current, notBeforeMs);
    if (retryAt !== undefined) connectionRetries.current++;
    setResult({
      attempt,
      notice:
        retryAt === undefined ? notice : { ...mediaNotice('network', true), detail: notice.detail },
      retryAt,
    });
  };

  useEffect(() => {
    if (subject.providerStatus === 'PUBLIC') publicGeneration.current++;
  }, [subject.providerStatus]);

  useEffect(() => {
    const selected = latest.current.subject;
    const requestedAt = publicGeneration.current;
    const stop = startMonitorStream(
      selected,
      (source) => {
        busyCount.current = 0;
        setResult({ attempt, source });
      },
      (cause) => {
        if (cause instanceof ApiError && cause.status === 401) {
          latest.current.onUnauthorized();
        } else if (cause instanceof ApiError && cause.message === 'live_busy') {
          const base = Math.min(3000 * 2 ** busyCount.current, 15000);
          const stagger = (selected.providerId % 113) * 34;
          busyCount.current++;
          setResult({
            attempt,
            notice: liveNotice({ phase: 'queued' })!,
            retryAt: Math.max(cause.notBeforeMs, Date.now() + base + stagger),
          });
        } else if (isMonitorOpenConnectionFailure(cause)) {
          connectionFailure(
            requestNotice(cause, true),
            cause instanceof ApiError ? cause.notBeforeMs : 0,
          );
        } else
          setResult({
            attempt,
            notice: requestNotice(cause, true),
            retryOnPublicFrom:
              cause instanceof ApiError && cause.reason === 'status-unknown'
                ? requestedAt
                : undefined,
          });
      },
    );
    closeStream.current = stop;
    const unregister = registerStream(stop);
    const leaving = (): void => void stop(true);
    const returning = (event: PageTransitionEvent): void => {
      if (event.persisted) setAttempt((value) => value + 1);
    };
    window.addEventListener('pagehide', leaving);
    window.addEventListener('pageshow', returning);
    return () => {
      window.removeEventListener('pagehide', leaving);
      window.removeEventListener('pageshow', returning);
      if (closeStream.current === stop) closeStream.current = undefined;
      // Keep pending releases visible to the wall when a row disappears or turns private.
      void stop().then(unregister, unregister);
    };
  }, [subject.id, attempt, registerStream]);

  const retryOnPublicFrom =
    current && 'retryOnPublicFrom' in current ? current.retryOnPublicFrom : undefined;
  useEffect(() => {
    // The directory can retain an online row while its current status is unknown.
    if (
      subject.providerStatus === 'PUBLIC' &&
      retryOnPublicFrom !== undefined &&
      publicGeneration.current > retryOnPublicFrom
    )
      setAttempt((value) => (value === attempt ? value + 1 : value));
  }, [subject.providerStatus, retryOnPublicFrom, attempt]);

  const retryAt = current && 'retryAt' in current ? current.retryAt : undefined;
  useEffect(() => {
    if (retryAt === undefined) return;
    let timer: number | undefined;
    const schedule = (): void => {
      window.clearTimeout(timer);
      if (document.visibilityState === 'visible')
        timer = window.setTimeout(
          () => setAttempt((value) => (value === attempt ? value + 1 : value)),
          Math.max(0, retryAt - Date.now()),
        );
    };
    schedule();
    document.addEventListener('visibilitychange', schedule);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', schedule);
    };
  }, [retryAt, attempt]);

  useSyncRefresh(
    ['playback'],
    async (signal) => {
      try {
        const value = await request<LiveProgress | null>(
          `/api/subjects/${encodeURIComponent(subject.id)}/live-progress`,
          { signal },
        );
        if (signal.aborted || !value) return;
        if (current && 'source' in current && value.phase === 'stopped') {
          const notice = liveNotice(value)!;
          if (['network', 'source', 'timeout'].includes(value.reason ?? '')) {
            connectionFailure(notice);
          } else {
            failedAttempt.current = attempt;
            void closeStream.current?.();
            setResult({
              attempt,
              notice,
              retryOnPublicFrom:
                value.reason === 'status-unknown' ? publicGeneration.current : undefined,
            });
          }
          return { status: 'stop' };
        }
        setProgress({ attempt, value });
      } catch (cause) {
        if (signal.aborted) return;
        if (cause instanceof ApiError && cause.status === 401) {
          latest.current.onUnauthorized();
          return { status: 'stop' };
        }
        throw cause;
      }
      return undefined;
    },
    !current || 'source' in current,
    `${subject.id}:${attempt}`,
  );

  if (current && 'source' in current)
    return (
      <MonitorPlayback
        key={sourceKey(current.source)}
        subject={subject}
        source={current.source}
        progress={update}
        onRetry={retry}
        onConnectionFailure={connectionFailure}
        onStablePlayback={() => {
          if (failedAttempt.current !== attempt) connectionRetries.current = 0;
        }}
      />
    );

  const notice = current?.notice ??
    (update && liveNotice(update)) ?? {
      kind: 'loading',
      title: tr('请求直播会话'),
      detail: tr('正在向本机服务请求直播连接。'),
    };
  return <Picture subject={subject} notice={notice} onRetry={retry} />;
}

export const MonitorTile = memo(function MonitorTile({
  subject,
  onUnauthorized,
  registerStream,
}: Props): JSX.Element {
  useTranslation();
  const privateStream =
    subject.providerStatus === 'PRIVATE' || subjectDirectory(subject).orderStatus === 'PRIVATE';
  return (
    <article
      className="monitor-tile player-picture"
      data-subject-id={subject.id}
      aria-label={subject.handle}
    >
      {privateStream ? (
        <Picture subject={subject} notice={liveNotice({ phase: 'stopped', reason: 'private' })} />
      ) : (
        <MonitorStream
          key={subject.id}
          subject={subject}
          onUnauthorized={onUnauthorized}
          registerStream={registerStream}
        />
      )}
      <span className="monitor-tile-name" title={subject.handle}>
        {subject.handle}
      </span>
    </article>
  );
});
