import { tr } from '../../shared/lib/i18n';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ArchiveEvent, EventMeta, EventsResponse, Subject } from '@st-vault/api-schema';
import { request } from '../../shared/lib/api';
import { eventPresentation } from './events';
import { formatDateTimePrecise } from '../timeline/timeline';
import { clockLabel, dayKey, dayLabel } from '../../shared/lib/date-label';
import { useSyncRefresh, syncReadFailure, type SyncReadResult } from '../../shared/lib/sync';
import { CoverImage } from '../directory/CoverImage';
import { Icon } from '../../design/Icon';
import { PanelFeedback } from '../../shared/ui/PanelContent';
import { OverflowText } from '../../shared/ui/OverflowText';

const noEvents: ArchiveEvent[] = [];

export function HistorySubject({
  id,
  name,
  revision,
  onReveal,
}: {
  id: string;
  name: string;
  revision: number;
  onReveal?: () => void;
}): JSX.Element {
  const content = (
    <>
      <CoverImage id={id} revision={revision} status="avatar" variant="avatar" />
      <strong>
        <OverflowText text={name} />
      </strong>
    </>
  );
  return onReveal ? (
    <button
      type="button"
      className="history-subject"
      aria-label={tr('在列表中定位 {{v0}}', { v0: name })}
      onClick={onReveal}
    >
      {content}
    </button>
  ) : (
    <span className="history-subject">{content}</span>
  );
}

