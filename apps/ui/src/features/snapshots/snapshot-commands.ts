import type {
  MediaDeletionJob,
  PersonalTimeline,
  SnapshotItem,
  MediaTimeRange,
  MediaSelection,
  MediaSelectionResult,
  MediaDeletionTarget,
  FavoriteChange,
} from '@st-vault/api-schema';
import { ApiError, request, MutationOutcomeUnknown } from '../../shared/lib/api';
import { MAX_SNAPSHOT_SELECTION } from '@st-vault/api-schema';

type FavoriteFacts = Pick<PersonalTimeline, 'favorites' | 'revision'>;
interface FavoriteBatch {
  revision: number;
  favorites?: PersonalTimeline['favorites'];
}
// The selection preparation route uses the 512 KiB server limit. A UUID in a
// JSON array consumes 39 bytes, including quotes and a separator.
const PREPARATION_UNIT_LIMIT = 10000;

interface Operation {
  readonly revision: number;
  readonly scope: string;
  readonly signal: AbortSignal;
}
/** Owns command admission and protocol. Releasing UI ownership never rolls back durable intent. */
export class SnapshotCommands {
  async admitDeletion(
    subjectId: string,
    commandId: string,
    target: MediaDeletionTarget,
  ): Promise<MediaDeletionJob> {
    const body = JSON.stringify({ commandId, target });
    const submit = () =>
      this.transport<MediaDeletionJob>(
        `/api/subjects/${encodeURIComponent(subjectId)}/deletion-intents`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          keepalive: body.length < 60000,
        },
      );
    try {
      return await submit();
    } catch (cause) {
      // The receipt is keyed by commandId, so repeating this exact admission
      // cannot create a second task or capture newly recorded media.
      if (cause instanceof MutationOutcomeUnknown) return submit();
      throw cause;
    }
  }
  private revision = 0;
  private held = false;
  private preparation: AbortController | null = null;
  private favoriteTail: Promise<number | undefined> | undefined;
  private favoriteRevision: number | undefined;
  constructor(private readonly transport: typeof request = request) {}
  private post<T>(path: string, body: unknown): Promise<T> {
    return this.transport(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  get busy(): boolean {
    return this.held;
  }
  begin(scope: string): Operation | null {
    if (this.held) return null;
    this.held = true;
    this.preparation = new AbortController();
    return Object.freeze({ revision: ++this.revision, scope, signal: this.preparation.signal });
  }
  current(operation: Operation, scope = operation.scope): boolean {
    return operation.revision === this.revision && operation.scope === scope;
  }
  release(operation: Operation): void {
    if (operation.revision === this.revision) {
      this.held = false;
      this.preparation?.abort();
      this.preparation = null;
    }
  }
  cancelPreparation(): void {
    this.preparation?.abort();
    this.preparation = null;
    this.revision++;
    this.held = false;
  }
  dispose(): void {
    this.cancelPreparation();
    this.revision++;
    this.held = false;
  }
  get hasFavoriteWrites(): boolean {
    return this.favoriteTail !== undefined;
  }
  setFavorite(
    subjectId: string,
    item: SnapshotItem,
    liked: boolean,
    revision: number,
    signal?: AbortSignal,
  ): Promise<FavoriteFacts> {
    return this.setFavorites(subjectId, [item.unitId], liked, revision, signal);
  }
  setFavorites(
    subjectId: string,
    ids: readonly [string],
    liked: boolean,
    revision: number,
    signal?: AbortSignal,
  ): Promise<FavoriteFacts>;
  setFavorites(
    subjectId: string,
    ids: readonly string[],
    liked: FavoriteChange,
    revision: number | undefined,
    signal?: AbortSignal,
  ): Promise<FavoriteBatch>;
  setFavorites(
    subjectId: string,
    ids: readonly string[],
    liked: FavoriteChange,
    revision: number | undefined,
    signal?: AbortSignal,
  ): Promise<FavoriteBatch> {
    const unitIds = [...new Set(ids)];
    if (!unitIds.length) return Promise.reject(Error('EMPTY_SNAPSHOT_SELECTION'));
    const earlier = this.favoriteTail;
    const result = (async () => {
      const prior = earlier ? await earlier : this.favoriteRevision;
      const inspected =
        revision === undefined || (earlier && prior === undefined)
          ? (await this.queryFavorites(subjectId, [unitIds[0]], signal)).revision
          : revision;
      const expected = Math.max(inspected, revision ?? 0, prior ?? 0);
      signal?.throwIfAborted();
      const base = `/api/subjects/${encodeURIComponent(subjectId)}`;
      if (unitIds.length <= MAX_SNAPSHOT_SELECTION)
        return this.post<FavoriteFacts>(base + '/unit-favorites', {
          unitIds,
          liked,
          revision: expected,
        });
      // Each token extends the same frozen explicit selection. No favorites are
      // changed until the final version-checked request.
      const prefix = unitIds.length - MAX_SNAPSHOT_SELECTION;
      let selectionId: string | undefined;
      for (let start = 0; start < prefix; start += PREPARATION_UNIT_LIMIT) {
        const end = Math.min(start + PREPARATION_UNIT_LIMIT, prefix);
        const selection: MediaSelection = await this.transport<MediaSelection>(
          base + '/media-selection',
          {
            method: 'POST',
            operation: 'session',
            headers: { 'content-type': 'application/json' },
            signal,
            body: JSON.stringify({
              fromMs: 0,
              toMs: 1,
              mode: 'explicit',
              baseSelectionId: selectionId,
              includeUnitIds: unitIds.slice(start, end),
            }),
          },
        );
        signal?.throwIfAborted();
        if (selection.personalRevision !== expected || selection.count !== end)
          throw new ApiError('media_selection_stale', 409);
        selectionId = selection.id;
      }
      return this.post<MediaSelectionResult>(
        base + '/media-selection/' + selectionId + '/favorites',
        {
          liked,
          revision: expected,
          includeUnitIds: unitIds.slice(prefix),
        },
      );
    })();
    const tail = result.then(
      ({ revision: committed }) => {
        this.favoriteRevision = committed;
        return committed;
      },
      () => {
        this.favoriteRevision = undefined;
        return undefined;
      },
    );
    this.favoriteTail = tail;
    void tail.then(() => {
      if (this.favoriteTail === tail) this.favoriteTail = undefined;
    });
    return result;
  }
  async unlikeRange(
    subjectId: string,
    range: MediaTimeRange,
    signal: AbortSignal,
  ): Promise<MediaSelectionResult> {
    const selection = await this.transport<MediaSelection>(
      `/api/subjects/${encodeURIComponent(subjectId)}/media-selection`,
      {
        method: 'POST',
        operation: 'session',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...range, mode: 'all' }),
        signal,
      },
    );
    signal.throwIfAborted();
    return this.post(
      `/api/subjects/${encodeURIComponent(subjectId)}/media-selection/${selection.id}/favorites`,
      { liked: false, revision: selection.personalRevision },
    );
  }
  async personal(
    subjectId: string,
    items: SnapshotItem[],
    signal?: AbortSignal,
  ): Promise<PersonalTimeline> {
    const value = await this.queryFavorites(
      subjectId,
      items.map((item) => item.unitId),
      signal,
    );
    return {
      ...value,
      ...items.reduce(
        (bounds, item) => ({
          fromMs: Math.min(bounds.fromMs, item.slotFromMs),
          toMs: Math.max(bounds.toMs, item.slotToMs),
        }),
        { fromMs: Infinity, toMs: -Infinity },
      ),
    };
  }
  async queryFavorites(
    subjectId: string,
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<PersonalTimeline> {
    const unitIds = [...new Set(ids)];
    if (!unitIds.length) throw Error('EMPTY_SNAPSHOT_SELECTION');
    let result: PersonalTimeline | undefined;
    for (let start = 0; start < unitIds.length; start += MAX_SNAPSHOT_SELECTION) {
      const part = await this.favoritePage(
        subjectId,
        unitIds.slice(start, start + MAX_SNAPSHOT_SELECTION),
        signal,
      );
      if (!result)
        result =
          unitIds.length > MAX_SNAPSHOT_SELECTION
            ? { ...part, favorites: [...part.favorites] }
            : part;
      else {
        if (result.revision !== part.revision) throw new ApiError('media_selection_stale', 409);
        if (part.favorites.length) {
          result.fromMs = result.favorites.length
            ? Math.min(result.fromMs, part.fromMs)
            : part.fromMs;
          result.toMs = Math.max(result.toMs, part.toMs);
        }
        for (const favorite of part.favorites) result.favorites.push(favorite);
      }
    }
    return result!;
  }
  private async favoritePage(
    subjectId: string,
    unitIds: string[],
    signal?: AbortSignal,
  ): Promise<PersonalTimeline> {
    const budget = new AbortController();
    const timer = setTimeout(
      () => budget.abort(new DOMException('Preparation timed out', 'TimeoutError')),
      15000,
    );
    const combined = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
    try {
      combined.throwIfAborted();
      const value = await this.transport<PersonalTimeline>(
        `/api/subjects/${encodeURIComponent(subjectId)}/unit-favorites/query`,
        {
          method: 'POST',
          operation: 'session',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ unitIds }),
          signal: combined,
        },
      );
      combined.throwIfAborted();
      if (value.truncated) throw Error('FAVORITES_TRUNCATED');
      return value;
    } finally {
      clearTimeout(timer);
    }
  }
  jobs(signal?: AbortSignal): Promise<MediaDeletionJob[]> {
    return this.transport('/api/media-deletions', { signal });
  }
  async receipt(id: string, signal?: AbortSignal): Promise<MediaDeletionJob | null> {
    try {
      return await this.transport<MediaDeletionJob>(
        `/api/media-deletions/${encodeURIComponent(id)}`,
        { signal },
      );
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        cause.status === 404 &&
        cause.message === 'media_deletion_not_found'
      )
        return null;
      throw cause;
    }
  }
}
