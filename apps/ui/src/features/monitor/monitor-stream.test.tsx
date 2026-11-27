import type { Subject } from '@st-vault/api-schema';
import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from '../../shared/lib/api';
import { useSyncClock } from '../../shared/lib/sync';
import type * as Sync from '../../shared/lib/sync';
import { closeSource, type PlayerSource } from '../player/MediaSlot';
import type * as MediaSlotModule from '../player/MediaSlot';
import { openLiveSource } from '../player/playback-requests';
import { MonitorCoverRefresh, MonitorTile } from './MonitorTile';
import {
  isMonitorOpenConnectionFailure,
  monitorConnectionRetryAt,
  startMonitorStream,
} from './monitor-stream';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useLayoutEffect: () => undefined,
}));
vi.mock('../../shared/lib/sync', async (importOriginal) => ({
  ...(await importOriginal<typeof Sync>()),
  useSyncClock: vi.fn(),
}));
vi.mock('../directory/CoverImage', () => ({
  CoverImage: ({ id, revision }: { id: string; revision: number }) => (
    <span data-cover={id} data-revision={revision} />
  ),
}));
vi.mock('../player/MediaSlot', async (importOriginal) => ({
  ...(await importOriginal<typeof MediaSlotModule>()),
  closeSource: vi.fn(() => Promise.resolve()),
}));
vi.mock('../player/playback-requests', () => ({ openLiveSource: vi.fn() }));

const subject: Subject = {
  id: 'stripchat:42',
  providerId: 42,
  handle: 'Room 42',
  monitorEnabled: true,
  autoRecord: false,
  providerStatus: 'PUBLIC',
  observedAtMs: null,
};
const stream: PlayerSource = {
  kind: 'live',
  stream: {
    sessionId: 'abc123',
    manifestUrl: '/api/live/abc123/manifest.m3u8',
    expiresAtMs: 10000,
    quality: { height: 720, bandwidth: 1000 },
  },
  subject,
};

beforeEach(() => vi.resetAllMocks());

it('admits exactly three automatic connection retries and honors the server deadline', () => {
  const now = 10000;
  expect([0, 1, 2, 3, 4].map((used) => monitorConnectionRetryAt(used, 0, now))).toEqual([
    11000,
    12000,
    14000,
    undefined,
    undefined,
  ]);
  expect(monitorConnectionRetryAt(1, 18000, now)).toBe(18000);
});

it('only treats transient open errors as connection failures', () => {
  for (const cause of [
    new TypeError('Failed to fetch'),
    new DOMException('Request timed out', 'TimeoutError'),
    new ApiError('live_unavailable', 503, 'source'),
    new ApiError('request throttled', 429),
    new ApiError('request timeout', 408),
  ])
    expect(isMonitorOpenConnectionFailure(cause)).toBe(true);
  for (const cause of [
    new ApiError('live_busy', 429),
    new ApiError('unauthorized', 401),
    new ApiError('live_not_public', 409, 'private'),
    new ApiError('live_not_public', 409, 'offline'),
    new ApiError('live_unavailable', 503, 'keys'),
    new ApiError('live_unavailable', 503, 'status-unknown'),
    new DOMException('Request cancelled', 'AbortError'),
  ])
    expect(isMonitorOpenConnectionFailure(cause)).toBe(false);
});

it('labels a private tile while displaying the existing private-playback notice', () => {
  const html = renderToStaticMarkup(
    <MonitorTile
      subject={{ ...subject, providerStatus: 'PRIVATE' }}
      onUnauthorized={vi.fn()}
      registerStream={vi.fn()}
    />,
  );
  expect(html).toContain('data-subject-id="stripchat:42"');
  expect(html).toContain('class="monitor-tile-name"');
  expect(html).toContain('主播已转入非公开直播');
  expect(html).not.toContain('<video');
  expect(openLiveSource).not.toHaveBeenCalled();
});

it('passes an advanced shared revision to waiting and private covers', () => {
  vi.mocked(useSyncClock).mockImplementationOnce((notify) => notify(1000));
  const handlers = { onUnauthorized: vi.fn(), registerStream: vi.fn() };
  const html = renderToStaticMarkup(
    <MonitorCoverRefresh enabled>
      <MonitorTile subject={subject} {...handlers} />
      <MonitorTile
        subject={{ ...subject, id: 'stripchat:43', providerId: 43, providerStatus: 'PRIVATE' }}
        {...handlers}
      />
    </MonitorCoverRefresh>,
  );
  expect(html).toContain('data-cover="stripchat:42" data-revision="1"');
  expect(html).toContain('data-cover="stripchat:43" data-revision="1"');
});

it('skips a request when its tile closes before the queued effect starts', async () => {
  const stop = startMonitorStream(subject, vi.fn(), vi.fn());
  await stop();
  expect(openLiveSource).not.toHaveBeenCalled();
});

it('waits for the adopted session DELETE and reuses the same completion on repeated close', async () => {
  vi.mocked(openLiveSource).mockResolvedValue(stream);
  let acknowledge!: () => void;
  vi.mocked(closeSource).mockReturnValue(new Promise<void>((resolve) => (acknowledge = resolve)));
  const opened = vi.fn();
  const stop = startMonitorStream(subject, opened, vi.fn());
  await Promise.resolve();
  await Promise.resolve();
  expect(opened).toHaveBeenCalledWith(stream);
  const release = stop(true);
  expect(stop()).toBe(release);
  const completed = vi.fn();
  void release.then(completed);
  await Promise.resolve();
  expect(closeSource).toHaveBeenCalledTimes(1);
  expect(closeSource).toHaveBeenCalledWith(stream, true);
  expect(completed).not.toHaveBeenCalled();
  acknowledge();
  await release;
  expect(completed).toHaveBeenCalledOnce();
});

it('waits for the open and releases a late stream received after its tile was removed', async () => {
  let reply!: (value: PlayerSource) => void;
  vi.mocked(openLiveSource).mockReturnValue(new Promise((resolve) => (reply = resolve)));
  const opened = vi.fn(),
    failed = vi.fn();
  const stop = startMonitorStream(subject, opened, failed);
  await Promise.resolve();
  const signal = vi.mocked(openLiveSource).mock.calls[0][1];
  const release = stop();
  const completed = vi.fn();
  void release.then(completed);
  await Promise.resolve();
  expect(signal.aborted).toBe(false);
  expect(completed).not.toHaveBeenCalled();
  reply(stream);
  await release;
  expect(opened).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
  expect(closeSource).toHaveBeenCalledExactlyOnceWith(stream, false);
});

it('aborts an in-flight open on page exit and uses keepalive if it still receives a lease', async () => {
  let reply!: (value: PlayerSource) => void;
  vi.mocked(openLiveSource).mockReturnValue(new Promise((resolve) => (reply = resolve)));
  const opened = vi.fn();
  const stop = startMonitorStream(subject, opened, vi.fn());
  await Promise.resolve();
  const signal = vi.mocked(openLiveSource).mock.calls[0][1];
  const release = stop();
  expect(stop(true)).toBe(release);
  expect(signal.aborted).toBe(true);
  reply(stream);
  await release;
  expect(opened).not.toHaveBeenCalled();
  expect(closeSource).toHaveBeenCalledExactlyOnceWith(stream, true);
});
