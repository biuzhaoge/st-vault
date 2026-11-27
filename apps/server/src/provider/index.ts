import { randomBytes } from 'node:crypto';
import type { ArchiveReason } from '@st-vault/api-schema';
import type { AccountImportOptions, ProviderPort, SubjectInput } from '../ports.js';
import { aborted, createHttp, ProviderError, waitFor } from './http.js';
import { parseAccountCookies } from './account.js';
import { accountProfile, validId } from './account-profile.js';
import type { ImportedAccount } from './account-profile.js';
import { readFavoriteIndex } from './account-directory.js';
import { accountSiteOrigin, SiteRoutes } from './site-routes.js';
import { createLiveStatus } from './live-status.js';
import { openArchiveEvidence } from './account-flags.js';
import { createDisabledPageProbe, createRoomAccessProbe } from './disabled-page.js';
import { reconcileDirectory } from './directory-reconciliation.js';

export interface ProviderOptions {
  onCoverObserved?: (subjectId: string, source: string | null) => void;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  origin?: string;
  accountOrigin?: string;
  publicOrigins?: readonly string[];
  sites?: SiteRoutes;
  requestTimeoutMs?: number;
}
interface ArchiveEvidenceProbe {
  (providerId: number, signal: AbortSignal): Promise<ArchiveReason | null>;
  unfollowBlocked(providerId: number, signal: AbortSignal): Promise<void>;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProviderError('invalid-upstream-json');
  return value as Record<string, unknown>;
}
function parseJson(text: string): Record<string, unknown> {
  try {
    return object(JSON.parse(text) as unknown);
  } catch {
    throw new ProviderError('invalid-upstream-json');
  }
}

function isFavoriteAlreadyAbsent(text: string): boolean {
  const { error, data, ...extra } = parseJson(text);
  return (
    error === 'There are no favorites to delete' &&
    Object.keys(extra).length === 0 &&
    (data === null || (typeof data === 'object' && Object.keys(data).length === 0))
  );
}

export function createProvider(options: ProviderOptions = {}): Pick<
  ProviderPort,
  'status' | 'importList'
