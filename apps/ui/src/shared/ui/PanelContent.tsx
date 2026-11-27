import type { ReactNode } from 'react';
import { ProgressRing } from './ProgressRing';

export function PanelField({
  label,
  stacked = false,
  hint,
  children,
}: {
  label: string;
  stacked?: boolean;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className={`field${stacked ? ' is-stacked' : ''}`}>
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

export function PanelBadge({
  children,
  tone = 'neutral',
  live = false,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'error' | 'warning' | 'busy';
  live?: boolean;
}): JSX.Element {
  return (
    <span className={`panel-badge is-${tone}`} role={live ? 'status' : undefined}>
      {children}
    </span>
  );
}

export function PanelIdentity({
  icon,
  label,
  value,
  accessory,
}: {
  icon: ReactNode;
  label: ReactNode;
  value: ReactNode;
  accessory?: ReactNode;
}): JSX.Element {
  return (
    <div className="panel-identity">
      <span className="panel-identity-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="panel-identity-content">
        <span className="panel-identity-label">{label}</span>
        <strong>{value}</strong>
      </div>
      {accessory}
    </div>
  );
}

export function PanelSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="panel-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function PanelFeedback({
  children,
  kind = 'info',
}: {
  children: ReactNode;
  kind?: 'info' | 'busy' | 'success' | 'error';
}): JSX.Element {
  return (
    <div className={`panel-feedback is-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {kind === 'busy' && <ProgressRing />}
      <span>{children}</span>
    </div>
  );
}

/** Label/value status rows share the same hierarchy as the panel's facts. */
export function PanelStatus({
  label,
  value,
  kind,
  accessory,
  note,
  className = '',
  rowId,
  live = true,
}: {
  label: ReactNode;
  value: ReactNode;
  kind: 'ok' | 'checking' | 'error' | 'neutral' | 'warning' | 'busy';
  accessory?: ReactNode;
  note?: string;
  className?: string;
  rowId?: string;
  live?: boolean;
}): JSX.Element {
  const tone = kind === 'ok' ? 'success' : kind === 'checking' ? 'neutral' : kind;
  return (
    <div
      className={`panel-status ${className} is-${kind}`}
      data-status-row={rowId}
      role={live ? 'status' : undefined}
    >
      <div className="panel-row panel-status-row">
        <span className="panel-row-label">{label}</span>
        {note && (
          <span className="system-row-note" title={note}>
            {note}
          </span>
        )}
        <span className="panel-row-value">
          <PanelBadge tone={tone}>
            {kind === 'busy' && <ProgressRing />}
            {value}
          </PanelBadge>
          {accessory}
        </span>
      </div>
    </div>
  );
}
