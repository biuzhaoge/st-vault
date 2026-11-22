import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PanelBadge, PanelFeedback, PanelField, PanelSection } from './PanelContent';

it('gives grouped settings one consistent section heading level', () => {
  const html = renderToStaticMarkup(
    <PanelSection title="Group">
      <label>
        Field
        <input />
      </label>
    </PanelSection>,
  );
  expect(html).toContain('<h3>Group</h3>');
  expect(html).not.toContain('<h2');
});
it('uses the same labeled field and badge primitives across panels', () => {
  const html = renderToStaticMarkup(
    <>
      <PanelField label="Session" stacked hint="Enter the exported session.">
        <textarea />
      </PanelField>
      <PanelBadge tone="success" live>
        Available
      </PanelBadge>
    </>,
  );
  expect(html).toContain('<label class="field is-stacked"><span>Session</span>');
  expect(html).toContain('<small>Enter the exported session.</small>');
  expect(html).toContain('class="panel-badge is-success" role="status"');
});

it.each(['info', 'busy', 'success', 'error'] as const)(
  'announces %s feedback with appropriate semantics',
  (kind) => {
    const html = renderToStaticMarkup(
      <PanelFeedback kind={kind}>Operation progress</PanelFeedback>,
    );
    expect(html).toContain(`role="${kind === 'error' ? 'alert' : 'status'}"`);
    expect(html.includes('operation-spinner')).toBe(kind === 'busy');
  },
);
