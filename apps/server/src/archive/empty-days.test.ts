import { afterAll, beforeAll, expect, it } from 'vitest';
import { initializeBaseSchema } from '../database/catalog-schema.js';
import { startTestPostgres, type TestPostgresServer } from '../database/postgres.test-support.js';
import { openTestDatabase } from './postgres.test-support.js';
import { EventStore } from './events-store.js';
import { pruneEmptyHistory, readEmptyDays } from './empty-days.js';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => await postgres.close());

const left = Date.parse('2026-03-07T05:00:00Z');
const empty = Date.parse('2026-03-08T05:00:00Z');
const right = Date.parse('2026-03-09T04:00:00Z');
const now = Date.parse('2026-03-10T12:00:00Z');

async function fixture() {
  const db = await openTestDatabase();
  await initializeBaseSchema(db, left);
  const events = new EventStore(db);
  await events.initialize();
  await db.exec(
    "INSERT INTO subjects(id,provider_id,handle) VALUES('stripchat:1',1,'a'),('stripchat:2',2,'b')",
  );
  const clip = async (id: string, subject: string, from: number, to: number, deleted = 0) => {
    await db
      .prepare(
        'INSERT INTO segments(id,subject,epoch,sequence,media,start,"end",deleted,json) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(id, subject, 'e', id, id, from, to, deleted, '{}');
  };
  return { db, events, clip };
}

it('checks all broadcasters at deployment midnight and leaves an empty current day visible', async () => {
  const { db, clip } = await fixture();
  try {
    await clip('first', 'stripchat:1', left + 1000, left + 3000);
    await clip('last', 'stripchat:2', right, right + 3000);
    await clip('deleted', 'stripchat:2', empty + 1000, empty + 3000, 1);
    const gaps = () => readEmptyDays(db, 'America/New_York', left, now);
    expect(await gaps()).toEqual([{ fromMs: empty, toMs: right }]);
    await clip('cross', 'stripchat:2', right - 8_000, right + 8_000);
    expect(await gaps()).toEqual([]);
  } finally {
    await db.close();
  }
});

it('respects the ISO sign for a deployment zone given as a UTC offset', async () => {
  const { db } = await fixture();
  try {
    const start = Date.parse('2026-03-08T18:30:00Z');
    expect(await readEmptyDays(db, '+05:30', start, start + 24 * 3600000)).toEqual([
      { fromMs: start, toMs: start + 24 * 3600000 },
    ]);
  } finally {
    await db.close();
  }
});

it('keeps the first occurrence of a repeated local midnight with its date', async () => {
  const { db, clip } = await fixture();
  const starting = Date.parse('2026-10-24T00:00:00Z');
  const midnight = Date.parse('2026-10-25T00:00:00Z');
  const nextMidnight = Date.parse('2026-10-26T01:00:00Z');
  try {
    const gaps = (at: number) => readEmptyDays(db, 'Atlantic/Azores', starting, at);
    expect(await gaps(midnight + 300000)).toEqual([{ fromMs: starting, toMs: midnight }]);
    await clip('first-midnight', 'stripchat:2', midnight + 600000, midnight + 603000);
    expect(await gaps(nextMidnight)).toEqual([{ fromMs: starting, toMs: midnight }]);
  } finally {
    await db.close();
  }
});

it('starts a date at the first valid instant when clocks jump forward at midnight', async () => {
  const { db } = await fixture();
  const fromMs = Date.parse('2026-03-08T05:00:00Z');
  const toMs = Date.parse('2026-03-09T04:00:00Z');
  try {
    expect(await readEmptyDays(db, 'America/Havana', fromMs, toMs)).toEqual([{ fromMs, toMs }]);
  } finally {
    await db.close();
  }
});

it('rechecks for footage and removes only history inside the empty range', async () => {
  const { db, events, clip } = await fixture();
  const subject = 'stripchat:1';
  try {
    await db
      .prepare('INSERT INTO status_intervals VALUES(?,?,?,?)')
      .run(subject, left, right + 60000, 'OFFLINE');
    await db
      .prepare(
        'INSERT INTO status_heads(subject,start,last_at,valid_until,status,active) VALUES(?,?,?,?,?,1)',
      )
      .run(subject, left, right + 30000, right + 60000, 'OFFLINE');
    for (const [id, time] of [
      [1, left],
      [2, empty],
      [3, right],
    ])
      await db.prepare('INSERT INTO archive_events VALUES(?,?,?)').run(id, time, '{}');
    for (const minute of [empty - 60000, empty, right])
      await db
        .prepare(
          "INSERT INTO coverage_minutes(subject,minute,spans,starts,ends,count) VALUES(?,?,'[]','[]','[]',0)",
        )
        .run(subject, minute);
    const run = db.prepare('INSERT INTO program_runs VALUES(?,?,?,?,?,NULL)');
    await run.run('empty', empty + 1, right - 1, right, 'normal');
    await run.run('spanning', left, right, right, 'normal');
    await run.run('running', empty, right, null, 'running');
    await run.run('next-day', right, right, right, 'normal');
    await db.exec('UPDATE event_meta SET latest=3,event_count=3,run_count=4 WHERE id=1');
    const clean = () =>
      db.transaction(() => pruneEmptyHistory(db, events, { fromMs: empty, toMs: right }));
    await clip('late', 'stripchat:2', empty + 1000, empty + 3000);
    expect(await clean()).toBe(false);
    expect(await db.prepare('SELECT count(*) AS count FROM archive_events').get()).toEqual({
      count: 3,
    });
    await db.exec("UPDATE segments SET deleted=1 WHERE id='late'");
    expect(await clean()).toBe(false);
    expect(
      await db.prepare('SELECT start,"end" FROM status_intervals ORDER BY start').all(),
    ).toEqual([
      { start: left, end: empty },
      { start: right, end: right + 60000 },
    ]);
    expect(await db.prepare('SELECT start FROM status_heads').get()).toEqual({ start: right });
    expect(await db.prepare('SELECT id FROM archive_events ORDER BY id').all()).toEqual([
      { id: 1 },
      { id: 3 },
    ]);
    expect(await db.prepare('SELECT minute FROM coverage_minutes ORDER BY minute').all()).toEqual([
      { minute: empty - 60000 },
      { minute: right },
    ]);
    expect(await db.prepare('SELECT id FROM program_runs ORDER BY id').all()).toEqual([
      { id: 'next-day' },
      { id: 'running' },
      { id: 'spanning' },
    ]);
    expect(await db.prepare('SELECT latest,event_count,run_count FROM event_meta').get()).toEqual({
      latest: 3,
      event_count: 2,
      run_count: 3,
    });
    expect(await clean()).toBe(false);
  } finally {
    await db.close();
  }
});
