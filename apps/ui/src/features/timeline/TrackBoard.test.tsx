import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { Subject } from '@st-vault/api-schema';
import type * as React from 'react';
import { SUBJECT_ROW_HEIGHT } from '../directory/virtual-list';
import { TrackBoard } from './TrackBoard';

// Layout effects require a browser; these tests verify the scroll ownership and row origin.
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useLayoutEffect: () => undefined,
}));
const noop = (): void => undefined;
const subjects: Subject[] = Array.from({ length: 40 }, (_, index) => ({
  id: `stripchat:${index}`,
  providerId: index,
  handle: `subject${index}`,
  monitorEnabled: true,
  autoRecord: true,
  captureState: 'CAPTURING',
  providerStatus: 'PUBLIC',
  observedAtMs: null,
}));
function render(selectedId: string | null = subjects[0].id, directory = subjects): string {
  return renderToStaticMarkup(
    <TrackBoard
      subjects={directory}
      selectedId={selectedId}
      fromMs={1000}
      toMs={2000}
      selection={{ fromMs: 1200, toMs: 1600 }}
      timelineStartMs={0}
      nowMs={2000}
      account={<button>account</button>}
      filters={<div>filters</div>}
      onChoose={noop}
      onRangeChoose={() => Promise.resolve(null)}
      onAnchor={noop}
      onViewChange={noop}
      onMove={noop}
      onRecordingChange={() => Promise.resolve()}
    />,
  );
}

it('keeps the header outside the native row scroller so its scrollbar begins below the header', () => {
  const html = render(),
    scroller = html.slice(html.indexOf('class="track-table-scroll"'));
  expect(html.indexOf('class="arrangement-controls"')).toBeLessThan(
    html.indexOf('class="track-table-scroll"'),
  );
  expect(scroller).not.toContain('class="arrangement-controls"');
  expect(html).toContain('<div class="directory"><button>account</button></div>');
  expect(html).toContain('<div class="time-control-strip"><div>filters</div>');
  expect(scroller).toContain('class="track-row selected"');
});
it('shows the selected subject range without a fixed-selection flag and hides it on disconnect', () => {
  expect(render()).toContain('data-selected-subject="stripchat:0"');
  const empty = render(null);
  expect(empty).toContain('data-selected-subject=""');
  expect(empty).toMatch(/aria-label="取画面选区"[^>]*aria-hidden="true"/);
});

it('positions selection and grid at the row viewport origin while preserving shared virtual rows', () => {
  const html = render(subjects[2].id);
  expect(html).toContain(
    '<div class="track-table"><div class="timeline-grid-anchor" aria-hidden="true"><div class="timeline-grid">',
  );
  expect(html).toMatch(
    new RegExp(
      `class="range-selection"[^>]*style="top:${2 * SUBJECT_ROW_HEIGHT}px;height:${SUBJECT_ROW_HEIGHT}px`,
    ),
  );
  expect(html.match(/class="track-row(?: selected)?"/g)).toHaveLength(14);
});

it('puts a one-based visual number before the cover in each mounted row', () => {
  const html = render();
  const numbers = [
    ...html.matchAll(
      /class="directory-row-number" aria-hidden="true"><span[^>]*>(\d+)<\/span><\/span>/g,
    ),
  ];
  expect(numbers.map(([, value]) => Number(value))).toEqual(
    subjects.slice(0, 14).map((_, index) => index + 1),
  );
});

it('uses the number itself as the only recording switch in each available row', () => {
  const html = render();
  expect(html).toContain('track-label status-cell-public');
  const columns = [...html.matchAll(/<div class="directory-row-index"[^>]*>(.*?)<\/div>/g)];
  expect(columns).toHaveLength(html.match(/class="track-row(?: selected)?"/g)!.length);
  for (const [, column] of columns) {
    expect(column).toMatch(
      /<button[^>]+role="switch"[^>]+class="recording-toggle record-button is-recording"[^>]*><span class="directory-row-number".*<\/button>/,
    );
  }
  expect(html.match(/class="recording-toggle record-button/g)).toHaveLength(columns.length);
  expect(html).toContain('class="subject-name"');
  expect(html).not.toContain('subject-name status-');
});

it('shows the same number without an interactive recording switch for archived rows', () => {
  const html = render(null, [{ ...subjects[0], archived: true }]);
  expect(html).toContain('class="directory-row-number"');
  expect(html).not.toContain('class="recording-toggle record-button');
});

it('shows only the current name on the cover and keeps the tooltip free of former names', () => {
  const subject = { ...subjects[0], formerNames: ['Earlier display name'] };
  const html = render(subject.id, [subject]);
  expect(html).toContain(`title="${subject.handle} · ${subject.id}"`);
  expect(html).toContain(`<strong class="subject-name">${subject.handle}</strong>`);
  expect(html).not.toContain('Earlier display name');
});
