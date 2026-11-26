import { openTestDatabase } from './postgres.test-support.js';
import { startTestPostgres } from '../database/postgres.test-support.js';
import type { TestPostgresServer } from '../database/postgres.test-support.js';
import { beforeAll, afterAll } from 'vitest';
import { describe, expect, it } from 'vitest';
import { MediaSelectionStore } from './media-selection-store.js';
import { FavoriteCommands, type FavoriteSelectionChange } from './favorite-commands.js';
import { initializeUnitVisibility } from './unit-visibility.js';

let postgres: TestPostgresServer;
beforeAll(async () => {
  postgres = await startTestPostgres();
});
afterAll(async () => {
  await postgres.close();
});
async function fixture(count = 1025) {
  const db = await openTestDatabase();
  await db.exec(
    '\n    CREATE TABLE subjects(id TEXT PRIMARY KEY,deletion_revision BIGINT);INSERT INTO subjects VALUES(\'stripchat:1\',0);\n    CREATE TABLE personal_owner(id BIGINT PRIMARY KEY,revision BIGINT);INSERT INTO personal_owner VALUES(1,0);\n    CREATE TABLE recording_units(id TEXT PRIMARY KEY,subject TEXT,start BIGINT,"end" BIGINT,deleted BIGINT,created_revision BIGINT);\n    CREATE TABLE segments(id TEXT PRIMARY KEY,"end" BIGINT,deleted BIGINT,created_revision BIGINT,pending BIGINT DEFAULT 0);\n    CREATE TABLE unit_segments(unit TEXT,segment TEXT);\n    CREATE INDEX unit_members ON unit_segments(unit,segment);\n    CREATE TABLE unit_favorites(unit TEXT PRIMARY KEY,created BIGINT);\n    CREATE TABLE media_deletions(id TEXT PRIMARY KEY,state TEXT,created BIGINT);\n    CREATE TABLE deletion_units(job TEXT,unit TEXT,PRIMARY KEY(job,unit));\n    CREATE VIEW visible_segments AS SELECT * FROM segments WHERE pending=0;\n  ',
  );
  await db.transaction(async () => {
    for (let n = 0; n < count; n++) {
      const id = String(n).padStart(8, '0');
      await db
        .prepare('INSERT INTO recording_units VALUES(?,?,?, ?,0,1)')
        .run(id, 'stripchat:1', n * 1000, n * 1000 + 1000);
      await db
        .prepare('INSERT INTO segments(id,"end",deleted,created_revision) VALUES(?,?,0,1)')
        .run(id, n * 1000 + 1000);
      await db.prepare('INSERT INTO unit_segments VALUES(?,?)').run(id, id);
    }
  });
  const selections = new MediaSelectionStore(db, () => Promise.resolve(1)),
    favorites = new FavoriteCommands(db, selections);
  await selections.initialize();
  await db.exec(`CREATE VIEW deletion_intent_units AS SELECT x.unit,x.job FROM deletion_units x
    JOIN media_deletions d ON d.id=x.job WHERE d.state IN ('queued','running','retry')`);
  await initializeUnitVisibility(db, true);
  await favorites.initialize();
  const select = async () => {
    const id = await selections.begin('stripchat:1', { fromMs: 0, toMs: count * 1000 }, 'all');
    while (await selections.build('stripchat:1', id)) {}
    return id;
  };
  const size = async (table: string) =>
    (await db.prepare(`SELECT count(*) n FROM ${table}`).get())!.n;
  return { db, selections, favorites, select, size };
}
describe('bounded durable selection and favorite commands', () => {
  it('advances another subject while keeping overlapping commands FIFO within one subject', async () => {
    const f = await fixture(513);
    try {
      await f.db.exec(
        "INSERT INTO subjects VALUES('stripchat:2',0);INSERT INTO recording_units VALUES('other','stripchat:2',0,1000,0,1);INSERT INTO segments(id,\"end\",deleted,created_revision) VALUES('other',1000,0,1);INSERT INTO unit_segments VALUES('other','other')",
      );
      const a = await f.select();
      await f.favorites.accept('stripchat:1', [{ selectionId: a, liked: true }], 0);
      const later = await f.select();
      await f.favorites.accept('stripchat:1', [{ selectionId: later, liked: false }], 1);
      const b = await f.selections.begin('stripchat:2', { fromMs: 0, toMs: 1000 }, 'all');
      while (await f.selections.build('stripchat:2', b)) {}
      await f.favorites.accept('stripchat:2', [{ selectionId: b, liked: true }], 2);
      await f.favorites.step('stripchat:2');
      expect(
        await f.db.prepare("SELECT unit FROM unit_favorites WHERE unit='other'").all(),
      ).toEqual([{ unit: 'other' }]);
      expect(
        await f.db
          .prepare(
            "SELECT count(*) n FROM favorite_commands WHERE subject='stripchat:1' AND state='pending'",
          )
          .get(),
      ).toEqual({ n: 2 });
      while (await f.favorites.step('stripchat:1')) {}
      expect(await f.db.prepare('SELECT unit FROM effective_unit_favorites').all()).toEqual([
        { unit: 'other' },
      ]);
    } finally {
      await f.db.close();
    }
  });
  it('clones and copies only 256 keys per call and maintains patched counts', async () => {
    const f = await fixture();
    try {
      const source = await f.select();
      const fork = await f.selections.begin(
        'stripchat:1',
        { fromMs: 0, toMs: 1025000 },
        'explicit',
        {
          baseSelectionId: source,
          excludeUnitIds: ['00000000'],
        },
      );
      expect(await f.size('selection_units')).toBe(1025);
      await f.selections.build('stripchat:1', fork);
      expect(await f.size('selection_units')).toBe(1280);
      while (await f.selections.build('stripchat:1', fork)) {}
      expect((await f.selections.summary('stripchat:1', fork)).count).toBe(1024);
      await f.selections.copyToDeletion('stripchat:1', fork, 'delete', {});
      expect(await f.size('deletion_units')).toBe(0);
      await f.selections.copyDeletion('delete');
      expect(await f.size('deletion_units')).toBe(256);
      while (await f.selections.copyDeletion('delete')) {}
      expect(await f.size('deletion_units')).toBe(1024);
    } finally {
      await f.db.close();
    }
  });
  it('publishes all likes immediately, protects targets from TTL, and replays in strict order after restart', async () => {
    const f = await fixture();
    try {
      const selection = await f.select();
      await f.favorites.accept('stripchat:1', [{ selectionId: selection, liked: true }], 0);
      expect(await f.size('unit_favorites')).toBe(0);
      expect(await f.size('effective_unit_favorites')).toBe(1025);
      await f.db.prepare('UPDATE media_selections SET created=0').run();
      expect(await f.selections.cleanup()).toBe(false);
      await f.favorites.step();
      expect(await f.size('unit_favorites')).toBe(256);
      const resumed = new FavoriteCommands(f.db, f.selections);
      await resumed.initialize();
      // A later command overrides the unfinished earlier projection immediately.
      const later = await f.selections.begin('stripchat:1', { fromMs: 0, toMs: 1 }, 'explicit', {
        includeUnitIds: ['00000000'],
      });
      while (await f.selections.build('stripchat:1', later)) {}
      await resumed.accept('stripchat:1', [{ selectionId: later, liked: false }], 1);
      expect(await f.size('effective_unit_favorites')).toBe(1024);
      while (await resumed.step()) {}
      expect(await f.size('unit_favorites')).toBe(1024);
      expect(
        await f.db.prepare("SELECT 1 FROM unit_favorites WHERE unit='00000000'").get(),
      ).toBeUndefined();
    } finally {
      await f.db.close();
    }
  });
  it('hides pending-deletion favorites before any physical unlink', async () => {
    const f = await fixture(2);
    try {
      await f.favorites.accept('stripchat:1', [{ selectionId: await f.select(), liked: true }], 0);
      expect(await f.size('effective_unit_favorites')).toBe(2);
      await f.db.exec(
        "INSERT INTO media_deletions VALUES('delete','queued',0); INSERT INTO deletion_units VALUES('delete','00000000')",
      );
      expect(await f.size('effective_unit_favorites')).toBe(1);
      while (await f.favorites.step()) {}
      expect(await f.size('unit_favorites')).toBe(2);
      expect(await f.size('effective_unit_favorites')).toBe(1);
    } finally {
      await f.db.close();
    }
  });
  it('publishes both inverse groups together and rolls back both on admission failure', async () => {
    const f = await fixture(3);
    const subject = 'stripchat:1';
    try {
      await f.db.exec("INSERT INTO unit_favorites VALUES('00000000', 1)");
      const source = await f.select();
      const changes: FavoriteSelectionChange[] = [];
      for (const liked of [false, true]) {
        const selectionId = await f.selections.begin(subject, { fromMs: 0, toMs: 1 }, 'explicit', {
          baseSelectionId: source,
        });
        while (await f.selections.build(subject, selectionId, !liked)) {}
        changes.push({ selectionId, liked });
      }
      const result = () => f.db.transaction(() => f.favorites.accept(subject, changes, 0));
      const visible = () =>
        f.db.prepare('SELECT unit FROM effective_unit_favorites ORDER BY unit').all();
      await f.db.exec(`
        CREATE FUNCTION reject_second_favorite() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.liked=1 THEN RAISE EXCEPTION 'SECOND_COMMAND_FAILED'; END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER reject_second BEFORE INSERT ON favorite_commands
          FOR EACH ROW EXECUTE FUNCTION reject_second_favorite();
      `);
      await expect(result()).rejects.toThrow('SECOND_COMMAND_FAILED');
      expect(await f.size('favorite_commands')).toBe(0);
      expect(await visible()).toEqual([{ unit: '00000000' }]);
      await f.db.exec('DROP TRIGGER reject_second ON favorite_commands');
      expect(await result()).toMatchObject({ revision: 2, count: 3 });
      expect(await visible()).toEqual([{ unit: '00000001' }, { unit: '00000002' }]);
      while (await f.favorites.step()) {}
      expect(await visible()).toEqual([{ unit: '00000001' }, { unit: '00000002' }]);
    } finally {
      await f.db.close();
    }
  });
  it('retires an expired large token through bounded child batches instead of a cascading transaction', async () => {
    const f = await fixture();
    try {
      await f.select();
      await f.db.prepare('UPDATE media_selections SET created=0').run();
      await f.selections.cleanup();
      expect(await f.size('selection_units')).toBe(769);
      expect(await f.size('media_selections')).toBe(1);
      while (await f.selections.cleanup()) {}
      expect(await f.size('selection_units')).toBe(0);
      expect(await f.size('media_selections')).toBe(0);
    } finally {
      await f.db.close();
    }
  });
});
