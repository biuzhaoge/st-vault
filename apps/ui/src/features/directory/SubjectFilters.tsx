import type { SubjectFilter } from './subjects';
import { tr } from '../../shared/lib/i18n';

export function SubjectFilters({
  filters,
  onToggle,
  counts,
}: {
  filters: readonly SubjectFilter[];
  onToggle: (value: SubjectFilter) => void;
  counts: Record<SubjectFilter, number>;
}): JSX.Element {
  const options: { id: SubjectFilter; label: string; compact: string }[] = [
    { id: 'ONLINE', label: tr('在线'), compact: tr('在线', { context: 'compact' }) },
    { id: 'OFFLINE', label: tr('离线'), compact: tr('离线', { context: 'compact' }) },
    { id: 'ARCHIVED', label: tr('归档'), compact: tr('归档', { context: 'compact' }) },
  ];
  return (
    <div className="subject-filters" role="group" aria-label={tr('主播状态筛选')}>
      {options.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={filters.includes(item.id)}
          aria-label={item.label}
          title={
            item.id === 'ARCHIVED'
              ? tr(
                  '归档包含已取关、断开账户或不在当前完整关注清单中的本地主播。已有录像仍可浏览，不再录制；临时网络或状态异常不会直接归档。',
                )
              : item.label
          }
          onClick={() => onToggle(item.id)}
        >
          <span className="filter-label">{item.id === 'ARCHIVED' ? item.compact : item.label}</span>
          <span className="filter-label-compact">{item.compact}</span>
          {counts[item.id] > 0 && <span className="filter-count">{counts[item.id]}</span>}
        </button>
      ))}
    </div>
  );
}
