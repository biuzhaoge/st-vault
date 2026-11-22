// Run after the release build with the QA container's temporary PostgreSQL.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openArchive } from '../../build/apps/server/src/archive/index.js';
import { databaseSchema, SqlDatabase } from '../../build/apps/server/src/database/sql.js';
import { ScreenshotJobs } from '../../build/apps/server/src/previews/jobs.js';

const subjects = 1000;
const sampleMs = 10000;
const root = await mkdtemp(path.join(tmpdir(), 'stv-screenshot-idle-'));
const jobs = path.join(root, 'jobs');
const schema = databaseSchema(path.join(jobs, 'jobs'));
const originalPrepare = SqlDatabase.prototype.prepare;
const warmed = new Set();
const reads = {
  directory: 0,
  unitPages: 0,
  statistics: 0,
  invalidationCounts: 0,
  runnableJobs: 0,
};
let sampling = false;
SqlDatabase.prototype.prepare = function (sql) {
  if (sampling && this.schema === schema) {
    if (sql.includes('FROM job_statistics WHERE id=1')) reads.statistics++;
    if (sql.startsWith('SELECT COUNT(*) AS count FROM invalidations')) reads.invalidationCounts++;
    if (sql.startsWith("SELECT * FROM jobs WHERE state IN ('pending','failed')"))
      reads.runnableJobs++;
  }
  return originalPrepare.call(this, sql);
};
let archive;
let queue;
try {
  archive = await openArchive({ root: path.join(root, 'archive') });
  await archive.upsertSubjects(
    Array.from({ length: subjects }, (_, index) => ({
      id: `stripchat:${index + 1}`,
      providerId: index + 1,
      handle: `synthetic-${index + 1}`,
    })),
  );
  queue = await ScreenshotJobs.open({
    root: jobs,
    archive: {
      withBackgroundReads: archive.withBackgroundReads.bind(archive),
      locate: archive.locate.bind(archive),
      listSubjects(options) {
        if (sampling) reads.directory++;
        return archive.listSubjects(options);
      },
      async snapshotUnits(subject, cursor, limit) {
        if (sampling) reads.unitPages++;
        const page = await archive.snapshotUnits(subject, cursor, limit);
        assert.equal(page.items.length, 0);
        warmed.add(subject);
        return page;
      },
    },
    render: () => Promise.reject(new Error('SYNTHETIC_EMPTY_ARCHIVE')),
    validate: () => Promise.resolve(),
  });
  const warmupAt = performance.now();
  while (warmed.size < subjects && performance.now() - warmupAt < 45000) await delay(25);
  assert.equal(warmed.size, subjects, 'complete the initial empty rotation before sampling');
  const warmupMs = Math.round(performance.now() - warmupAt);
  await delay(350);
  sampling = true;
  await delay(sampleMs);
  sampling = false;
  console.log(JSON.stringify({ synthetic: true, subjects, warmupMs, sampleMs, reads }));
} finally {
  SqlDatabase.prototype.prepare = originalPrepare;
  try {
    await queue?.close();
  } finally {
    try {
      await archive?.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
