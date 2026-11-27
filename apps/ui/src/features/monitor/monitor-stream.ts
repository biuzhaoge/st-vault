import type { Subject } from '@st-vault/api-schema';
import { ApiError } from '../../shared/lib/api';
import { closeSource, type PlayerSource } from '../player/MediaSlot';
import { openLiveSource } from '../player/playback-requests';

export type StopMonitorStream = (keepalive?: boolean) => Promise<void>;

export function monitorConnectionRetryAt(
  used: number,
  notBeforeMs: number,
  now = Date.now(),
): number | undefined {
  if (used >= 3) return undefined;
  return Math.max(now + 1000 * 2 ** used, notBeforeMs);
}

export function isMonitorOpenConnectionFailure(cause: unknown): boolean {
  if (cause instanceof ApiError)
    return (
      (cause.status >= 500 || cause.status === 429 || cause.status === 408) &&
      cause.message !== 'live_busy' &&
      !['keys', 'status-unknown', 'private', 'offline'].includes(cause.reason ?? '')
    );
  return cause instanceof TypeError || (cause instanceof Error && cause.name === 'TimeoutError');
}

/** Owns the lease from the response, including before React mounts its video. */
export function startMonitorStream(
  subject: Subject,
  onOpen: (source: PlayerSource) => void,
  onError: (cause: unknown) => void,
): StopMonitorStream {
  const controller = new AbortController();
  let stopped: Promise<void> | undefined;
  let leaving = false;
  const opened = (async (): Promise<PlayerSource | undefined> => {
    // React can replay an effect before the first request should leave the page.
    await Promise.resolve();
    if (stopped) return;
    let source: PlayerSource;
    try {
      source = await openLiveSource(subject, controller.signal);
    } catch (error) {
      if (!stopped) onError(error);
      return;
    }
    if (!stopped) onOpen(source);
    return source;
  })();
  return (keepalive = false) => {
    leaving ||= keepalive;
    // Let a normal view change receive and release an in-flight lease. Aborting the
    // fetch would settle locally before the server finishes releasing capacity.
    if (leaving) controller.abort();
    if (!stopped) {
      stopped = opened.then(async (source) => {
        if (source) await closeSource(source, leaving);
      });
      void stopped.catch((error: unknown) =>
        console.warn('Monitor playback session release failed', error),
      );
    }
    return stopped;
  };
}
