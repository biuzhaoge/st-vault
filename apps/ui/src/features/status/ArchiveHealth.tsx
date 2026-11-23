import { tr } from '../../shared/lib/i18n';
import type { SystemHealth } from './display';
import { PanelStatus } from '../../shared/ui/PanelContent';
import type { ReactNode } from 'react';
export function ArchiveHealth({
  health,
  accessory,
  help,
}: {
  health: SystemHealth | null;
  accessory?: ReactNode;
  help?: ReactNode;
}): JSX.Element {
  const kind =
    health?.kind === 'ok' ? 'ok' : !health || health.kind === 'checking' ? 'checking' : 'error';
  const reasons =
    kind === 'error' && health ? (health.messages.length ? health.messages : [health.title]) : [];
  return (
    <PanelStatus
      className="archive-health"
      label={
        <>
          {tr('归档服务')}
          {help}
        </>
      }
      kind={kind}
      value={tr(kind === 'ok' ? '可用' : kind === 'checking' ? '检查中' : '异常')}
      accessory={accessory}
    >
      {reasons.length ? reasons.map((reason) => <p key={reason}>{reason}</p>) : undefined}
    </PanelStatus>
  );
}
