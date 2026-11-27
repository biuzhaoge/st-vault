import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Subject } from '@st-vault/api-schema';
import { Icon } from '../../design/Icon';
import { tr } from '../../shared/lib/i18n';
import { visibleSubjects } from '../directory/subjects';
import { MonitorCoverRefresh, MonitorTile } from './MonitorTile';
import type { StopMonitorStream } from './monitor-stream';
import { monitorGrid, MONITOR_GAP } from './wall-grid';
import './monitor-wall.css';

interface Props {
  subjects: Subject[];
  onClose: (released: Promise<void>) => void;
  onUnauthorized: () => void;
  returnRequested?: boolean;
}

export async function releaseMonitorStreams(stops: Iterable<StopMonitorStream>): Promise<void> {
  const results = await Promise.allSettled(Array.from(stops, async (stop) => stop()));
  for (const result of results) {
    if (result.status === 'rejected')
      console.warn('Monitor wall stream release failed', result.reason);
  }
}

export function MonitorWall({
  subjects,
  onClose,
  onUnauthorized,
  returnRequested,
}: Props): JSX.Element {
  const viewport = useRef<HTMLDivElement>(null);
  const returnButton = useRef<HTMLButtonElement>(null);
  const streams = useRef(new Set<StopMonitorStream>());
  const returning = useRef(false);
  const [{ width, height }, setSize] = useState({ width: 0, height: 0 });
  const online = useMemo(() => visibleSubjects(subjects, ['ONLINE']), [subjects]);
  const layout = useMemo(
    () => monitorGrid(online.length, width, height),
    [online.length, width, height],
  );

  const registerStream = useCallback((stop: StopMonitorStream): (() => void) => {
    if (returning.current) {
      // Tile effects can run before the workbench renders. Stop their queued open.
      void releaseMonitorStreams([stop]);
      return () => undefined;
    }
    streams.current.add(stop);
    return () => {
      streams.current.delete(stop);
    };
  }, []);
  const returnToWorkbench = useCallback((): void => {
    if (returning.current) return;
    returning.current = true;
    // Playback restoration still needs the released capacity. The view itself doesn't.
    onClose(releaseMonitorStreams(streams.current));
  }, [onClose]);
  useEffect(() => {
    if (returnRequested) returnToWorkbench();
  }, [returnRequested, returnToWorkbench]);

  useLayoutEffect(() => {
    const area = viewport.current;
    if (!area) return;
    const measure = (): void => {
      const width = area.clientWidth;
      const height = area.clientHeight;
      setSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    returnButton.current?.focus({ preventScroll: true });
    return () => observer.disconnect();
  }, []);

  return (
    <section className="monitor-wall" aria-label={tr('监控墙')}>
      <button
        ref={returnButton}
        type="button"
        className="monitor-wall-return"
        onClick={returnToWorkbench}
      >
        <Icon name="chevron-left" />
        {tr('返回工作台')}
      </button>
      <div className="monitor-wall-viewport" ref={viewport}>
        {online.length === 0 ? (
          <p className="muted">{tr('暂无在线主播')}</p>
        ) : (
          <div
            className="monitor-wall-grid"
            data-columns={layout?.columns}
            data-rows={layout?.rows}
            style={
              layout
                ? {
                    gridTemplateColumns: `repeat(${layout.columns}, ${layout.tileWidth}px)`,
                    gridTemplateRows: `repeat(${layout.rows}, ${layout.tileHeight}px)`,
                    gap: MONITOR_GAP,
                  }
                : undefined
            }
          >
            <MonitorCoverRefresh enabled>
              {online.map((subject) => (
                <MonitorTile
                  key={subject.id}
                  subject={subject}
                  onUnauthorized={onUnauthorized}
                  registerStream={registerStream}
                />
              ))}
            </MonitorCoverRefresh>
          </div>
        )}
      </div>
    </section>
  );
}