> & {
  sites: SiteRoutes;
  openArchiveReasonProbe(
    cookiesText: string,
    origin: string,
    expectedUsername: string | undefined,
    signal: AbortSignal,
  ): Promise<ArchiveEvidenceProbe>;
  unfollowAccountSubject(
    cookiesText: string,
    origin: string,
    expectedUsername: string,
    providerId: number,
    signal: AbortSignal,
  ): Promise<void>;
  importAccount(
    cookiesText: string,
    signal?: AbortSignal,
    onValidated?: () => void,
    sourceOrigin?: string,
    known?: (username: string) => Promise<readonly SubjectInput[]>,
    recover?: (username: string, index?: readonly number[]) => Promise<readonly SubjectInput[]>,
    importOptions?: AccountImportOptions,
  ): Promise<ImportedAccount>;
} {
  const origin = new URL(options.accountOrigin ?? options.origin ?? 'https://stripchat.com').origin;
  const sites =
    options.sites ??
    new SiteRoutes({
      origins: options.publicOrigins ?? (options.origin ? [options.origin] : undefined),
      fetch: options.fetch,
      now: options.now,
      timeoutMs: options.requestTimeoutMs,
    });
  const now = options.now ?? Date.now;
  const lastAccountProbe = new Map<string, number>();
  const status = createLiveStatus(sites, options.onCoverObserved);
  const disabledPage = (source: string) =>
    createDisabledPageProbe(source, options.fetch, options.requestTimeoutMs);
  const openAccountSession = async (source: string, cookiesText: string, signal?: AbortSignal) => {
    // Credentials stay on the selected account origin and never follow cross-origin redirects.
    const accountHttp = createHttp({
      fetch: options.fetch,
      timeoutMs: options.requestTimeoutMs,
      allow: (url) => url.origin === source,
      account: true,
      allowRedirects: false,
    });
    const cookie = parseAccountCookies(cookiesText, new URL(source).hostname, now());
    const observe = sites.beginAccess(source);
    let initial: Record<string, unknown>;
    try {
      initial = parseJson(
        await accountHttp.text(
          `${source}/api/front/v3/config/initial-dynamic?requestPath=/`,
          signal,
          cookie,
        ),
      );
      observe();
    } catch (error) {
      observe(error);
      throw error;
    }
    const dynamic = object(initial.initialDynamic);
    const { userId, ...profile } = accountProfile(dynamic.user);
    const read = async (path: string, requestSignal?: AbortSignal) =>
      parseJson(await accountHttp.text(`${source}${path}`, requestSignal, cookie));
    const unfollow = async (
      providerId: number,
      requestSignal: AbortSignal,
      indexed: ReadonlySet<number>,
    ): Promise<void> => {
      const { csrfToken, csrfTimestamp, csrfNotifyTimestamp } = dynamic;
      if (![csrfToken, csrfTimestamp, csrfNotifyTimestamp].every((v) => typeof v === 'string' && v))
        throw new ProviderError('account-csrf-unavailable');
      const { text, status } = await accountHttp.deleteJson(
        `${source}/api/front/users/${userId}/favorites`,
        {
          cookie,
          signal: requestSignal,
          body: {
            favoriteIds: [providerId],
            csrfToken,
            csrfTimestamp,
            csrfNotifyTimestamp,
            uniq: randomBytes(8).toString('hex'),
          },
        },
      );
      if (status === 400) {
        // The native operation explicitly rejects removal of a relationship that is already gone.
        if (!indexed.has(providerId) && isFavoriteAlreadyAbsent(text)) return;
        throw new ProviderError('upstream-http', status);
      }
      if (status !== 200 || !/^\[\s*\]$/.test(text.trim()))
        throw new ProviderError('unfollow-response-unconfirmed');
    };
    return { read, unfollow, userId, profile };
  };
  const openBoundAccount = async (
    cookiesText: string,
    sourceOrigin: string,
    expectedUsername: string | undefined,
    signal: AbortSignal,
  ) => {
    const source = accountSiteOrigin(sourceOrigin);
    const { read, unfollow, userId, profile } = await openAccountSession(
      source,
      cookiesText,
      signal,
    );
    if (
      expectedUsername !== undefined &&
      profile.username.toLowerCase() !== expectedUsername.toLowerCase()
    )
      throw new ProviderError('upstream-identity-mismatch');
    const indexed = new Set(await readFavoriteIndex(read, userId, signal));
    return { read, unfollow, indexed };
  };
  const unfollowAccountSubject = async (
    cookiesText: string,
    sourceOrigin: string,
    expectedUsername: string,
    providerId: number,
    signal: AbortSignal,
  ): Promise<void> => {
    aborted(signal);
    if (!validId(providerId)) throw new ProviderError('invalid-provider-id');
    if (!expectedUsername.trim()) throw new ProviderError('account-session-unavailable');
    const { unfollow, indexed } = await openBoundAccount(
      cookiesText,
      sourceOrigin,
      expectedUsername,
      signal,
    );
    await unfollow(providerId, signal, indexed);
  };
  const openArchiveReasonProbe = async (
    cookiesText: string,
    sourceOrigin: string,
    expectedUsername: string | undefined,
    signal: AbortSignal,
  ) => {
    const { read, unfollow, indexed } = await openBoundAccount(
      cookiesText,
      sourceOrigin,
      expectedUsername,
      signal,
    );
    const probe = openArchiveEvidence(read, indexed, disabledPage(accountSiteOrigin(sourceOrigin)));
    const checked = new Map<number, { blocked: boolean }>();
    const check = async (providerId: number, requestSignal: AbortSignal) => {
      const observation = { blocked: false };
      checked.set(providerId, observation);
      const active = AbortSignal.any([signal, requestSignal]);
      const reason = await probe(providerId, active);
      aborted(active);
      observation.blocked = reason === 'account_disabled';
      return reason;
    };
    return Object.assign(check, {
      async unfollowBlocked(providerId: number, requestSignal: AbortSignal): Promise<void> {
        const active = AbortSignal.any([signal, requestSignal]);
        aborted(active);
        if (!expectedUsername || !checked.get(providerId)?.blocked)
          throw new ProviderError('blocked-account-unconfirmed');
        checked.delete(providerId);
        await unfollow(providerId, active, indexed);
      },
    });
  };
  const importAccount = async (
    cookiesText: string,
    signal?: AbortSignal,
    onValidated?: () => void,
    sourceOrigin?: string,
    known?: (username: string) => Promise<readonly SubjectInput[]>,
    recover?: (username: string, index?: readonly number[]) => Promise<readonly SubjectInput[]>,
    importOptions?: AccountImportOptions,
  ): Promise<ImportedAccount> => {
    const source = sourceOrigin ? accountSiteOrigin(sourceOrigin) : origin;
    const { read, userId, profile } = await openAccountSession(source, cookiesText, signal);
    onValidated?.();
    const indexed = await readFavoriteIndex(read, userId, signal);
    aborted(signal);
    const indexedProfile = { ...profile, followingCount: indexed.length };
    if (importOptions?.onIndexed) {
      await importOptions.onIndexed({ profile: indexedProfile, indexedIds: indexed });
      aborted(signal);
    }
    const [previousSubjects, archivedCandidates] = await waitFor(
      Promise.all([known?.(profile.username) ?? [], recover?.(profile.username, indexed) ?? []]),
      signal,
    );
    const scope = JSON.stringify([source, userId]);
    const reconciled = await reconcileDirectory(
      read,
      new Set(indexed),
      previousSubjects,
      archivedCandidates,
      {
        after: lastAccountProbe.get(scope),
        onAttempt: (id) => {
          lastAccountProbe.set(scope, id);
        },
      },
      {
        readDisabled: disabledPage(source),
        readAccess: createRoomAccessProbe(source, options.fetch, options.requestTimeoutMs),
      },
      signal,
      importOptions?.refreshProfiles,
    );
    return { ...reconciled, profile: indexedProfile };
  };
  return {
    sites,
    status,
    openArchiveReasonProbe,
    unfollowAccountSubject,
    importAccount,
    importList: async (cookiesText, signal): Promise<SubjectInput[]> =>
      (await importAccount(cookiesText, signal)).subjects,
  };
}
