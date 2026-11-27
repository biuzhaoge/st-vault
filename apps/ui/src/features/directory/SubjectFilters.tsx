import type { SubjectCounts, SubjectFilter } from './subjects';
import { tr } from '../../shared/lib/i18n';

export function SubjectFilters({
  filters,
  onToggle,
  counts,
}: {
  filters: readonly SubjectFilter[];
  onToggle: (value: SubjectFilter) => void;
  counts: SubjectCounts;
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
                  '封禁或取关的主播有录像时归入归档。地区受限且无法观测状态、平台已删除或断开账户后保留的主播也会归档。',
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
