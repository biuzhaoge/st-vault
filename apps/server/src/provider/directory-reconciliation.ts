import type { SubjectInput } from '../ports.js';
import {
  readDirectoryProfiles,
  type DirectoryProfile,
  type ReadAccount,
} from './account-directory.js';
import type { ImportedAccount } from './account-profile.js';
import { readArchiveFlags, type ReadDisabledPage, type ReadRoomAccess } from './account-flags.js';

function profileRecord(id: number, incoming: DirectoryProfile | undefined, before?: SubjectInput) {
  const handle = incoming?.handle ?? before?.handle;
  const row: SubjectInput = {
    id: `stripchat:${id}`,
    providerId: id,
    handle: handle ?? `主播 #${id}`,
  };
  if (!incoming?.handle && (!handle || before?.subjectProfilePending))
    row.subjectProfilePending = true;
  if (incoming?.avatarSourceUrl) row.avatarSourceUrl = incoming.avatarSourceUrl;
  if (incoming?.previewSourceUrl) row.previewSourceUrl = incoming.previewSourceUrl;
  return row;
}

export async function reconcileDirectory(
  read: ReadAccount,
  indexed: ReadonlySet<number>,
  known: readonly SubjectInput[],
  archived: readonly SubjectInput[],
  rotation: { after: number | undefined; onAttempt: (id: number) => void },
  roomPages: { readDisabled: ReadDisabledPage; readAccess: ReadRoomAccess },
  signal?: AbortSignal,
  refreshProfiles = true,
): Promise<Omit<ImportedAccount, 'profile'>> {
  const previous = new Map([...archived, ...known].map((row) => [row.providerId, row]));
  const archivedIds = new Set(archived.map((row) => row.providerId));
  const ids = [...new Set([...indexed, ...previous.keys()])];
  const handleIds = refreshProfiles
    ? undefined
    : [...indexed].filter((id) => !previous.has(id) || previous.get(id)?.subjectProfilePending);
  const { profiles, membership, observedStatuses } = await readDirectoryProfiles(
    read,
    ids,
    signal,
    {
      followingIds: indexed,
      handleIds,
      // Some healthy profiles have no avatar. Refresh those on the full profile cycle.
      avatarIds: handleIds?.filter((id) => !previous.get(id)?.avatarSourceUrl),
    },
  );
  const knownRegions = new Set(
    ids.filter((id) => previous.get(id)?.accountArchiveReason === 'region_restricted'),
  );
  const candidates = [
    ...new Set([
      ...archivedIds,
      ...knownRegions,
      ...ids.filter(
        (id) => !indexed.has(id) || membership.get(id) !== true || !observedStatuses.has(id),
      ),
    ]),
  ];
  const pages = new Set(
    candidates.filter((id) => {
      const reason = previous.get(id)?.accountArchiveReason;
      return (
        reason !== 'account_deleted' &&
        (reason !== 'account_disabled' || (!indexed.has(id) && membership.get(id) === false))
      );
    }),
  );
  const recoveryCandidates = new Set(
    [...knownRegions].filter(
      (id) => indexed.has(id) && membership.get(id) === true && observedStatuses.has(id),
    ),
  );
  const flags = await readArchiveFlags(
    read,
    candidates,
    observedStatuses,
    rotation,
    { ...roomPages, candidates: pages, knownRegions, recoveryCandidates },
    signal,
  );
  let verifiedFollowingCount = 0;
  let unverifiedMissingCount = 0;
  let unresolvedProfileCount = 0;
  let recoveredArchivedCount = 0;
  const subjects: SubjectInput[] = [];
  for (const id of ids) {
    const before = previous.get(id);
    const evidence = flags.get(id);
    const fresh = evidence?.account;
    const followed = membership.get(id);
    const present = indexed.has(id) || followed === true;
    const wasArchived = archivedIds.has(id);
    const knownRegion = before?.accountArchiveReason === 'region_restricted';
    const regional = evidence?.regionRestricted ?? knownRegion;
    const clearedRegion = knownRegion && evidence?.regionRestricted === false;
    const restriction =
      before?.accountArchiveReason === 'unfollowed' || knownRegion
        ? undefined
        : before?.accountArchiveReason;
    const newRestriction =
      fresh?.deleted === true
        ? 'account_deleted'
        : evidence?.disabledOnPage === true
          ? 'account_disabled'
          : undefined;
    // A negative page result alone cannot clear a previous access restriction.
    const definitiveRestriction = newRestriction ?? restriction;
    const unfollowed =
      !regional &&
      !present &&
      followed === false &&
      fresh?.deleted === false &&
      evidence?.disabledOnPage === false &&
      definitiveRestriction !== 'account_deleted';
    const reason =
      (regional ? 'region_restricted' : undefined) ??
      (unfollowed ? 'unfollowed' : undefined) ??
      definitiveRestriction;
    if (present) verifiedFollowingCount++;
    if (wasArchived && !present && !reason && !clearedRegion) continue;
    const row = profileRecord(id, profiles.get(id), before);
    if (clearedRegion) row.accountRegionCleared = true;
    if (reason) {
      row.accountArchiveReason = reason;
      if (unfollowed) row.accountUnfollowConfirmed = true;
      if (reason === 'account_disabled' && newRestriction === reason)
        row.accountBlockedConfirmed = true;
      if (reason === 'region_restricted') {
        if (!present || !observedStatuses.has(id)) row.accountArchivePending = true;
        else if (wasArchived) recoveredArchivedCount++;
      }
    } else if (wasArchived) {
      // A pending archive can recover after an incomplete round. Confirmed
      // restrictions are handled above and survive routine follow checks.
      if (followed === true && fresh?.deleted === false && evidence?.disabledOnPage === false)
        recoveredArchivedCount++;
      else row.accountArchivePending = true;
    }
    if (!present && !reason) unverifiedMissingCount++;
    if (row.subjectProfilePending) unresolvedProfileCount++;
    subjects.push(row);
  }
  return {
    subjects,
    indexCount: indexed.size,
    verifiedFollowingCount,
    unresolvedProfileCount,
    ...(unverifiedMissingCount ? { unverifiedMissingCount } : {}),
    ...(recoveredArchivedCount ? { recoveredArchivedCount } : {}),
  };
}
