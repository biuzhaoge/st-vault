import { expect, it } from 'vitest';
import { maxTimelineSubjectIds, type Subject } from '@st-vault/api-schema';
import { createSyncState } from './sync-state.js';

function subject(id: number): Subject {
  return {
    id: `stripchat:${id}`,
    providerId: id,
    handle: `fixture-${id}`,
    monitorEnabled: true,
    autoRecord: false,
    providerStatus: 'PUBLIC',
    observedAtMs: 1000,
  };
}

function stateFor(subjects: Subject[]) {
  const revisions = { media: 1, events: 1, personal: 1 };
  const state = createSyncState({
    archive: {
      listSubjects: () => Promise.resolve(subjects),
      syncRevisions: () => Promise.resolve({ ...revisions }),
    },
    supervisor: { states: () => ({}) },
    accountSync: {
      status: () => ({
        connected: false,
        running: false,
        needsReconnect: false,
        lastAttemptMs: null,
        lastSuccessMs: null,
        nextAttemptMs: null,
        lastImportedCount: null,
        error: null,
      }),
    },
    keyCount: () => 0,
  });
  return { read: state.read, revisions };
}

it('scopes lease renewals and leaves media changes, roster changes and transitions broad', async () => {
  const subjects = [subject(1), subject(2)];
  const { read, revisions } = stateFor(subjects);
  const initial = await read();
  expect(initial.timelineSubjectIds).toBeUndefined();
  subjects[1].observedAtMs = 2000;
  const renewal = await read();
  expect(renewal.timelineSubjectIds).toEqual(['stripchat:2']);
  expect(renewal.subjects).toBe(initial.subjects);
  expect(renewal.timeline).not.toBe(initial.timeline);
  revisions.media++;
  subjects[0].observedAtMs = 3000;
  expect((await read()).timelineSubjectIds).toBeUndefined();
  subjects[1].providerStatus = 'PRIVATE';
  subjects[1].observedAtMs = 4000;
  expect((await read()).timelineSubjectIds).toBeUndefined();
  subjects[1] = subject(3);
  expect((await read()).timelineSubjectIds).toBeUndefined();
});

it('falls back to broad notifications when a scope exceeds the payload bound', async () => {
  const subjects = Array.from({ length: maxTimelineSubjectIds + 1 }, (_, index) =>
    subject(index + 1),
  );
  const { read } = stateFor(subjects);
  await read();
  for (const row of subjects) row.observedAtMs = 2000;
  expect((await read()).timelineSubjectIds).toBeUndefined();
});
