import type { SubjectInput } from '../ports.js';
import { accountAvatarSource, directoryHandle, validId } from './account-profile.js';
import { modelCardStatus, modelStatusPath } from './batched-model-status.js';
import { aborted, ProviderError } from './http.js';

export type ReadAccount = (path: string, signal?: AbortSignal) => Promise<Record<string, unknown>>;

export type DirectoryProfile = Partial<
  Pick<SubjectInput, 'handle' | 'avatarSourceUrl' | 'previewSourceUrl'>
>;

interface DirectoryRequest {
  source: 'users' | 'profiles' | 'cards';
  path: string;
  apply: (body: Record<string, unknown>) => void;
}

const profileBatchSize = 50;
const profileConcurrency = 4;
const profileBudgetMs = 15_000;
const maxControlIds = 3;

export async function readFavoriteIndex(
  read: ReadAccount,
  accountId: number,
  signal?: AbortSignal,
): Promise<number[]> {
  if (!validId(accountId)) throw new ProviderError('invalid-account-list');
  const { modelIds } = await read(`/api/front/users/${accountId}/favorites`, signal);
  if (!Array.isArray(modelIds) || modelIds.length > 10000)
    throw new ProviderError('invalid-account-list');
  const ids = new Set<number>();
  for (const id of modelIds) {
    if (!validId(id) || ids.has(id)) throw new ProviderError('invalid-account-list');
    ids.add(id);
  }
  return [...ids];
}

function idBatches(ids: readonly number[], size: number): number[][] {
  if (ids.some((id) => !validId(id))) throw new ProviderError('invalid-account-list');
  const unique = [...new Set(ids)];
  const batches: number[][] = [];
  for (let offset = 0; offset < unique.length; offset += size)
    batches.push(unique.slice(offset, offset + size));
  return batches;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProviderError('upstream-item-unavailable');
  return value as Record<string, unknown>;
}

function rowsById(values: unknown, ids: readonly number[]): Map<number, Record<string, unknown>> {
  if (!Array.isArray(values)) throw new ProviderError('upstream-item-unavailable');
  const wanted = new Set(ids);
  const rows = new Map<number, Record<string, unknown>>();
  for (const value of values) {
    const row = record(value);
    if (!validId(row.id) || !wanted.has(row.id) || rows.has(row.id))
      throw new ProviderError('upstream-identity-mismatch');
    rows.set(row.id, row);
  }
  return rows;
}

function profileRows(
  values: unknown,
  ids: readonly number[],
): Map<number, Record<string, unknown>> {
  const wanted = new Set(ids);
  const rows = new Map<number, Record<string, unknown>>();
  for (const [key, value] of Object.entries(record(values))) {
    const id = Number(key);
    const row = record(value);
    if (
      !wanted.has(id) ||
      String(id) !== key ||
      (row.id !== undefined && row.id !== id) ||
      (row.userId !== undefined && row.userId !== id)
    )
      throw new ProviderError('upstream-identity-mismatch');
    rows.set(id, row);
  }
  return rows;
}

function userQuery(ids: readonly number[]): string {
  return new URLSearchParams(
    ids.map<[string, string]>((id, i) => [`userIds[${i}]`, String(id)]),
  ).toString();
}

function mergeProfile(
  profiles: Map<number, DirectoryProfile>,
  id: number,
  fields: DirectoryProfile,
) {
  profiles.set(id, { ...profiles.get(id), ...fields });
}

function cardRequest(
  ids: readonly number[],
  controls: readonly number[],
  membership: Map<number, boolean>,
  directory?: { profiles: Map<number, DirectoryProfile>; observedStatuses: Set<number> },
): DirectoryRequest {
  const requested = [...new Set([...ids, ...controls])];
  return {
    source: 'cards',
    path: modelStatusPath(requested),
    apply({ models }) {
      const rows = rowsById(models, requested);
      // Anonymous-equivalent responses can put false on every card.
      const verified = controls.some((id) => rows.get(id)?.isInFavorites === true);
      for (const id of ids) {
        const row = rows.get(id);
        if (directory && row) {
          const cover = accountAvatarSource(row.previewUrlThumbSmall);
          if (cover) mergeProfile(directory.profiles, id, { previewSourceUrl: cover });
          if (modelCardStatus(row) !== 'UNKNOWN') directory.observedStatuses.add(id);
        }
        if (verified && typeof row?.isInFavorites === 'boolean')
          membership.set(id, row.isInFavorites);
      }
    },
  };
}

