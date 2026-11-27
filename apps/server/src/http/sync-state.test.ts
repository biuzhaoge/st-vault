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

function stateFor(subjects: Subject[], archiveReason?: (row: Subject) => Subject['archiveReason']) {
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
    archiveReasons: archiveReason && { snapshot: () => archiveReason },
    keyCount: () => 0,
  });
  return { read: state.read, revisions };
}

it('refreshes the directory when an archive reason becomes known without modifying the timeline', async () => {
  const subjects = [{ ...subject(1), providerStatus: 'UNKNOWN' as const, archived: true }];
  const evidence: { reason?: Subject['archiveReason'] } = {};
  const { read } = stateFor(subjects, () => evidence.reason);
  const unconfirmed = await read();
  evidence.reason = 'region_restricted';
  const confirmed = await read();
  expect(confirmed.subjects).not.toBe(unconfirmed.subjects);
  expect(confirmed.timeline).toBe(unconfirmed.timeline);
});

it('will publish a stored unfollow even when a route observation still exists', async () => {
  const archived: Subject = { ...subject(1), providerStatus: 'UNKNOWN', archived: true };
  const { read } = stateFor([archived], () => 'region_restricted');
  const before = await read();
  archived.archiveReason = 'unfollowed';
  const after = await read();
  expect(after.subjects).not.toBe(before.subjects);
  expect(after.subjects).toContain('unfollowed');
  expect(after.timeline).toBe(before.timeline);
});

it('refreshes the directory and timeline when an unfollowed archive is purged', async () => {
  const archived: Subject = {
    ...subject(1),
    providerStatus: 'UNKNOWN',
    archived: true,
    archiveReason: 'unfollowed',
  };
  const subjects = [subject(2), archived];
  const { read } = stateFor(subjects);
  const before = await read();
  subjects.pop();
  const after = await read();
  expect(after.subjects).not.toBe(before.subjects);
  expect(after.timeline).not.toBe(before.timeline);
  expect(after.timelineSubjectIds).toBeUndefined();
});

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
