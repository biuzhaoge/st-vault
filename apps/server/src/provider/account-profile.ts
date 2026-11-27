import type { SubjectInput } from '../ports.js';
import { ProviderError } from './http.js';
import { coverSource } from './cover-source.js';

export interface ImportedAccountProfile {
  username: string;
  followingCount: number;
  avatarSourceUrl: string | null;
}
export interface ImportedAccount {
  subjects: SubjectInput[];
  profile: ImportedAccountProfile;
  unverifiedMissingCount?: number;
  recoveredArchivedCount?: number;
  indexCount?: number;
  verifiedFollowingCount?: number;
  unresolvedProfileCount?: number;
}
export function accountAvatarSource(value: unknown): string | null {
  return coverSource(value);
}

export function validId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function checkedName(value: unknown, maxLength: number): string | null {
  return typeof value === 'string' &&
    value.trim() &&
    value.length <= maxLength &&
    !/[\x00-\x1f\x7f]/.test(value)
    ? value.trim()
    : null;
}

export function directoryHandle(value: unknown): string | null {
  return checkedName(value, 200);
}

export function accountProfile(value: unknown): Omit<ImportedAccountProfile, 'followingCount'> & {
  userId: number;
} {
  if (!value || typeof value !== 'object' || !('username' in value))
    throw new ProviderError('account-session-unavailable');
  const username = checkedName(value.username, 256);
  const userId = 'id' in value ? value.id : undefined;
  if (!username || !validId(userId)) throw new ProviderError('account-session-unavailable');
  return {
    username,
    userId,
    avatarSourceUrl: accountAvatarSource('avatarUrl' in value ? value.avatarUrl : null),
  };
}
