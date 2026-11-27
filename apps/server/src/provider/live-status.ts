import type { PublicStatus } from '@st-vault/api-schema';
import {
  createBatchedModelStatus,
  modelBatchStatuses,
  modelCardStatus,
  modelStatusPath,
} from './batched-model-status.js';
import { broadcastCover } from './cover-source.js';
import { aborted } from './http.js';
import type { SiteRoutes } from './site-routes.js';

/** Batch fresh observations on the currently bound site. */
export function createLiveStatus(
  sites: SiteRoutes,
  onCoverObserved?: (id: string, source: string | null) => void,
) {
  const batches = new WeakMap<AbortSignal, ReturnType<typeof createBatchedModelStatus>>();
  const read = async (ids: readonly number[], signal: AbortSignal) => {
    const covers = new Map<number, string | null>();
    const statuses = await sites.read(
      modelStatusPath(ids),
      (text) =>
        modelBatchStatuses(text, ids, (item, id) => {
          const status = modelCardStatus(item);
          if (onCoverObserved && status === 'PUBLIC') {
            const source = broadcastCover(id, item);
            if (source) covers.set(id, source);
          } else if (onCoverObserved && (status === 'OFFLINE' || status === 'PRIVATE')) {
            covers.set(id, null);
          }
          return status;
        }),
      signal,
    );
    // Publish cover updates only after the whole batch and its binding have passed validation.
    aborted(signal);
    for (const [id, source] of covers) onCoverObserved?.(`stripchat:${id}`, source);
    return statuses;
  };
  return (id: number, signal?: AbortSignal): Promise<PublicStatus> => {
    const binding = sites.activeBinding();
    let batch = batches.get(binding);
    if (!batch) {
      batch = createBatchedModelStatus(read, binding);
      batches.set(binding, batch);
    }
    return batch(id, signal);
  };
}
