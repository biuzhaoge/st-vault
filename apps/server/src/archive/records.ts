import type { Segment } from '@st-vault/api-schema';
import type { SubjectInput } from '../ports.js';

export interface ObjectRecord {
  id: string;
  subjectId: string;
  filename: string;
  bytes: number;
  hash: string;
  kind: 'init' | 'fragment';
}
interface BaseRecord {
  version: 1;
  revision: number;
  subject: SubjectInput;
}
export type JournalRecord = BaseRecord &
  (
    | { kind: 'commit'; segment: Segment; objects: ObjectRecord[] }
    | { kind: 'delete'; segmentIds: string[] }
  );
export type ArchiveFaultPoint =
  | 'after-object-rename'
  | 'after-journal-sync'
  | 'after-index-commit'
  | 'after-tombstone-sync'
  | 'after-tombstone-commit'
  | 'after-unlink'
  | 'before-object-write'
  | 'before-journal-write'
  | 'before-unlink'
  | 'before-deletion-prepare'
  | 'before-orphan-batch';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const MAX_BYTES = 16 * 1024 * 1024;

export function subjectId(id: string): number {
  if (!/^stripchat:[1-9]\d*$/.test(id)) throw new Error('INVALID_SUBJECT_ID');
  const value = Number(id.slice(10));
  if (!Number.isSafeInteger(value)) throw new Error('INVALID_SUBJECT_ID');
  return value;
}
