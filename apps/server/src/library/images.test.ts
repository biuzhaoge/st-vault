import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { LibraryImages, removeSubjectLibraryImages } from './images.js';
import { subjectImagePath } from './paths.js';
import { AtomicDerivativeWriter } from '../previews/atomic-derivative.js';

it('keeps graphics when cleanup eligibility is revoked before unlinking', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-library-images-stale-'));
  const store = new LibraryImages(root, 'avatar');
  try {
    await store.put('avatar:stripchat:1', Buffer.from('current'));
    expect(
      await removeSubjectLibraryImages(root, 'stripchat:1', () => Promise.resolve(false)),
    ).toBe(false);
    expect(await store.get('avatar:stripchat:1')).toEqual(Buffer.from('current'));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('publishes independent portraits concurrently while preserving same-key order', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-library-images-parallel-'));
  const store = new LibraryImages(root, 'avatar', 4);
  const original = AtomicDerivativeWriter.prototype.write;
  let unblock!: () => void,
    started = false;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const writing = vi
    .spyOn(AtomicDerivativeWriter.prototype, 'write')
    .mockImplementation(async function (this: AtomicDerivativeWriter, destination, bytes, options) {
      if (destination.includes('stripchat-1/') && !started) {
        started = true;
        await gate;
      }
      return original.call(this, destination, bytes, options);
    });
  try {
    const first = store.put('avatar:stripchat:1', Buffer.from('one'));
    await vi.waitFor(() => expect(started).toBe(true));
    const replacement = store.put('avatar:stripchat:1', Buffer.from('new'));
    await expect(store.put('avatar:stripchat:2', Buffer.from('two'))).resolves.toBe(true);
    expect(await store.get('avatar:stripchat:2')).toEqual(Buffer.from('two'));
    unblock();
    await Promise.all([first, replacement]);
    expect(await store.get('avatar:stripchat:1')).toEqual(Buffer.from('new'));
  } finally {
    unblock();
    await store.close();
    writing.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('removes only the canonical images for one subject and can run again', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-library-image-remove-'));
  const avatar = subjectImagePath(root, 'stripchat:1', 'avatar');
  const cover = subjectImagePath(root, 'stripchat:1', 'cover');
  const fallback = subjectImagePath(root, 'stripchat:1', 'default-cover');
  const untouched = [
    subjectImagePath(root, 'stripchat:2', 'avatar'),
    path.join(path.dirname(cover), 'custom.img'),
    path.join(path.dirname(cover), '..', 'recordings', 'segment.m4s'),
    path.join(path.dirname(cover), '..', 'thumbnails', 'screenshot.jpg'),
  ];
  try {
    for (const file of [avatar, cover, fallback, ...untouched]) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'fixture');
    }
    await removeSubjectLibraryImages(root, 'stripchat:1');
    await removeSubjectLibraryImages(root, 'stripchat:1');
    await removeSubjectLibraryImages(root, 'stripchat:3');
    for (const file of [avatar, cover, fallback])
      await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const file of untouched) await expect(readFile(file, 'utf8')).resolves.toBe('fixture');
    await expect(removeSubjectLibraryImages(root, 'stripchat:1/../2')).rejects.toThrow(
      'INVALID_SUBJECT_ID',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([0, 1, 2, 3])('rejects a symbolic link at image directory level %i', async (level) => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-library-image-parent-'));
  const media = path.join(root, 'media');
  const image = subjectImagePath(media, 'stripchat:1', 'cover');
  const ancestors = [
    media,
    path.join(media, 'subjects'),
    path.dirname(path.dirname(image)),
    path.dirname(image),
  ];
  const link = ancestors[level];
  const outside = path.join(root, 'outside');
  const target = path.join(outside, path.relative(link, image));
  try {
    await mkdir(path.dirname(link), { recursive: true });
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'fixture');
    await symlink(outside, link, 'junction');
    await expect(removeSubjectLibraryImages(media, 'stripchat:1')).rejects.toThrow(
      'UNSAFE_LIBRARY_IMAGE_PATH',
    );
    await expect(readFile(target, 'utf8')).resolves.toBe('fixture');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects a canonical image symlink before removing sibling images', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-library-image-leaf-'));
  const avatar = subjectImagePath(root, 'stripchat:1', 'avatar');
  const cover = subjectImagePath(root, 'stripchat:1', 'cover');
  const outside = path.join(root, 'outside.img');
  try {
    await mkdir(path.dirname(avatar), { recursive: true });
    await writeFile(avatar, 'avatar');
    await writeFile(outside, 'outside');
    await symlink(outside, cover, 'file');
    await expect(removeSubjectLibraryImages(root, 'stripchat:1')).rejects.toThrow(
      'UNSAFE_LIBRARY_IMAGE_PATH',
    );
    await expect(readFile(avatar, 'utf8')).resolves.toBe('avatar');
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside');
    expect((await lstat(cover)).isSymbolicLink()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('removes a pending image write and rechecks a publication queued behind cleanup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-library-image-queued-'));
  const store = new LibraryImages(root, 'avatar');
  const original = AtomicDerivativeWriter.prototype.write;
  let started = false;
  let eligible = true;
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const writing = vi
    .spyOn(AtomicDerivativeWriter.prototype, 'write')
    .mockImplementation(async function (this: AtomicDerivativeWriter, destination, bytes, options) {
      started = true;
      await gate;
      return original.call(this, destination, bytes, options);
    });
  const mayPublish = () => Promise.resolve(eligible);
  try {
    const previous = store.put('avatar:stripchat:1', Buffer.from('previous'), mayPublish);
    await vi.waitFor(() => expect(started).toBe(true));
    eligible = false;
    const cleanup = removeSubjectLibraryImages(root, 'stripchat:1');
    const late = store.put('avatar:stripchat:1', Buffer.from('late'), mayPublish);
    unblock();
    await expect(previous).resolves.toBe(true);
    await cleanup;
    await expect(late).resolves.toBe(false);
    expect(writing).toHaveBeenCalledOnce();
    await expect(store.get('avatar:stripchat:1')).resolves.toBeNull();
  } finally {
    unblock();
    await store.close();
    writing.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('orders cleanup after a publication queued earlier in the same turn', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-library-image-order-'));
  const store = new LibraryImages(root, 'avatar');
  try {
    const previous = store.put('avatar:stripchat:1', Buffer.from('previous'));
    const cleanup = removeSubjectLibraryImages(root, 'stripchat:1');
    await expect(previous).resolves.toBe(true);
    await cleanup;
    await expect(store.get('avatar:stripchat:1')).resolves.toBeNull();
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});
