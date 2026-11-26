import { Icon } from '../../design/Icon';
import { tr } from '../../shared/lib/i18n';
import { OverflowText } from '../../shared/ui/OverflowText';
import { ProgressRing } from '../../shared/ui/ProgressRing';
import { SnapshotToolbarSurface } from './SnapshotToolbarSurface';

export interface SnapshotToolbarProps {
  total: number;
  pageIndex: number;
  pages: number;
  live: boolean;
  connected: boolean;
  busy: boolean;
  status?: string;
  onPrevious: () => void;
  onNext: () => void;
  onUnlike: () => void;
  onDelete: () => void;
  selection?: {
    count: number;
    onClear?: () => void;
  };
}

export function SnapshotToolbar(props: SnapshotToolbarProps): JSX.Element {
  const selection = props.selection;
  const paginated = !selection && !props.live && props.pages > 1 && props.pageIndex >= 0;
  const status = props.status;
  return (
    <SnapshotToolbarSurface selecting={!!selection} busy={props.busy} label={tr('截图工具')}>
      <span
        className="snapshot-total"
        style={{
          minWidth: `max(36px, ${selection ? String(selection.count).length + 5 : String(props.total).length + 3}ch)`,
        }}
        title={selection ? undefined : tr('{{v0}} 张', { v0: props.total })}
      >
        {selection
          ? tr('已选 {{v0}} 项', { v0: selection.count })
          : tr('{{v0}} 张', { v0: props.total, context: 'compact' })}
      </span>
      {paginated && (
        <button
          className="snapshot-page-button is-previous"
          aria-label={tr('上一页')}
          disabled={props.pageIndex === 0}
          onClick={props.onPrevious}
        >
          <Icon name="chevron-left" />
        </button>
      )}
      {paginated && (
        <output
          aria-label={tr('截图页码')}
          style={{ minWidth: `${2 * String(props.pages).length + 3}ch` }}
        >
          {props.pageIndex + 1} / {props.pages}
        </output>
      )}
      {paginated && (
        <button
          className="snapshot-page-button is-next"
          aria-label={tr('下一页')}
          disabled={props.pageIndex === props.pages - 1}
          onClick={props.onNext}
        >
          <Icon name="chevron-left" />
        </button>
      )}
      {(!selection || selection.onClear) && (
        <div className="snapshot-actions">
          {selection ? (
            <button aria-label={tr('清除选择')} onClick={selection.onClear}>
              <Icon name="close" />
              <span>{tr('清除选择')}</span>
            </button>
          ) : (
            (
              [
                ['取消所有喜欢', 'heart-off', props.onUnlike],
                ['删除所有非喜欢', 'trash', props.onDelete],
              ] as const
            ).map(([label, icon, onClick]) => (
              <button
                key={label}
                aria-label={tr(label)}
                disabled={props.busy || !props.connected || !props.total}
                onClick={onClick}
              >
                <Icon name={icon} />
                <span>{tr(label, { context: 'compact' })}</span>
              </button>
            ))
          )}
        </div>
      )}
      {(props.busy || status) && (
        <span
          className="snapshot-operation-status"
          role="status"
          aria-label={props.busy && !status ? tr('处理中…') : undefined}
        >
          {props.busy && <ProgressRing />}
          {status && <OverflowText text={status} tooltip={false} />}
        </span>
      )}
    </SnapshotToolbarSurface>
  );
}
