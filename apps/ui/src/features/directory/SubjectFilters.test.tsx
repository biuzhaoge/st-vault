import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { SubjectFilters } from './SubjectFilters';

it('renders independent states for multiple selected filters and hides zero counts', () => {
  const html = renderToStaticMarkup(
    <SubjectFilters
      filters={['ONLINE', 'OFFLINE']}
      onToggle={() => undefined}
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
  expect(html).toContain('aria-pressed="true" aria-label="在线"');
  expect(html).toContain('aria-pressed="true" aria-label="离线"');
  expect(html).toContain('aria-pressed="false" aria-label="归档"');
  expect(html).not.toContain('role="status"');
  expect(html).not.toContain('<svg');
  expect(html).not.toContain('全部');
});

it('renders all three filters off when none is selected', () => {
  const html = renderToStaticMarkup(
    <SubjectFilters
      filters={[]}
      onToggle={() => undefined}
      counts={{ ONLINE: 1, OFFLINE: 0, ARCHIVED: 1 }}
    />,
  );
  expect(html.match(/aria-pressed="false"/g) ?? []).toHaveLength(3);
  expect(html).not.toContain('role="status"');
});
