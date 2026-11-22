import { maxTimelineSubjectIds, type Subject } from '@st-vault/api-schema';
import type { AccountSyncPort, ArchivePort, MediaChange, SupervisorPort } from '../ports.js';
import type { ResourceMonitor } from '../runtime/resources.js';
import type { SettingsStore } from '../runtime/settings.js';
import type { SyncSnapshot } from './sync.js';

interface Options {
  archive: Pick<ArchivePort, 'listSubjects' | 'syncRevisions'>;
  supervisor: Pick<SupervisorPort, 'states'>;
  accountSync: Pick<AccountSyncPort, 'status'>;
  resources?: Pick<ResourceMonitor, 'get'>;
  settings?: Pick<SettingsStore, 'get'>;
  keyCount: () => number;
}

type Observation = Pick<Subject, 'observedAtMs' | 'providerStatus'>;
type Observations = Map<string, Observation>;

function renewedSubjects(before: Observations, after: Observations): string[] | undefined {
  if (before.size !== after.size) return;
  const ids: string[] = [];
  for (const [id, current] of after) {
    const previous = before.get(id);
    if (previous?.providerStatus !== current.providerStatus) return;
    if (previous.observedAtMs !== current.observedAtMs) ids.push(id);
    if (ids.length > maxTimelineSubjectIds) return;
  }
  return ids.length ? ids : undefined;
}

/** Combine read-side revisions with a scope for routine observation renewals. */
export function createSyncState(options: Options) {
  let previous: { media: number; observations: Observations } | undefined;
  let onlineSubjects = new Set<string>();
  return {
    read: async (): Promise<SyncSnapshot> => {
      const [subjects, revisions] = await Promise.all([
        options.archive.listSubjects({ activity: false }),
        options.archive.syncRevisions(),
      ]);
      const states = options.supervisor.states();
      const account = options.accountSync.status();
      const observations = new Map(
        subjects.map(({ id, observedAtMs, providerStatus }) => [
          id,
          { observedAtMs, providerStatus },
        ]),
      );
      const timelineSubjectIds =
        previous?.media === revisions.media
          ? renewedSubjects(previous.observations, observations)
          : undefined;
      const snapshot = {
        subjects: JSON.stringify(
          subjects.map((subject) => [
            subject.id,
            subject.handle,
            subject.formerNames,
            subject.providerStatus,
            subject.monitorEnabled,
            subject.archived,
            subject.autoRecord,
            subject.lastKnownStatus,
            states[subject.id],
          ]),
        ),
        timeline: JSON.stringify([
          revisions.media,
          subjects.map(({ id, observedAtMs, providerStatus }) => [
            id,
            observedAtMs,
            providerStatus,
          ]),
        ]),
        events: String(revisions.events),
        personal: String(revisions.personal),
        playback: '',
        account: JSON.stringify(account),
        keys: String(options.keyCount()),
        system: JSON.stringify([
          options.resources?.get(),
          options.settings?.get(),
          states,
          account,
        ]),
        timelineSubjectIds,
      };
      previous = { media: revisions.media, observations };
      onlineSubjects = new Set(
        subjects
          .filter((subject) => subject.providerStatus === 'PUBLIC' && !subject.archived)
          .map((subject) => subject.id),
      );
      return snapshot;
    },
    affectsDirectory(change: MediaChange): boolean {
      // Online ordering is alphabetical. Other groups sort by recent media activity.
      return change.kind === 'delete' || !onlineSubjects.has(change.segment.subjectId);
    },
  };
}
