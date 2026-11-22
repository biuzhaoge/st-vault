export const syncTopics = [
  'seen',
  'subjects',
  'timeline',
  'events',
  'account',
  'keys',
  'system',
  'personal',
  'playback',
] as const;

export type SyncTopic = (typeof syncTopics)[number];
export const maxTimelineSubjectIds = 64;

export interface SyncChange {
  topics: SyncTopic[];
  /** Applies to the timeline topic only. An omitted scope invalidates the entire topic. */
  timelineSubjectIds?: readonly string[];
}
