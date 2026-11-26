import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openArchive } from './index.js';

it('retires whole batches without reclaiming init files until their final reference disappears', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-bulk-tombstones-'));
  let archive = await openArchive({ root });
  const subject = { id: 'stripchat:1', providerId: 1, handle: 'selected' };
  const other = { id: 'stripchat:2', providerId: 2, handle: 'unaffected' };
  const commit = (sequence: string, at: number | null, subjectId = subject.id) =>
    archive.commit({
      subjectId,
      sourceEpoch: 'one',
      sourceSequence: sequence,
      init: new Uint8Array([1, 2, 3]),
      bytes: new Uint8Array([4, 5]),
      durationSeconds: 2,
      wallStartMs: at,
      timeBasis: at === null ? 'unknown' : 'source-pdt',
      uncertaintyMs: null,
      discontinuity: false,
    });
  try {
    await archive.upsertSubjects([subject, other]);
    const first = await commit('1', 60000);
    const second = await commit('2', 62000);
    const later = await commit('3', 120000);
    const unlocated = await commit('4', null);
    const alsoUnlocated = await commit('5', null);
    const unrelated = await commit('1', 60000, other.id);
    expect(
      [second, later, unlocated, alsoUnlocated].map((segment) => segment.initObjectId),
    ).toEqual(Array(4).fill(first.initObjectId));
    expect(unrelated.initObjectId).not.toBe(first.initObjectId);

    await expect(archive.deleteRange(subject.id, 60000, 63000)).resolves.toMatchObject({
      deletedSegments: 2,
      reclaimedBytes: 4,
    });
    expect((await archive.coverage(subject.id, 60000, 120000, 1)).buckets[0]).toMatchObject({
      coveredMs: 0,
      segmentCount: 0,
    });
    expect(await archive.hasMedia([first.id])).toBe(false);
    expect(await archive.hasMedia([second.id])).toBe(false);
    expect(await archive.hasMedia([later.id, unrelated.id, first.initObjectId!])).toBe(true);
    await expect(archive.deleteRange(subject.id, 60000, 63000)).resolves.toEqual({
      deletedSegments: 0,
      reclaimedBytes: 0,
    });

    await expect(archive.deleteUnlocated(subject.id)).resolves.toEqual({
      deletedSegments: 2,
      reclaimedBytes: 4,
    });
    expect((await archive.timeline(subject.id, 0, 180000)).unlocatedCount).toBe(0);
    expect(await archive.hasMedia([first.initObjectId!])).toBe(true);
    await expect(archive.deleteRange(subject.id, 120000, 122000)).resolves.toMatchObject({
      deletedSegments: 1,
      reclaimedBytes: 5,
    });
    await archive.close();
    archive = await openArchive({
      root: path.join(root, 'recovered'),
      mediaRoot: path.join(root, 'media'),
    });
    expect(await archive.hasMedia([first.initObjectId!])).toBe(false);
    expect(await archive.hasMedia([unrelated.id, unrelated.initObjectId!])).toBe(true);
    expect((await archive.timeline(subject.id, 0, 180000)).segments).toEqual([]);
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
