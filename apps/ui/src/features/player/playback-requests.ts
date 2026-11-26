import type {
  LivePlaybackResponse,
  MediaTimeRange,
  PlaybackResponse,
  Subject,
} from '@st-vault/api-schema';
import { ApiError, request } from '../../shared/lib/api';
import type { ArchivePlayerSource, PlayerSource } from './MediaSlot';
import { archiveRequest } from './archive-request';

export async function openLiveSource(
  subject: Subject,
  signal: AbortSignal,
  replaceSession?: string,
): Promise<PlayerSource> {
  const stream = await request<LivePlaybackResponse>(
    `/api/subjects/${encodeURIComponent(subject.id)}/live`,
    {
      method: 'POST',
      operation: 'session',
      signal,
      headers: replaceSession === undefined ? undefined : { 'x-stv-replace-live': replaceSession },
    },
  );
  return { kind: 'live', subject, stream };
}

export async function openArchiveSource(
  subject: Subject,
  atMs: number,
  range: MediaTimeRange | null,
  signal: AbortSignal,
  options: { unitId?: string; openUnitId?: string; reselecting?: boolean } = {},
): Promise<ArchivePlayerSource> {
  const playback = await request<PlaybackResponse>('/api/playback', {
    method: 'POST',
    operation: 'session',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...archiveRequest(subject.id, atMs, range, options.unitId),
      ...(options.reselecting ? { gapPolicy: 'next-or-previous' } : {}),
      ...(options.openUnitId ? { openUnitId: options.openUnitId } : {}),
    }),
  });
  return { kind: 'archive', subject, playback, unitId: options.unitId };
}

export async function prepareArchiveContinuation(
  current: ArchivePlayerSource,
  window: MediaTimeRange,
  fixed: boolean,
  signal: AbortSignal,
): Promise<ArchivePlayerSource | null> {
  const end = current.playback.rangeToMs ?? current.playback.windowEndMs;
  const target = current.playback.nextAtMs;
  if (end === undefined || target == null) return null;
  const from = current.playback.rangeFromMs ?? window.fromMs;
  const to = current.playback.openUnitId ? Math.max(target + 1, window.toMs) : end;
  if (fixed && (to <= from || target >= to)) return null;
  try {
    return await openArchiveSource(
      current.subject,
      target,
      fixed ? { fromMs: from, toMs: to } : null,
      signal,
      {
        openUnitId: current.playback.openUnitId ?? undefined,
      },
    );
  } catch (cause) {
    if (signal.aborted || (cause instanceof ApiError && cause.message === 'coverage_gap'))
      return null;
    throw cause;
  }
}
