import { mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openArchive, type ArchiveOptions } from './index.js';
import { MediaObjectStore } from './object-store.js';
import { TaskPool } from './task-pool.js';

it('reopens archived init and fragment bytes and removes only the specified object', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-media-store-'));
  try {
    const writer = new MediaObjectStore(root, 1);
    const id = 'stripchat:42';
    const initBytes = Uint8Array.of(1, 2, 3);
    const fragmentBytes = Uint8Array.of(4, 5, 6, 7);
    const init = await writer.write(id, initBytes, 'init', 'unlocated');
    const fragment = await writer.write(id, fragmentBytes, 'fragment', '2026-11-25/12');

    const reader = new MediaObjectStore(root, 1);
    expect([...(await reader.discoverSubjects())]).toEqual([id]);
    const media = await reader.media(fragment);
    expect(media).toMatchObject({ bytes: fragmentBytes.length, contentType: 'video/mp4' });
    expect(await readFile(media!.path)).toEqual(Buffer.from(fragmentBytes));
    await reader.verify(init);

    const removed = await reader.reclaimBatch([fragment], new TaskPool(1));
    expect(removed.reclaimedBytes).toBe(fragmentBytes.length);
    expect(await reader.media(fragment)).toBeNull();
    expect(await reader.media(init)).toMatchObject({ bytes: initBytes.length });
    await reader.discard(init);
    expect(await reader.media(init)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rechecks paths after a partial unlink and reclaims only the remaining file bytes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-media-reclaim-'));
  try {
    let interrupted = true;
    const store = new MediaObjectStore(root, 1, (point) => {
      if (point === 'after-unlink' && interrupted) {
        interrupted = false;
        throw new Error('simulated interruption after unlink');
      }
    });
    const id = 'stripchat:42';
    const bucket = '2026-11-25/12';
    const first = await store.write(id, Uint8Array.of(1), 'fragment', bucket);
    const second = await store.write(id, Uint8Array.of(2, 3), 'fragment', bucket);
    const unrelated = await store.write(id, Uint8Array.of(4), 'fragment', bucket);
    const io = new TaskPool(1);

    await expect(store.reclaimBatch([first, second], io)).rejects.toThrow(
      'simulated interruption after unlink',
    );
    expect(await store.media(first)).toBeNull();
    expect(await store.media(second)).not.toBeNull();

    const resumed = await store.reclaimBatch([first, second], io);
    expect(resumed.reclaimedBytes).toBe(second.bytes);
    expect(await store.media(second)).toBeNull();
    expect(await store.media(unrelated)).not.toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects a symlinked recording bucket and leaves the target untouched', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-media-reclaim-path-'));
  try {
    const store = new MediaObjectStore(root, 1);
    const id = 'stripchat:42';
    const bytes = Uint8Array.of(1, 2, 3);
    const object = await store.write(id, bytes, 'fragment', '2026-11-25/12');
    const file = (await store.media(object))!.path;
    const directory = path.dirname(file);
    const external = path.join(root, 'different-bucket');
    await rename(directory, external);
    await symlink(external, directory, 'junction');

    await expect(store.reclaimBatch([object], new TaskPool(1))).rejects.toThrow(
      'UNSAFE_ARCHIVE_PATH',
    );
    expect(await readFile(path.join(external, path.basename(file)))).toEqual(Buffer.from(bytes));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('uses the current archive fault hook for object writes after opening', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-object-fault-'));
  const options: ArchiveOptions = { root };
  const archive = await openArchive(options);
  try {
    const subjectId = 'stripchat:42';
    await archive.upsertSubjects([{ id: subjectId, providerId: 42, handle: 'fixture' }]);
    options.fault = (point) => {
      if (point === 'before-object-write') throw new Error('simulated write failure');
    };
    await expect(
      archive.commit({
        subjectId,
        sourceEpoch: 'fixture',
        sourceSequence: '1',
        init: null,
        bytes: Uint8Array.of(9),
        durationSeconds: 1,
        wallStartMs: 60000,
        timeBasis: 'source-pdt',
        uncertaintyMs: 0,
        discontinuity: false,
      }),
    ).rejects.toThrow('simulated write failure');
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
