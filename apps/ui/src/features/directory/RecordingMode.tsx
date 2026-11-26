import { tr } from '../../shared/lib/i18n';
import { useRef, useState, type CSSProperties } from 'react';
import type { CaptureState, PublicStatus } from '@st-vault/api-schema';
import { messageFor } from '../../shared/lib/errors';
import { ProgressRing } from '../../shared/ui/ProgressRing';

export function DirectoryRowNumber({ number }: { number: number }): JSX.Element {
  return (
    <span className="directory-row-number" aria-hidden="true">
      <span style={{ '--row-number-digits': String(number).length } as CSSProperties}>
        {number}
      </span>
    </span>
  );
}

export function RecordingMode({
  value,
  label,
  disabled = false,
  rowNumber,
  onChange,
  captureState,
  providerStatus,
}: {
  value: boolean;
  label: string;
  disabled?: boolean;
  rowNumber?: number;
  onChange: (record: boolean) => Promise<void>;
  captureState?: CaptureState;
  providerStatus?: PublicStatus;
}): JSX.Element {
  const [pending, setPending] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const pointer = useRef<{ x: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const current = pending ?? value;
  const numbered = rowNumber !== undefined;
  const recording = numbered ? value && pending !== false && captureState === 'CAPTURING' : current;
  const starting =
    numbered &&
    !recording &&
    (pending === true ||
      (current === true && ['QUEUED', 'RESOLVING'].includes(captureState ?? '')));
  const busy = starting || pending !== null;
  const text =
    numbered && recording
      ? tr('录制中')
      : pending !== null
        ? numbered
          ? tr(pending ? '启动中' : '停止中')
          : tr('保存中')
        : numbered && current
          ? starting
            ? tr(captureState === 'QUEUED' ? '等待录制名额' : '启动中')
            : tr(
                captureState === 'BACKOFF'
                  ? '等待重试'
                  : providerStatus === 'PUBLIC'
                    ? '等待启动'
                    : '等待公开直播',
              )
          : current
            ? tr('已开启')
            : tr('已关闭');
  const description = numbered
    ? `${tr(current ? '自动录制已开启' : '自动录制已关闭')} · ${text}`
    : text;
  async function save(record: boolean): Promise<void> {
    if (lock.current || disabled || record === value) return;
    lock.current = true;
    setPending(record);
    setError('');
    try {
      await onChange(record);
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      lock.current = false;
      setPending(null);
    }
  }
  return (
    <span className={`recording-mode${numbered ? ' recording-number' : ''}`}>
      <button
        type="button"
        role="switch"
        className={`recording-toggle${numbered ? ' record-button' : ''}${recording ? ' is-recording' : ''}`}
        disabled={disabled || pending !== null}
        aria-checked={current === true}
        aria-busy={busy}
        aria-label={label}
        aria-description={error || description}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (numbered) return;
          if (event.button !== 0) return;
          pointer.current = { x: event.clientX, moved: false };
          dragged.current = false;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (pointer.current && Math.abs(event.clientX - pointer.current.x) >= 4)
            pointer.current.moved = true;
        }}
        onPointerUp={(event) => {
          if (pointer.current?.moved) {
            dragged.current = true;
            const box = event.currentTarget.getBoundingClientRect();
            void save(event.clientX >= box.left + box.width / 2);
          }
          pointer.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          pointer.current = null;
          dragged.current = true;
        }}
        onLostPointerCapture={() => {
          pointer.current = null;
        }}
        onClick={(event) => {
          event.stopPropagation();
          if (dragged.current) {
            dragged.current = false;
            return;
          }
          void save(!current);
        }}
        onKeyDown={(event) => {
          if (event.key === ' ' || event.key === 'Enter') dragged.current = false;
          if (
            ['ArrowLeft', 'ArrowDown', 'Home', 'ArrowRight', 'ArrowUp', 'End'].includes(event.key)
          ) {
            event.preventDefault();
            void save(['ArrowRight', 'ArrowUp', 'End'].includes(event.key));
          }
        }}
      >
        {numbered ? (
          <>
            <DirectoryRowNumber number={rowNumber} />
            {busy ? <ProgressRing /> : <span className="record-action" aria-hidden="true" />}
          </>
        ) : (
          <i />
        )}
      </button>
      {error && (
        <span className="mode-error" role="alert" aria-label={error}>
          !
        </span>
      )}
    </span>
  );
}

export function GlobalRecordingSettings({
  value,
  onChange,
}: {
  value: boolean;
  onChange: (record: boolean) => Promise<void>;
}): JSX.Element {
  return (
    <section className="global-recording-settings">
      <span>{tr('全部主播录制')}</span>
      <RecordingMode value={value} label={tr('全部主播是否录制')} onChange={onChange} />
    </section>
  );
}
