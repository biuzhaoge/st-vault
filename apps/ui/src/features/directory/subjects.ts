import { subjectDirectory, type PublicStatus, type Subject } from '@st-vault/api-schema';
const STATUS_ORDER: Record<PublicStatus, number> = {
  PUBLIC: 0,
  PRIVATE: 1,
  OFFLINE: 2,
  UNKNOWN: 3,
};
const NAME_ORDER = new Intl.Collator('zh-CN', { numeric: true });
const SUBJECT_FILTERS = ['ONLINE', 'OFFLINE', 'ARCHIVED'] as const;
export type SubjectFilter = (typeof SUBJECT_FILTERS)[number];
export type SubjectCounts = Record<SubjectFilter, number>;
export const DEFAULT_SUBJECT_FILTERS: readonly SubjectFilter[] = ['ONLINE'];
/** Keep unchanged rows stable across heartbeat JSON decoding; every field still participates. */
export function reconcileSubjects(previous: Subject[], incoming: Subject[]): Subject[] {
  const byId = new Map(previous.map((subject) => [subject.id, subject]));
  const rows = incoming.map((subject) => {
    const old = byId.get(subject.id);
    if (!old) return subject;
    const keys = new Set([...Object.keys(old), ...Object.keys(subject)] as (keyof Subject)[]);
    const equal = [...keys].every((key) => {
      if (key === 'directory') {
        const a = old.directory;
        const b = subject.directory;
        return (
          a?.group === b?.group && a?.orderStatus === b?.orderStatus && a?.pending === b?.pending
        );
      }
      const a = old[key];
      const b = subject[key];
      return (
        Object.is(a, b) ||
        (Array.isArray(a) &&
          Array.isArray(b) &&
          a.length === b.length &&
          a.every((value, index) => value === b[index]))
      );
    });
    return equal ? old : subject;
  });
  return rows.length === previous.length && rows.every((row, index) => row === previous[index])
    ? previous
    : rows;
}
export function normalizeSubjectFilters(value: unknown): readonly SubjectFilter[] {
  const values = Array.isArray(value) ? value : [value];
  const filters = SUBJECT_FILTERS.filter((filter) => values.includes(filter));
  return filters.length || values.length === 0 ? filters : DEFAULT_SUBJECT_FILTERS;
}
export function subjectGroup(subject: Subject): SubjectFilter {
  return subjectDirectory(subject).group;
}
export function subjectCounts(subjects: Subject[]): SubjectCounts {
  const counts: SubjectCounts = { ONLINE: 0, OFFLINE: 0, ARCHIVED: 0 };
  for (const subject of subjects) {
    const { group, orderStatus } = subjectDirectory(subject);
    if (group === 'ARCHIVED' || orderStatus !== 'UNKNOWN') counts[group]++;
  }
  return counts;
}
const timestamp = (value: number | null | undefined): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
const onlineStart = (subject: Subject): number =>
  timestamp(subject.onlineSinceMs) || timestamp(subject.lastOnlineAtMs);

export function visibleSubjects(subjects: Subject[], filters: readonly SubjectFilter[]): Subject[] {
  const groups: Record<SubjectFilter, { subject: Subject; status: PublicStatus }[]> = {
    ONLINE: [],
    OFFLINE: [],
    ARCHIVED: [],
  };
  for (const subject of subjects) {
    const { group, orderStatus } = subjectDirectory(subject);
    if (filters.includes(group)) groups[group].push({ subject, status: orderStatus });
  }
  return SUBJECT_FILTERS.flatMap((group) =>
    groups[group]
      .sort(({ subject: a, status: aStatus }, { subject: b, status: bStatus }) => {
        const firstStatusOrder =
          group === 'OFFLINE' ? Number(aStatus === 'UNKNOWN') - Number(bStatus === 'UNKNOWN') : 0;
        const groupOrder =
          group === 'ONLINE'
            ? STATUS_ORDER[aStatus] - STATUS_ORDER[bStatus] || onlineStart(b) - onlineStart(a)
            : firstStatusOrder ||
              timestamp(b.lastRecordedAtMs) - timestamp(a.lastRecordedAtMs) ||
              timestamp(b.lastOnlineAtMs) - timestamp(a.lastOnlineAtMs);
        return (
          groupOrder ||
          NAME_ORDER.compare(a.handle, b.handle) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        );
      })
      .map(({ subject }) => subject),
  );
}