export function HistoryPanel({
  active,
  meta,
  onMeta,
  subjects = [],
  onReveal,
}: {
  active: boolean;
  meta: EventMeta | null;
  onMeta: (meta: EventMeta) => void;
  subjects?: Subject[];
  onReveal: (id: string) => void;
}): JSX.Element {
  const [pageItems, setItems] = useState<ArchiveEvent[] | null>(null),
    [error, setError] = useState(''),
    [older, setOlder] = useState(false);
  const items = pageItems ?? noEvents;
  const [viewport, setViewport] = useState({ top: 0, height: 480 });
  const [metrics, setMetrics] = useState({ row: 30, day: 30, older: 32 });
  const root = useRef<HTMLDivElement>(null),
    tail = useRef(0),
    first = useRef(0),
    following = useRef(true),
    observedTop = useRef(0),
    acknowledged = useRef(meta?.readCursor ?? 0),
    requestedRead = useRef(0);
  const callback = useRef(onMeta);
  callback.current = onMeta;
  const readCursor = meta?.readCursor ?? 0;
  const openedReadCursor = useRef(meta?.readCursor);
  const [imageRevision, setImageRevision] = useState(0);
  useSyncRefresh(
    ['subjects'],
    () => {
      setImageRevision((value) => value + 1);
      return Promise.resolve();
    },
    active,
    '',
    { onClock: true },
  );
  const olderRequest = useRef<AbortController | null>(null);
  const olderAnchor = useRef<number | null>(null);
  const manualRequest = useRef<AbortController | null>(null);
  const readRequest = useRef<AbortController | null>(null);
  const hasOlder = (meta?.oldestCursor ?? 0) < (items[0]?.id ?? 0);
  const offsets = useMemo(() => {
    const values = [0];
    for (let index = 0; index < items.length; index++) {
      const startsDay = index === 0 || dayKey(items[index].atMs) !== dayKey(items[index - 1].atMs);
      values.push(values[index] + metrics.row + (startsDay ? metrics.day : 0));
    }
    return values;
  }, [items, metrics]);
  const visibleTop = Math.max(0, viewport.top - (hasOlder ? metrics.older : 0));
  const visibleStart = Math.max(
    0,
    offsets.findIndex((_, index) => index < items.length && offsets[index + 1] > visibleTop),
  );
  const start = Math.max(0, visibleStart - 4);
  let end = start;
  while (end < items.length && offsets[end] < visibleTop + viewport.height + 360) end++;
  const readViewport = useCallback((element: HTMLDivElement): void => {
    const top = element.scrollTop,
      height = element.clientHeight;
    observedTop.current = top;
    setViewport((current) =>
      current.top === top && current.height === height ? current : { top, height },
    );
  }, []);
  const syncViewport = useCallback((): void => {
    const element = root.current;
    if (!element) return;
    if (following.current) element.scrollTop = element.scrollHeight;
    readViewport(element);
  }, [readViewport]);
  useLayoutEffect(() => {
    const element = root.current;
    if (!active || !element) return;
    // Opening can reuse the same DOM while the previous exit animation is playing.
    following.current = true;
    // Fixed row metrics serve both the rendered rows and their virtual spacers.
    const style = getComputedStyle(element);
    setMetrics({
      row: parseFloat(style.getPropertyValue('--menu-row-height')) || 30,
      day: parseFloat(style.getPropertyValue('--history-day-height')) || 30,
      older: parseFloat(style.getPropertyValue('--history-older-height')) || 32,
    });
    const observer = new ResizeObserver(syncViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, [active, syncViewport]);
  useLayoutEffect(() => {
    if (!active) return;
    if (root.current && olderAnchor.current !== null) {
      const index = items.findIndex((item) => item.id === olderAnchor.current);
      olderAnchor.current = null;
      if (!following.current && index > 0) {
        // Keep the previous first event's text in place even when the 500-row
        // limit evicts an equal number of rows from the other end of the window.
        const sameDay = dayKey(items[index].atMs) === dayKey(items[index - 1].atMs);
        root.current.scrollTop +=
          offsets[index] - (sameDay ? metrics.day : 0) - (hasOlder ? 0 : metrics.older);
      }
    }
    syncViewport();
  }, [active, items, offsets, hasOlder, metrics, syncViewport]);
  useEffect(
    () => () => {
      olderRequest.current?.abort();
      manualRequest.current?.abort();
      readRequest.current?.abort();
    },
    [active],
  );
  const ack = useCallback(async (cursor: number, signal?: AbortSignal): Promise<void> => {
    if (cursor <= acknowledged.current || document.visibilityState !== 'visible') return;
    requestedRead.current = Math.max(requestedRead.current, cursor);
    if (readRequest.current) return;
    const controller = new AbortController(),
      cancel = (): void => controller.abort();
    readRequest.current = controller;
    signal?.addEventListener('abort', cancel, { once: true });
    const deadline = window.setTimeout(cancel, 15000);
    try {
      while (
        requestedRead.current > acknowledged.current &&
        document.visibilityState === 'visible'
      ) {
        const requested = requestedRead.current;
        const saved = await request<EventMeta>('/api/events/read', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cursor: requested }),
          signal: controller.signal,
        });
        acknowledged.current = saved.readCursor;
        callback.current(saved);
        if (saved.readCursor < requested) break;
      }
    } catch {
      if (!controller.signal.aborted) setError(tr('已读状态暂未保存。'));
    } finally {
      window.clearTimeout(deadline);
      signal?.removeEventListener('abort', cancel);
      if (readRequest.current === controller) readRequest.current = null;
    }
  }, []);
  useEffect(() => {
    if (!active || !following.current) return;
    const frame = requestAnimationFrame(() => {
      const element = root.current;
      if (
        element &&
        following.current &&
        element.scrollHeight - element.scrollTop - element.clientHeight < 24
      )
        void ack(items.at(-1)?.id ?? 0);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, items, ack]);
  const refresh = useCallback(async (signal: AbortSignal): Promise<SyncReadResult> => {
    try {
      let cursor = tail.current;
      let latest: number | undefined;
      do {
        const after = cursor;
        const data = await request<EventsResponse>(
          `/api/events?${after ? `after=${after}` : `before=${Number.MAX_SAFE_INTEGER}`}&limit=100`,
          { signal },
        );
        if (signal.aborted) return;
        latest ??= data.meta.latestCursor;
        openedReadCursor.current ??= data.meta.readCursor;
        callback.current(data.meta);
        setError('');
        setItems((previous) => {
          const retained = (previous ?? noEvents).filter(
            (event) => event.id >= data.meta.oldestCursor,
          );
          // Older paging can move the bounded window while a forward request is in flight.
          if (after && retained.length && retained.at(-1)!.id < after) return previous;
          if (data.items.length && data.items.at(-1)!.id < (retained[0]?.id ?? 0)) return previous;
          const all = [
            ...new Map([...retained, ...data.items].map((event) => [event.id, event])).values(),
          ].sort((a, b) => a.id - b.id);
          const merged = following.current ? all.slice(-500) : all.slice(0, 500);
          first.current = merged[0]?.id ?? 0;
          tail.current = merged.at(-1)?.id ?? 0;
          return merged;
        });
        if (!after || !data.hasMore || !following.current || data.nextCursor <= after) return;
        cursor = data.nextCursor;
      } while (cursor < latest);
    } catch (cause) {
      const result = syncReadFailure(cause, signal);
      if (!signal.aborted || result.status === 'retry') setError(tr('历史事件暂不可用。'));
      return result;
    }
  }, []);
  useSyncRefresh(['events'], refresh, active);
  async function loadOlder(): Promise<void> {
    if (older || !hasOlder || !first.current || olderRequest.current) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    setOlder(true);
    const before = first.current;
    try {
      const data = await request<EventsResponse>(`/api/events?before=${before}&limit=100`, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setItems((previous) => {
        if (!previous || following.current || previous[0]?.id !== before) return previous;
        const merged = [
          ...new Map([...data.items, ...previous].map((event) => [event.id, event])).values(),
        ]
          .sort((a, b) => a.id - b.id)
          .slice(0, 500);
        if (merged[0]?.id !== before) olderAnchor.current = before;
        first.current = merged[0]?.id ?? 0;
        tail.current = merged.at(-1)?.id ?? 0;
        return merged;
      });
      callback.current(data.meta);
    } catch {
      if (!controller.signal.aborted) setError(tr('较早事件暂不可用。'));
    } finally {
      if (olderRequest.current === controller) olderRequest.current = null;
      setOlder(false);
    }
  }
  return (
    <section className="history-panel">
      <div
        ref={root}
        className="event-feed"
        role="log"
        aria-live="polite"
        aria-busy={pageItems === null && !error}
        aria-label={tr('历史事件')}
        onScroll={(event) => {
          const element = event.currentTarget;
          // Scroll events from layout corrections must not change the user's follow mode.
          if (!active || element.scrollTop === observedTop.current) return;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          readViewport(element);
          if (element.scrollTop < 24) void loadOlder();
          if (following.current) {
            if (end === items.length) void ack(tail.current);
            if (meta && meta.latestCursor > tail.current && !manualRequest.current) {
              const controller = new AbortController();
              manualRequest.current = controller;
              void refresh(controller.signal).finally(() => {
                if (manualRequest.current === controller) manualRequest.current = null;
              });
            }
          }
        }}
      >
        {hasOlder && (
          <p className="event-older">{older ? tr('读取更早事件…') : tr('向上滚动查看更早事件')}</p>
        )}
        {!items.length && !error && (
          <p className="empty-mini">{tr(pageItems === null ? '读取中…' : '暂无历史事件')}</p>
        )}
        <div aria-hidden="true" style={{ height: offsets[start] }} />
        {items.slice(start, end).map((event, localIndex) => {
          const view = eventPresentation(event);
          if (event.kind === 'status_changed') {
            const profile = subjects.find((row) => row.id === event.subjectId);
            if (profile) view.name = profile.handle;
          }
          const index = start + localIndex,
            startsDay = index === 0 || dayKey(event.atMs) !== dayKey(items[index - 1].atMs);
          return (
            <article
              key={event.id}
              className={`history-event event-${view.color}${event.id > (openedReadCursor.current ?? readCursor) ? ' unread' : ''}`}
              data-event-id={event.id}
            >
              {startsDay && (
                <div className="history-day">
                  <span>{dayLabel(event.atMs)}</span>
                </div>
              )}
              <div className="history-event-line">
                <time
                  dateTime={new Date(event.atMs).toISOString()}
                  title={tr('观测时间 {{v0}}', { v0: formatDateTimePrecise(event.occurredAtMs) })}
                >
                  {clockLabel(event.atMs)}
                </time>
                {event.kind === 'status_changed' ? (
                  <HistorySubject
                    id={event.subjectId}
                    revision={imageRevision}
                    name={view.name}
                    onReveal={
                      subjects.some((subject) => subject.id === event.subjectId)
                        ? () => onReveal(event.subjectId)
                        : undefined
                    }
                  />
                ) : (
                  <>
                    <span className="history-program-icon">
                      <Icon name="settings" />
                    </span>
                    <strong>
                      <OverflowText text={view.name} />
                    </strong>
                  </>
                )}
                <span className="event-description">
                  <OverflowText text={view.text} />
                </span>
              </div>
            </article>
          );
        })}
        <div aria-hidden="true" style={{ height: offsets[items.length] - offsets[end] }} />
      </div>
      {error && <PanelFeedback kind="error">{error}</PanelFeedback>}
    </section>
  );
}
