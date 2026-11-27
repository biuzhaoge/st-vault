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
  help?: (note?: string) => ReactNode;
}): JSX.Element {
  const kind =
    health?.kind === 'ok' ? 'ok' : !health || health.kind === 'checking' ? 'checking' : 'error';
  const note = kind === 'error' && health ? health.messages.join(' · ') || health.title : undefined;
  return (
    <PanelStatus
      className="archive-health"
      label={
        <>
          {tr('归档服务')}
          {help?.(note)}
        </>
      }
      kind={kind}
      value={tr(kind === 'ok' ? '可用' : kind === 'checking' ? '检查中' : '异常')}
      note={note}
      accessory={accessory}
    />
  );
}