async function readRequests(
  read: ReadAccount,
  requests: readonly DirectoryRequest[],
  concurrency: number,
  signal?: AbortSignal,
): Promise<void> {
  aborted(signal);
  if (!requests.length) return;
  const deadline = AbortSignal.timeout(profileBudgetMs);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const failures = new Map<DirectoryRequest['source'], ProviderError>();
  for (let start = 0; start < requests.length && !requestSignal.aborted; start += concurrency) {
    await Promise.all(
      requests.slice(start, start + concurrency).map(async ({ source, path, apply }) => {
        try {
          const body = await read(path, requestSignal);
          aborted(requestSignal);
          apply(body);
        } catch (error) {
          aborted(signal);
          if (!(error instanceof ProviderError)) throw error;
          failures.set(source, error);
        }
      }),
    );
  }
  for (const [source, { code, status }] of failures)
    console.info(
      JSON.stringify({ event: 'directory_profile_source_unavailable', source, code, status }),
    );
}

function knownControls(followingIds: ReadonlySet<number>): number[] {
  return [...followingIds].filter(validId).slice(0, maxControlIds);
}

export async function readDirectoryProfiles(
  read: ReadAccount,
  ids: readonly number[],
  signal?: AbortSignal,
  options: {
    followingIds?: ReadonlySet<number>;
    handleIds?: readonly number[];
    avatarIds?: readonly number[];
  } = {},
): Promise<{
  profiles: ReadonlyMap<number, DirectoryProfile>;
  membership: ReadonlyMap<number, boolean>;
  observedStatuses: ReadonlySet<number>;
}> {
  const profiles = new Map<number, DirectoryProfile>();
  const membership = new Map<number, boolean>();
  const observedStatuses = new Set<number>();
  const controls = options.followingIds ? knownControls(options.followingIds) : [];
  const capacity = profileBatchSize - controls.length;
  const cardBatches = idBatches(ids, capacity);
  const handles = options.handleIds ? idBatches(options.handleIds, capacity) : cardBatches;
  const avatars = options.avatarIds ? idBatches(options.avatarIds, capacity) : cardBatches;
  const requests: DirectoryRequest[] = [];
  for (const [index, cards] of cardBatches.entries()) {
    const handleBatch = handles[index];
    const avatarBatch = avatars[index];
    if (handleBatch)
      requests.push({
        source: 'users',
        path: `/api/front/v2/users?${userQuery(handleBatch)}`,
        apply({ items }) {
          for (const [id, row] of rowsById(items, handleBatch)) {
            const handle = directoryHandle(row.username);
            if (handle) mergeProfile(profiles, id, { handle });
          }
        },
      });
    if (avatarBatch)
      requests.push({
        source: 'profiles',
        path: `/api/front/v2/users/profiles?${userQuery(avatarBatch)}`,
        apply({ items }) {
          for (const [id, row] of profileRows(items, avatarBatch)) {
            const avatar = accountAvatarSource(row.avatarUrl);
            if (avatar) mergeProfile(profiles, id, { avatarSourceUrl: avatar });
          }
        },
      });
    requests.push(cardRequest(cards, controls, membership, { profiles, observedStatuses }));
  }
  await readRequests(read, requests, profileConcurrency, signal);
  return { profiles, membership, observedStatuses };
}

/** The archive heartbeat only needs verified relationship flags from the card endpoint. */
export async function readDirectoryMembership(
  read: ReadAccount,
  ids: readonly number[],
  followingIds: ReadonlySet<number>,
  signal?: AbortSignal,
): Promise<ReadonlyMap<number, boolean>> {
  const controls = knownControls(followingIds);
  const membership = new Map<number, boolean>();
  const requests = controls.length
    ? idBatches(ids, profileBatchSize - controls.length).map((batch) =>
        cardRequest(batch, controls, membership),
      )
    : [];
  await readRequests(read, requests, 1, signal);
  return membership;
}
