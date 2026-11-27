import type { PublicStatus, Subject } from '@st-vault/api-schema';
import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { useSyncClock } from '../../shared/lib/sync';
import type * as TileModule from './MonitorTile';
import { MonitorWall, releaseMonitorStreams } from './MonitorWall';

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useLayoutEffect: () => undefined,
}));
vi.mock('../../shared/lib/sync', () => ({
  useSyncClock: vi.fn(),
}));
vi.mock('./MonitorTile', async (importOriginal) => ({
  ...(await importOriginal<typeof TileModule>()),
  MonitorTile: ({ subject }: { subject: Subject }) => (
    <article data-subject={subject.id}>{subject.handle}</article>
  ),
}));

const noop = (): void => undefined;
function subject(id: number, providerStatus: PublicStatus, onlineSinceMs: number): Subject {
  return {
    id: `stripchat:${id}`,
    providerId: id,
    handle: `room-${id}`,
    monitorEnabled: true,
    autoRecord: false,
    captureState: 'IDLE',
    providerStatus,
    observedAtMs: null,
    onlineSinceMs,
  };
}
function wall(subjects: Subject[]): string {
  return renderToStaticMarkup(
    <MonitorWall subjects={subjects} onClose={noop} onUnauthorized={noop} />,
  );
}
function tileOrder(html: string): string[] {
  return Array.from(html.matchAll(/data-subject="([^"\s]+)"/g), (match) => match[1]);
}

it('uses public-first online ordering and removes a room when its status goes offline', () => {
  const publicOld = subject(1, 'PUBLIC', 1000);
  const publicNew = subject(2, 'PUBLIC', 2000);
  const privateOld = subject(3, 'PRIVATE', 1500);
  const privateNew = subject(4, 'PRIVATE', 3000);
  const archived = { ...subject(5, 'PUBLIC', 5000), archived: true };
  const offline = subject(6, 'OFFLINE', 8000);
  expect(
    tileOrder(wall([privateNew, publicOld, offline, archived, privateOld, publicNew])),
  ).toEqual(['stripchat:2', 'stripchat:1', 'stripchat:4', 'stripchat:3']);
  expect(
    tileOrder(wall([publicOld, { ...privateNew, providerStatus: 'OFFLINE' }, privateOld])),
  ).toEqual(['stripchat:1', 'stripchat:3']);
});

it('offers a direct return when no rooms are online', () => {
  const html = wall([subject(1, 'OFFLINE', 0)]);
  expect(html).toContain('返回工作台');
  expect(html).toContain('暂无在线主播');
  expect(tileOrder(html)).toEqual([]);
});

it('names the monitor region without a separate heading and keeps a native return button', () => {
  const html = wall([subject(1, 'PUBLIC', 1000)]);
  expect(html).toMatch(/<section[^>]*aria-label="监控墙"/);
  expect(html).not.toMatch(/<h[1-6][\s>]/);
  expect(html).toMatch(/<button[^>]*type="button"[^>]*class="monitor-wall-return"/);
  expect(html).toMatch(/返回工作台<\/button>/);
});

it('uses one synchronization heartbeat for all visible monitor covers', () => {
  vi.mocked(useSyncClock).mockClear();
  wall([subject(1, 'PUBLIC', 1000), subject(2, 'PRIVATE', 2000)]);
  expect(useSyncClock).toHaveBeenCalledOnce();
  expect(useSyncClock).toHaveBeenCalledWith(expect.any(Function), true);
});

it('starts every release immediately and waits for the remaining streams after a failure', async () => {
  let finish: () => void = noop;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const error = new Error('stream release failed');
  const broken = vi.fn(() => {
    throw error;
  });
  const slow = vi.fn(() => pending);
  const warn = vi.spyOn(console, 'warn').mockImplementation(noop);
  try {
    const released = vi.fn();
    const returnReady = releaseMonitorStreams([broken, slow]).then(() => {
      released();
    });
    expect(broken).toHaveBeenCalledOnce();
    expect(slow).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(released).not.toHaveBeenCalled();
    finish();
    await returnReady;
    expect(released).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith('Monitor wall stream release failed', error);
  } finally {
    warn.mockRestore();
  }
});
