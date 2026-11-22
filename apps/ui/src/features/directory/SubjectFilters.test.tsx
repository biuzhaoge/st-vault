import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SubjectFilters } from './SubjectFilters';

it('shows only three groups, hides zero counts and preserves the active group', () => {
  const html = renderToStaticMarkup(
    <SubjectFilters
      statusFilter="OFFLINE"
      setStatusFilter={() => undefined}
      counts={{ ONLINE: 12, OFFLINE: 3, ARCHIVED: 0 }}
    />,
  );
  expect(html.match(/<button /g) ?? []).toHaveLength(3);
  expect(html).toContain(
    '<span class="filter-label-compact">在线</span><span class="filter-count">12</span>',
  );
  expect(html).toContain(
    '<span class="filter-label-compact">离线</span><span class="filter-count">3</span>',
  );
  expect(html).toContain('<span class="filter-label-compact">归档</span></button>');
  expect(html).toContain('class="active" aria-pressed="true" aria-label="离线"');
  expect(html).not.toContain('全部');
});
