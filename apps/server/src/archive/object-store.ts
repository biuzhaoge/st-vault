import { createHash, randomUUID, webcrypto } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { MediaObject } from '../ports.js';
import {
  UUID,
  MAX_BYTES,
  subjectId,
  type ArchiveFaultPoint,
  type ObjectRecord,
} from './records.js';
import { TaskPool } from './task-pool.js';

export function fileErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validObject(value: unknown, id: string): value is ObjectRecord {
  if (!plain(value)) return false;
  return (
    typeof value.id === 'string' &&
    UUID.test(value.id) &&
    value.subjectId === id &&
    (value.kind === 'init' || value.kind === 'fragment') &&
    typeof value.filename === 'string' &&
    /^(?:\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])\/(?:[01]\d|2[0-3])|unlocated)\/$/.test(
      value.filename.slice(0, value.filename.lastIndexOf('/') + 1),
    ) &&
    path.posix.basename(value.filename) ===
      `${value.kind === 'init' ? 'init' : 'seg'}-${value.id}.${value.kind === 'init' ? 'mp4' : 'm4s'}` &&
    value.filename.split('/').every((part: string) => part !== '..' && !part.includes('\\')) &&
    typeof value.bytes === 'number' &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    value.bytes <= MAX_BYTES &&
    typeof value.hash === 'string' &&
    /^[0-9a-f]{64}$/.test(value.hash)
  );
}
export async function syncDirectory(dir: string): Promise<void> {
  // Windows does not expose POSIX directory fsync through Node. File fsync is
  // still enforced; power-loss rename durability is explicitly a platform limit.
  if (process.platform === 'win32') return;
  const file = await open(dir, constants.O_RDONLY);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

interface ReclaimResult {
  reclaimedBytes: number;
  unlinkMs: number;
  directorySyncMs: number;
}

export class MediaObjectStore {
  private readonly hashPool: TaskPool;
  private readonly verified = new Map<string, string>();

  constructor(
    private readonly root: string,
    hashConcurrency: number,
    private readonly fault?: (point: ArchiveFaultPoint) => void | Promise<void>,
  ) {
    this.hashPool = new TaskPool(hashConcurrency);
  }

  async discoverSubjects(): Promise<Set<string>> {
    const mediaRoot = path.join(this.root, 'subjects');
    const created = await mkdir(mediaRoot, { recursive: true });
    if ((await lstat(mediaRoot)).isSymbolicLink()) throw new Error('UNSAFE_ARCHIVE_PATH');
    if (created !== undefined) await syncDirectory(this.root);
    const subjects = new Set<string>();
    for await (const entry of await opendir(mediaRoot)) {
      if (!/^stripchat-[1-9]\d*$/.test(entry.name)) continue;
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('UNSAFE_ARCHIVE_PATH');
      const id = `stripchat:${entry.name.slice(10)}`;
      subjects.add(id);
    }
    return subjects;
  }

  hash(bytes: Uint8Array): Promise<string> {
    // WebCrypto copies the input into bounded native work; never detach the
    // immutable buffer that the live and recording consumers still share.
    return this.hashPool.run(async () => {
      const source =
        bytes.buffer instanceof ArrayBuffer
          ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
          : new Uint8Array(bytes);
      return Buffer.from(await webcrypto.subtle.digest('SHA-256', source)).toString('hex');
    });
  }

  async directory(id: string): Promise<string> {
    const subject = path.join(this.root, 'subjects', `stripchat-${subjectId(id)}`);
    const dir = path.join(subject, 'recordings');
    for (const candidate of [path.join(this.root, 'subjects'), subject, dir]) {
      const created = await mkdir(candidate, { recursive: true });
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('UNSAFE_ARCHIVE_PATH');
      if (created !== undefined) await syncDirectory(path.dirname(candidate));
    }
    return dir;
  }
  private async objectPath(object: ObjectRecord): Promise<string> {
    if (!validObject(object, object.subjectId)) throw new Error('INVALID_OBJECT_REFERENCE');
    const dir = await this.objectDirectory(object.subjectId, object.filename);
    const file = path.join(dir, path.posix.basename(object.filename));
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (await realpath(file)) !== file)
      throw new Error('UNSAFE_MEDIA_PATH');
    return file;
  }
  private async objectDirectory(id: string, filename: string, create = false): Promise<string> {
    let dir = await this.directory(id);
    for (const part of filename.split('/').slice(0, -1)) {
      const parent = dir;
      dir = path.join(dir, part);
      if (create) {
        const created = await mkdir(dir, { recursive: false }).then(
          () => true,
          (error: unknown) => {
            if (fileErrorCode(error) !== 'EEXIST') throw error;
            return false;
          },
        );
        if (created) await syncDirectory(parent);
      }
      const info = await lstat(dir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('UNSAFE_ARCHIVE_PATH');
    }
    return dir;
  }
  async write(
    id: string,
    bytes: Uint8Array,
    kind: ObjectRecord['kind'],
    bucket: string,
  ): Promise<ObjectRecord> {
    await this.fault?.('before-object-write');
    const objectId = randomUUID();
    const object: ObjectRecord = {
      id: objectId,
      subjectId: id,
      filename: `${bucket}/${kind === 'init' ? 'init' : 'seg'}-${objectId}.${kind === 'init' ? 'mp4' : 'm4s'}`,
      bytes: bytes.byteLength,
      hash: await this.hash(bytes),
      kind,
    };
    const dir = await this.directory(id);
    const destination = await this.objectDirectory(id, object.filename, true);
    const staging = path.join(dir, '.staging');
    await mkdir(staging, { recursive: true });
    if ((await lstat(staging)).isSymbolicLink()) throw new Error('UNSAFE_ARCHIVE_PATH');
    const temporary = path.join(staging, `${objectId}.tmp`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path.join(destination, path.posix.basename(object.filename)));
    await syncDirectory(destination);
    await this.fault?.('after-object-rename');
    return object;
  }
  async verify(object: ObjectRecord): Promise<void> {
    const filename = await this.objectPath(object);
    const file = await open(filename, 'r');
    try {
      const info = await file.stat();
      if (info.size !== object.bytes) throw new Error('MEDIA_INTEGRITY_FAILED');
      const digest = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      for (;;) {
        const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        if (position > object.bytes) throw new Error('MEDIA_INTEGRITY_FAILED');
        digest.update(buffer.subarray(0, bytesRead));
      }
      if (position !== object.bytes || digest.digest('hex') !== object.hash)
        throw new Error('MEDIA_INTEGRITY_FAILED');
    } finally {
      await file.close();
    }
  }

  async media(object: ObjectRecord): Promise<MediaObject | null> {
    try {
      const filename = await this.objectPath(object);
      const info = await stat(filename, { bigint: true });
      if (Number(info.size) !== object.bytes) throw new Error('MEDIA_INTEGRITY_FAILED');
      const signature = `${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
      if (this.verified.get(object.id) !== signature) {
        await this.verify(object);
        if (this.verified.size >= 1024)
          this.verified.delete(this.verified.keys().next().value ?? '');
        this.verified.set(object.id, signature);
      }
      return { path: filename, bytes: object.bytes, contentType: 'video/mp4' };
    } catch (error) {
      if (fileErrorCode(error) === 'ENOENT') return null;
      throw error;
    }
  }

  async discard(object: ObjectRecord): Promise<void> {
    await unlink(await this.objectPath(object));
  }

  async reclaimBatch(objects: readonly ObjectRecord[], io: TaskPool): Promise<ReclaimResult> {
    const checked = new Map<string, Promise<string>>();
    const directories = new Set<string>();
    // Share only per-batch parent checks. Each file still has to resolve to its
    // exact catalog path before it can be unlinked.
    const existingDirectory = (directory: string): Promise<string> => {
      const cached = checked.get(directory);
      if (cached) return cached;
      const inspected = (async () => {
        const parent = path.dirname(directory);
        if (directory !== this.root) {
          const existingParent = await existingDirectory(parent);
          if (existingParent !== parent) return existingParent;
        }
        try {
          const info = await lstat(directory);
          if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('UNSAFE_ARCHIVE_PATH');
          return directory;
        } catch (error) {
          if (directory === this.root || fileErrorCode(error) !== 'ENOENT') throw error;
          return parent;
        }
      })();
      checked.set(directory, inspected);
      return inspected;
    };
    const started = performance.now();
    let reclaimedBytes = 0;
    let failed = false;
    const removals = await Promise.allSettled(
      objects.map((object) =>
        io.run(async () => {
          if (failed) return;
          try {
            if (!validObject(object, object.subjectId)) throw new Error('INVALID_OBJECT_REFERENCE');
            const directory = path.join(
              this.root,
              'subjects',
              `stripchat-${subjectId(object.subjectId)}`,
              'recordings',
              path.posix.dirname(object.filename),
            );
            const existing = await existingDirectory(directory);
            // Missing files may have been unlinked before a previous attempt's
            // directory sync. Sync the current parent before confirming absence.
            directories.add(existing);
            if (existing !== directory) return;
            const bytes = await this.reclaimFile(
              path.join(directory, path.posix.basename(object.filename)),
            );
            reclaimedBytes += bytes;
          } catch (error) {
            failed = true;
            throw error;
          }
        }),
      ),
    );
    const syncing = performance.now();
    const syncs = await Promise.allSettled(
      [...directories].map((directory) => io.run(async () => await syncDirectory(directory))),
    );
    const errors = [...removals, ...syncs].flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length)
      throw new AggregateError(
        errors,
        errors[0] instanceof Error ? errors[0].message : 'ARCHIVE_GC_BATCH_FAILED',
        { cause: errors[0] },
      );
    return {
      reclaimedBytes,
      unlinkMs: syncing - started,
      directorySyncMs: performance.now() - syncing,
    };
  }

  private async reclaimFile(filename: string): Promise<number> {
    let info: Stats;
    try {
      info = await lstat(filename);
      if (!info.isFile() || info.isSymbolicLink() || (await realpath(filename)) !== filename)
        throw new Error('UNSAFE_MEDIA_PATH');
    } catch (error) {
      if (fileErrorCode(error) === 'ENOENT') return 0;
      throw error;
    }
    await this.fault?.('before-unlink');
    try {
      await unlink(filename);
    } catch (error) {
      if (fileErrorCode(error) === 'ENOENT') return 0;
      throw error;
    }
    await this.fault?.('after-unlink');
    return info.size;
  }
}
