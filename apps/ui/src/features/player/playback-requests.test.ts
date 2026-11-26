import type { PlaybackResponse, Subject } from '@st-vault/api-schema';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError, request } from '../../shared/lib/api';
import { openArchiveSource, openLiveSource, prepareArchiveContinuation } from './playback-requests';

vi.mock(import('../../shared/lib/api'), async (original) => ({
  ...(await original()),
  request: vi.fn(),
}));

const subject = { id: 'test:42' } as Subject;
const signal = new AbortController().signal;
const range = { fromMs: 100, toMs: 200 };
const current = {
  kind: 'archive' as const,
  subject,
  playback: { rangeFromMs: 100, rangeToMs: 200, nextAtMs: 200 } as PlaybackResponse,
};
const read = vi.mocked(request);
function sentBody(call: number): unknown {
  const body = read.mock.calls[call][1]?.body;
  if (typeof body !== 'string') throw new Error('Expected a JSON request');
  return JSON.parse(body) as unknown;
}
beforeEach(() => {
  read.mockReset();
  read.mockResolvedValue({});
});

it('passes a live replacement lease only when replacing a previous stream', async () => {
  await openLiveSource(subject, signal);
  await openLiveSource(subject, signal, 'previous');
  expect(read.mock.calls).toEqual([
    [
      '/api/subjects/test%3A42/live',
      { method: 'POST', operation: 'session', signal, headers: undefined },
    ],
    [
      '/api/subjects/test%3A42/live',
      {
        method: 'POST',
        operation: 'session',
        signal,
        headers: { 'x-stv-replace-live': 'previous' },
      },
    ],
  ]);
});

it('retains the explicit unit and recovery gap policy for a deleted archive target', async () => {
  const reopened = await openArchiveSource(subject, 490, range, signal, {
    unitId: 'u',
    reselecting: true,
  });
  expect(reopened.unitId).toBe('u');
  expect(sentBody(0)).toEqual({
    subjectId: subject.id,
    targetUtcMs: 199,
    fromMs: 100,
    toMs: 200,
    unitId: 'u',
    gapPolicy: 'next-or-previous',
  });
  expect(read.mock.calls[0][1]?.signal).toBe(signal);
});

it('stops at a fixed end, extends an open unit, and keeps a following seek unbounded', async () => {
  expect(await prepareArchiveContinuation(current, range, true, signal)).toBeNull();
  expect(read).not.toHaveBeenCalled();
  const active = { ...current, playback: { ...current.playback, openUnitId: 'open' } };
  await prepareArchiveContinuation(active, range, true, signal);
  await prepareArchiveContinuation(active, range, false, signal);
  expect(read.mock.calls.map((_, call) => sentBody(call))).toEqual([
    {
      subjectId: subject.id,
      targetUtcMs: 200,
      fromMs: 100,
      toMs: 201,
      openUnitId: 'open',
      gapPolicy: 'next',
    },
    { subjectId: subject.id, targetUtcMs: 200, openUnitId: 'open', gapPolicy: 'next' },
  ]);
});

it('ends a continuation on a coverage gap and propagates unrelated errors', async () => {
  read.mockRejectedValueOnce(new ApiError('coverage_gap', 404));
  expect(await prepareArchiveContinuation(current, range, false, signal)).toBeNull();
  const offline = new Error('offline');
  read.mockRejectedValueOnce(offline);
  await expect(prepareArchiveContinuation(current, range, false, signal)).rejects.toBe(offline);
});
