import { lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { subjectImagePath, type SubjectImageKind } from './paths.js';
import { syncDirectory } from './files.js';
import { AtomicDerivativeWriter } from '../previews/atomic-derivative.js';
import { DerivativeDiagnostics, ioCode } from '../previews/derivative-diagnostics.js';
import { MediaBudget } from '../provider/media-budget.js';

const canonicalKinds: readonly SubjectImageKind[] = ['avatar', 'cover', 'default-cover'];
const imageWork = new Map<string, Promise<unknown>>();

function serializeImages<T>(filenames: string[], operation: () => Promise<T>): Promise<T> {
  const keys = filenames.map((filename) => path.resolve(filename));
  const pending = keys.map((key) => imageWork.get(key)).filter((task) => task !== undefined);
  // Each caller owns its error. A rejected predecessor must not strand a later operation.
  const task = Promise.allSettled(pending).then(operation);
  for (const key of keys) imageWork.set(key, task);
  return task.finally(() => {
    for (const key of keys) if (imageWork.get(key) === task) imageWork.delete(key);
  });
}

async function existingEntry(filename: string) {
  try {
    return await lstat(filename);
  } catch (error) {
    if (ioCode(error) !== 'ENOENT') throw error;
    return null;
  }
}

/** Reclaim only the generated portrait and covers for an exact library subject. */
export async function removeSubjectLibraryImages(
  mediaRoot: string,
  id: string,
  canRemove?: () => Promise<boolean>,
): Promise<boolean> {
  const root = path.resolve(mediaRoot);
  const files = canonicalKinds.map((kind) => subjectImagePath(root, id, kind));
  const directory = path.dirname(files[0]);
  return serializeImages(files, async () => {
    if (canRemove && !(await canRemove())) return false;
    for (const parent of [root, path.join(root, 'subjects'), path.dirname(directory), directory]) {
      const info = await existingEntry(parent);
      if (!info) return true;
      if (!info.isDirectory() || info.isSymbolicLink()) throw Error('UNSAFE_LIBRARY_IMAGE_PATH');
    }
    if ((await realpath(directory)) !== directory) throw Error('UNSAFE_LIBRARY_IMAGE_PATH');
    const existing: string[] = [];
    for (const filename of files) {
      const entry = await existingEntry(filename);
      if (!entry) continue;
      if (!entry.isFile() || entry.isSymbolicLink()) throw Error('UNSAFE_LIBRARY_IMAGE_PATH');
      existing.push(filename);
    }
    try {
      for (const filename of existing) {
        try {
          await unlink(filename);
        } catch (error) {
          if (ioCode(error) !== 'ENOENT') throw error;
        }
      }
    } finally {
      // A retry after interruption must also make an already-empty directory durable.
      syncDirectory(directory);
    }
    return true;
  });
}

/** Canonical library images are addressed directly, never LRU-evicted or recursively indexed. */
export class LibraryImages {
  private readonly diagnostics = new DerivativeDiagnostics();
  private readonly writer: AtomicDerivativeWriter;
  private readonly pending = new Set<Promise<boolean>>();
  private readonly budget: MediaBudget;
  private closed = false;
  constructor(
    private readonly mediaRoot: string,
    private readonly kind: SubjectImageKind,
    concurrency = 4,
  ) {
    this.budget = new MediaBudget(concurrency);
    this.writer = new AtomicDerivativeWriter(
      path.join(mediaRoot, 'subjects'),
      'library',
      this.diagnostics,
      kind,
    );
  }
  private filename(key: string): string {
    const match =
      this.kind === 'avatar'
        ? /^avatar:stripchat:([1-9]\d*)$/.exec(key)
        : /^cover:([1-9]\d*)$/.exec(key);
    if (!match) throw Error('INVALID_IMAGE_KEY');
    return subjectImagePath(this.mediaRoot, `stripchat:${match[1]}`, this.kind);
  }
  async get(key: string, maxAgeMs = Infinity): Promise<Uint8Array | null> {
    if (this.closed) return null;
    try {
      const filename = this.filename(key),
        info = await lstat(filename);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (await realpath(filename)) !== path.resolve(filename) ||
        info.size > 512 * 1024 ||
        Date.now() - info.mtimeMs > maxAgeMs
      )
        return null;
      const file = await open(filename, 'r');
      try {
        const actual = await file.stat();
        if (actual.ino !== info.ino || actual.dev !== info.dev || actual.size !== info.size)
          return null;
        return await file.readFile();
      } finally {
        await file.close();
      }
    } catch (error) {
      if (ioCode(error) !== 'ENOENT') this.diagnostics.record('library_image_read_failed', error);
      return null;
    }
  }
  put(key: string, bytes: Uint8Array, canPublish?: () => Promise<boolean>): Promise<boolean> {
    if (this.closed || !bytes.length || bytes.length > 512 * 1024) return Promise.resolve(false);
    let filename: string;
    try {
      filename = this.filename(key);
    } catch (error) {
      this.diagnostics.record('library_image_write_failed', error);
      return Promise.resolve(false);
    }
    const task = serializeImages([filename], async () => {
      const release = await this.budget.acquire(new AbortController().signal);
      try {
        if (canPublish && !(await canPublish())) return false;
        await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
        for (
          let parent = path.dirname(filename);
          parent !== path.dirname(this.mediaRoot);
          parent = path.dirname(parent)
        ) {
          const info = await lstat(parent);
          if (!info.isDirectory() || info.isSymbolicLink())
            throw Error('UNSAFE_LIBRARY_IMAGE_PATH');
        }
        await this.writer.write(filename, bytes, { sync: true });
        return true;
      } finally {
        release();
      }
    })
      .catch((error: unknown) => {
        this.diagnostics.record('library_image_write_failed', error);
        return false;
      })
      .finally(() => {
        this.pending.delete(task);
      });
    this.pending.add(task);
    return task;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.pending);
    await this.writer.close();
    this.diagnostics.close();
  }
}
