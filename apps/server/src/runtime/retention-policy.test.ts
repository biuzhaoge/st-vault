import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openArchive, type ArchiveFaultPoint } from '../archive/index.js';
import { ResourceMonitor } from './resources.js';
import { SettingsStore } from './settings.js';

const day = 86400000;
const subject = { id: 'stripchat:42', providerId: 42, handle: 'retention' };

it.each([
  { pause: 'before-journal-write', count: 1, days: 0 },
  { pause: 'before-journal-write', count: 1, days: 7 },
  { pause: 'after-tombstone-commit', count: 129, days: 0 },
] as const)(
  'honors a saved $days-day retention policy at $pause',
  async ({ pause, count, days }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'stv-retention-policy-'));
    let paused!: () => void, resume!: () => void;
    const reached = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let armed = false;
    const archive = await openArchive({
      root,
      fault: async (point: ArchiveFaultPoint) => {
        if (armed && point === pause) {
          armed = false;
          paused();
          await gate;
        }
      },
    });
    const store = await SettingsStore.open(archive, {
      STV_RETENTION_DAYS: '1',
      STV_MIN_FREE_BYTES: '0',
    });
    let now = 3 * day;
    const monitor = new ResourceMonitor({ root, archive, settings: store.get, now: () => now });
    const timeline = () => archive.timeline(subject.id, 0, day);
    try {
      await archive.upsertSubjects([subject]);
      for (let n = 1; n <= count; n++) {
        await archive.commit({
          subjectId: subject.id,
          sourceEpoch: 'retention',
          sourceSequence: String(n),
          init: null,
          bytes: Uint8Array.of(n),
          durationSeconds: 1,
          wallStartMs: n * 60000,
          timeBasis: 'source-pdt',
          uncertaintyMs: null,
          discontinuity: false,
        });
      }
      const last = (await timeline()).segments.at(-1)!;
      const file = (await archive.media(last.mediaObjectId))!.path;
      armed = true;
      const sweep = monitor.check();
      await Promise.race([
        reached,
        sweep.then(() => {
          throw Error('retention missed the test barrier');
        }),
      ]);
      await store.update({ retentionDays: days });
      expect((await SettingsStore.open(archive, {})).get().retentionDays).toBe(days);
      resume();
      await sweep;
      expect((await timeline()).segments.map((segment) => segment.sourceSequence)).toEqual([
        String(count),
      ]);
      expect(await readFile(file)).toEqual(Buffer.from([count]));
      if (days === 0) {
        expect((await archive.deleteRange(subject.id, 0, day)).deletedSegments).toBe(1);
      } else {
        await store.update({ retentionDays: 1 });
        now += 60001;
        await monitor.check();
      }
      expect((await timeline()).segments).toHaveLength(0);
    } finally {
      resume();
      await monitor.close();
      await archive.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60000,
);
