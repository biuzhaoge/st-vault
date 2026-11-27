import type { ArchiveReason } from '@st-vault/api-schema';
import { directoryHandle, validId } from './account-profile.js';
import { readDirectoryMembership, type ReadAccount } from './account-directory.js';
import { aborted, ProviderError } from './http.js';

interface UserArchiveFlags {
  deleted: boolean | undefined;
  handle: string | null;
}

interface DirectoryArchiveFlags {
  account?: UserArchiveFlags;
  regionRestricted?: boolean;
  disabledOnPage?: boolean;
}

export type ReadDisabledPage = (
  handle: string,
  signal: AbortSignal,
) => Promise<boolean | undefined>;
export type ReadRoomAccess = (
  handle: string,
  providerId: number,
  signal: AbortSignal,
) => Promise<boolean>;

async function userArchiveFlags(
  read: ReadAccount,
  id: number,
  signal?: AbortSignal,
): Promise<UserArchiveFlags> {
  if (!validId(id)) throw new ProviderError('invalid-provider-id');
  const { item } = await read(`/api/front/v2/users/${id}`, signal);
  if (!item || typeof item !== 'object' || Array.isArray(item) || !('id' in item))
    throw new ProviderError('upstream-item-unavailable');
  if (item.id !== id) throw new ProviderError('upstream-identity-mismatch');
  return {
    deleted:
      'isDeleted' in item && typeof item.isDeleted === 'boolean' ? item.isDeleted : undefined,
    handle: 'username' in item ? directoryHandle(item.username) : null,
  };
}

async function roomRegionRestriction(read: ReadAccount, id: number, signal: AbortSignal) {
  const { user } = await read(`/api/front/v2/models/${id}/cam`, signal);
  if (!user || typeof user !== 'object' || !('user' in user)) return undefined;
  const account = user.user;
  if (!account || typeof account !== 'object' || !('id' in account) || account.id !== id)
    return undefined;
  return 'isGeoBanned' in user && typeof user.isGeoBanned === 'boolean'
    ? user.isGeoBanned
    : undefined;
}

async function observe<T>(read: () => Promise<T>) {
  try {
    return { value: await read() };
  } catch (error) {
    if (!(error instanceof ProviderError)) throw error;
    return { error };
  }
}

function routeUnavailable(error: ProviderError | undefined): boolean {
  return error?.challenge === true || error?.status === 401 || error?.status === 429;
}

export function openArchiveEvidence(
  read: ReadAccount,
  indexed: ReadonlySet<number>,
  readDisabledPage: ReadDisabledPage,
) {
  return async (id: number, signal: AbortSignal): Promise<ArchiveReason | null> => {
    const flags = await userArchiveFlags(read, id, signal);
    if (flags.deleted === true) return 'account_deleted';
    if (!flags.handle) return null;
    const disabled = await readDisabledPage(flags.handle, signal);
    let reason: ArchiveReason | null = disabled ? 'account_disabled' : null;
    if (disabled === false && flags.deleted === false && !indexed.has(id)) {
      const membership = await readDirectoryMembership(read, [id], indexed, signal);
      if (membership.get(id) === false) reason = 'unfollowed';
    }
    if (reason === 'account_disabled' || reason === 'unfollowed') {
      // A confirmed room restriction takes priority over cleanup eligibility.
      const room = await observe(() => roomRegionRestriction(read, id, signal));
      aborted(signal);
      if (room.value === true) return 'region_restricted';
    }
    return reason;
  };
}

/** Account flags are useful for roster omissions and archived rows. Keep the
 * existing per-account rotation so a long candidate list can make progress. */
export async function readArchiveFlags(
  read: ReadAccount,
  ids: readonly number[],
  observedStatuses: ReadonlySet<number>,
  rotation: { after: number | undefined; onAttempt: (id: number) => void },
  pages: {
    readDisabled: ReadDisabledPage;
    readAccess: ReadRoomAccess;
    candidates: ReadonlySet<number>;
    knownRegions: ReadonlySet<number>;
    recoveryCandidates: ReadonlySet<number>;
  },
  signal?: AbortSignal,
): Promise<ReadonlyMap<number, DirectoryArchiveFlags>> {
  aborted(signal);
  const results = new Map<number, DirectoryArchiveFlags>();
  if (!ids.length) return results;
  const deadline = AbortSignal.timeout(12_000);
  const verification = signal ? AbortSignal.any([deadline, signal]) : deadline;
  const start = rotation.after === undefined ? 0 : ids.indexOf(rotation.after) + 1;
  const ordered = [...ids.slice(start), ...ids.slice(0, start)].slice(0, 48);
  let roomsAvailable = true;
  let pagesAvailable = true;
  for (let offset = 0; offset < ordered.length && !verification.aborted; offset += 4) {
    const batch = await Promise.all(
      ordered.slice(offset, offset + 4).map(async (id) => {
        rotation.onAttempt(id);
        const account = await observe(() => userArchiveFlags(read, id, verification));
        const knownRegion = pages.knownRegions.has(id);
        const room =
          roomsAvailable &&
          (knownRegion || !observedStatuses.has(id)) &&
          !routeUnavailable(account.error)
            ? await observe(() => roomRegionRestriction(read, id, verification))
            : undefined;
        const handle = account.value?.handle;
        // A plain 403 is inconclusive. Recheck only already-followed rooms with a valid card.
        const access =
          pagesAvailable &&
          pages.recoveryCandidates.has(id) &&
          room?.error?.status === 403 &&
          !room.error.challenge &&
          !/(?:\/|\+)json$/i.test(room.error.contentType ?? '') &&
          handle &&
          account.value?.deleted === false
            ? await observe(() => pages.readAccess(handle, id, verification))
            : undefined;
        const page =
          pagesAvailable &&
          access?.value !== true &&
          pages.candidates.has(id) &&
          handle &&
          account.value?.deleted !== true &&
          room?.value !== true &&
          (room?.value === false || !knownRegion)
            ? await observe(() => pages.readDisabled(handle, verification))
            : undefined;
        results.set(id, {
          account: account.value,
          regionRestricted: room?.value ?? (access?.value === true ? false : undefined),
          disabledOnPage: access?.value === true ? false : page?.value,
        });
        return {
          accountError: account.error,
          roomError: room?.error,
          pageError: access?.error ?? page?.error,
        };
      }),
    );
    if (batch.some(({ accountError }) => routeUnavailable(accountError))) break;
    if (batch.some(({ roomError }) => routeUnavailable(roomError))) roomsAvailable = false;
    if (batch.some(({ pageError }) => routeUnavailable(pageError))) pagesAvailable = false;
  }
  aborted(signal);
  return results;
}
