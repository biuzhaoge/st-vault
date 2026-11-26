import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { RecordingMode, GlobalRecordingSettings } from './RecordingMode';
const save = () => Promise.resolve();
it('uses the row number as the policy switch with complete accessible state descriptions', () => {
  const render = (value: boolean, captureState: 'IDLE' | 'CAPTURING' | 'RESOLVING') =>
    renderToStaticMarkup(
      <RecordingMode
        value={value}
        captureState={captureState}
        rowNumber={123}
        label="record"
        onChange={save}
      />,
    );
  for (const captureState of ['IDLE', 'RESOLVING', 'CAPTURING'] as const) {
    for (const value of [false, true]) {
      const html = render(value, captureState);
      expect(html).not.toContain('title=');
      expect(html).toContain(`aria-checked="${value}"`);
      expect(html).toContain(value ? '自动录制已开启' : '自动录制已关闭');
      const content = /<button[^>]*>([\s\S]*?)<\/button>/.exec(html)![1];
      expect(content).toContain('class="directory-row-number" aria-hidden="true"');
      expect(content.replace(/<[^>]*>/g, '').trim()).toBe('123');
      expect(content).toContain(
        value && captureState === 'RESOLVING' ? 'operation-spinner' : 'record-action',
      );
    }
  }
});
it('shows the persisted default rather than deriving it from individual policies', () => {
  const html = renderToStaticMarkup(<GlobalRecordingSettings value={false} onChange={save} />);
  expect(html).toContain('aria-checked="false"');
  expect(html).not.toContain('is-mixed');
  expect(html).not.toContain('部分开启');
  expect(renderToStaticMarkup(<GlobalRecordingSettings value={true} onChange={save} />)).toContain(
    'aria-checked="true"',
  );
});
it.each(['QUEUED', 'RESOLVING'] as const)(
  'shows progress while %s before capture is confirmed',
  (captureState) => {
    const html = renderToStaticMarkup(
      <RecordingMode
        value={true}
        rowNumber={1}
        label="record"
        captureState={captureState}
        onChange={save}
      />,
    );
    expect(html).toContain('operation-spinner');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('is-recording');
  },
);
it('reports confirmed capture separately from the auto-recording policy', () => {
  const render = (captureState: 'CAPTURING' | 'IDLE' | 'BACKOFF', value = true) =>
    renderToStaticMarkup(
      <RecordingMode
        value={value}
        rowNumber={1}
        providerStatus="PUBLIC"
        label="record"
        captureState={captureState}
        onChange={save}
      />,
    );
  expect(render('CAPTURING')).toContain('is-recording');
  expect(render('IDLE')).not.toContain('is-recording');
  expect(render('BACKOFF')).not.toContain('is-recording');
  expect(render('CAPTURING', false)).not.toContain('is-recording');
  expect(
    renderToStaticMarkup(<RecordingMode value={true} label="policy" onChange={save} />),
  ).toContain('is-recording');
});

it('allows choosing the default before any broadcaster has been imported', () => {
  expect(
    renderToStaticMarkup(<GlobalRecordingSettings value={false} onChange={save} />),
  ).not.toContain('disabled');
});
