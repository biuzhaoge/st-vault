import type { PublicStatus } from '@st-vault/api-schema';
import { validId } from './account-profile.js';
import { aborted, ProviderError, waitFor } from './http.js';

type Read = (
  ids: readonly number[],
  signal: AbortSignal,
) => Promise<ReadonlyMap<number, PublicStatus>>;

interface Entry {
  promise: Promise<PublicStatus>;
  resolve: (status: PublicStatus) => void;
  reject: (error: unknown) => void;
  callers: number;
  cancelUnused?: () => void;
}

const batchSize = 50;
const maxBatches = 4;
const maxOutstanding = 1024;

const privateModes = new Set([
  'p2p',
  'p2pvoice',
  'p2paudio',
  'private',
  'virtualprivate',
  'groupshow',
  'group_show',
]);

export function modelCardStatus({ status, isLive }: Record<string, unknown>): PublicStatus {
  if (typeof status !== 'string') return 'UNKNOWN';
  const mode = status.toLowerCase();
  if (isLive === false && (mode === 'off' || mode === 'idle')) return 'OFFLINE';
  if (isLive === true && mode === 'public') return 'PUBLIC';
  if (isLive === true && privateModes.has(mode)) return 'PRIVATE';
  return 'UNKNOWN';
}

/** Coalesce reads within a route. A result belongs only to its pending callers. */
export function createBatchedModelStatus(read: Read, binding?: AbortSignal) {
  const outstanding = new Map<number, Entry>();
  const queued = new Map<number, Entry>();
  let active = 0;
  let scheduled = false;

  async function run(batch: ReadonlyMap<number, Entry>) {
    const controller = new AbortController();
    const signal = binding ? AbortSignal.any([controller.signal, binding]) : controller.signal;
    const remove = (id: number, entry: Entry) => {
      if (outstanding.get(id) === entry) outstanding.delete(id);
    };
    const cancelUnused = () => {
      if ([...batch.values()].some((entry) => entry.callers > 0)) return;
      for (const [id, entry] of batch) remove(id, entry);
      controller.abort();
    };
    for (const entry of batch.values()) entry.cancelUnused = cancelUnused;

    try {
      aborted(signal);
      const found = await read([...batch.keys()], signal);
      aborted(signal);
      for (const [id, entry] of batch) entry.resolve(found.get(id) ?? 'UNKNOWN');
    } catch (error) {
      for (const entry of batch.values()) entry.reject(error);
    } finally {
      for (const [id, entry] of batch) remove(id, entry);
      active--;
      schedule();
    }
  }

  function schedule(): void {
    if (scheduled || !queued.size || active >= maxBatches) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      while (queued.size && active < maxBatches) {
        const batch = new Map<number, Entry>();
        for (const [id, entry] of queued) {
          queued.delete(id);
          batch.set(id, entry);
          if (batch.size === batchSize) break;
        }
        active++;
        void run(batch);
      }
    });
  }

  return (id: number, signal?: AbortSignal): Promise<PublicStatus> => {
    if (!validId(id)) return Promise.reject(new ProviderError('invalid-provider-id'));
    const until = binding && signal ? AbortSignal.any([signal, binding]) : (binding ?? signal);
    if (until?.aborted) return Promise.reject(new ProviderError('cancelled'));
    let entry = outstanding.get(id);
    if (!entry) {
      if (outstanding.size >= maxOutstanding)
        return Promise.reject(new ProviderError('model-status-batch-busy'));
      let resolve!: Entry['resolve'];
      let reject!: Entry['reject'];
      const promise = new Promise<PublicStatus>((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      entry = { promise, resolve, reject, callers: 0 };
      outstanding.set(id, entry);
      queued.set(id, entry);
      schedule();
    }
    const caller = entry;
    caller.callers++;
    return waitFor(caller.promise, until).finally(() => {
      if (--caller.callers !== 0 || outstanding.get(id) !== caller) return;
      if (queued.delete(id)) outstanding.delete(id);
      else caller.cancelUnused?.();
    });
  };
}

export function modelStatusPath(ids: readonly number[]): string {
  const query = new URLSearchParams(
    ids.map<[string, string]>((id, index) => [`modelIds[${index}]`, String(id)]),
  );
  return `/api/front/models/list?${query.toString()}`;
}

export function modelBatchStatuses(
  text: string,
  ids: readonly number[],
  classify: (item: Record<string, unknown>, id: number) => PublicStatus,
): ReadonlyMap<number, PublicStatus> {
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new ProviderError('invalid-upstream-json');
  }
  if (!body || typeof body !== 'object' || !('models' in body) || !Array.isArray(body.models))
    throw new ProviderError('upstream-item-unavailable');
  const requested = new Set(ids);
  const found = new Map<number, PublicStatus>();
  for (const value of body.models as unknown[]) {
    if (!value || typeof value !== 'object' || !('id' in value) || !validId(value.id))
      throw new ProviderError('upstream-item-unavailable');
    if (!requested.has(value.id) || found.has(value.id))
      throw new ProviderError('upstream-identity-mismatch');
    found.set(value.id, classify(value, value.id));
  }
  return found;
}
