import { tr } from '../../shared/lib/i18n';
import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { calendarDivisions, rulerLabels, rulerTicks } from './ruler';
import { DAY_MS } from './range-control';
import { formatDateTime } from './timeline';
import { clockLabel, dayKey } from '../../shared/lib/date-label';
import { civilTime } from '../../shared/lib/time';
import { fullCalendar, type ArchiveCalendar } from './archive-calendar';
export const TimelineRuler = memo(function TimelineRuler({
  fromMs,
  toMs,
  labelInset = 0,
  overscanMs = 0,
  nowMs = Date.now(),
  calendar = fullCalendar,
}: {
  fromMs: number;
  toMs: number;
  labelInset?: number;
  overscanMs?: number;
  nowMs?: number;
  calendar?: ArchiveCalendar;
}): JSX.Element {
  useTranslation();
  const root = useRef<HTMLDivElement>(null),
    [width, setWidth] = useState(600);
  const scale = calendar.scale(fromMs, toMs);
  const wholeDay = calendar.visibleSpan(fromMs, toMs) >= DAY_MS;
  const divisions = calendarDivisions(fromMs, toMs, overscanMs, scale);
  const hourWidth = (width * 3600000) / Math.max(1, scale.duration);
  const step = [1, 2, 3, 6, 12, 24].find((hours) => hours * hourWidth >= 42) ?? 24;
  const ticks = wholeDay
    ? divisions
        .filter(
          (tick) =>
            (civilTime(tick.atMs) / 3600000) % step === 0 &&
            (tick.position < 0 ||
              tick.position > 1 ||
              (tick.position * width >= 22 + labelInset && tick.position * width <= width - 22)),
        )
        .map((tick) => ({ ...tick, label: clockLabel(tick.atMs).slice(0, 5) }))
    : rulerTicks(fromMs, toMs, width, labelInset, overscanMs, scale);
  const { dates, hours } = rulerLabels(fromMs, toMs, width, nowMs, ticks, overscanMs, scale);
  useEffect(() => {
    const node = root.current;
    if (!node) return;
    const observer = new ResizeObserver(() => setWidth(node.clientWidth));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="timeline-ruler" ref={root} aria-label={tr('时间刻度')}>
      <div className="timeline-scene">
        {dates.map((day) => (
          <time
            key={`day:${day.atMs}`}
            className="ruler-date"
            data-day={day.atMs}
            dateTime={dayKey(day.atMs)}
            title={day.title}
            aria-label={day.title}
            aria-hidden={day.position < 0 || day.position > 1}
            style={{ left: `${day.position * 100}%`, width: day.widthPx }}
          >
            <span className="ruler-date-label">{day.label}</span>
            {day.halfLabel && <span className="ruler-half-label">{day.halfLabel}</span>}
          </time>
        ))}
        {divisions.map((tick) => (
          <i
            key={`line:${tick.atMs}`}
            className={`ruler-division division-${tick.level}`}
            data-window-edge={
              tick.position === 0 ? 'start' : tick.position === 1 ? 'end' : undefined
            }
            style={{ left: `${tick.position * 100}%` }}
          />
        ))}
        {hours.map((tick) => (
          <time
            key={tick.atMs}
            className="ruler-hour"
            data-at={tick.atMs}
            aria-hidden={tick.position < 0 || tick.position > 1}
            aria-label={formatDateTime(tick.atMs)}
            style={{ left: `${tick.position * 100}%`, width: tick.widthPx }}
          >
            {tick.label}
          </time>
        ))}
      </div>
    </div>
  );
});
