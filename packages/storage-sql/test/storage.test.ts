// SPDX-License-Identifier: AGPL-3.0-or-later
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { D1Shim } from '../src/d1-shim.ts';
import {
  MIGRATIONS_TABLE,
  type SqlStores,
  createSqlStores,
  migrate,
  registerMigrations,
  registeredMigrations,
  splitStatements,
} from '../src/index.ts';
import { sqliteMigrations } from '../src/migrations/generated.ts';
import { fakeEvent, randHex } from './fake.ts';

const R = 'r1';

async function both(): Promise<Array<[string, SqlStores, D1Shim | null]>> {
  const shim = new D1Shim();
  const out: Array<[string, SqlStores, D1Shim | null]> = [
    ['sqlite', await createSqlStores({ driver: 'sqlite' }), null],
    ['d1', await createSqlStores({ driver: 'd1', database: shim }), shim],
  ];
  for (const [, s] of out) await s.events.init();
  return out;
}

describe('storage-sql event store', () => {
  test('large list filters stay under the D1 parameter cap', async () => {
    for (const [name, s] of await both()) {
      const authors = Array.from({ length: 300 }, () => randHex(32));
      const evs = authors.map((pubkey, i) =>
        fakeEvent({ pubkey, created_at: 1000 + i, kind: i % 3 }),
      );
      await Promise.all(evs.map((e) => s.events.save(R, e)));
      const got = await s.events.query(R, [
        { authors, kinds: [0, 1, 2, 3, 4, 5, 6], limit: 1000 },
        { ids: evs.slice(0, 150).map((e) => e.id) },
      ]);
      expect(got.length, name).toBe(300);
      expect(got[0]?.created_at).toBe(1299);
      expect(await s.events.count(R, [{ authors }, { ids: evs.map((e) => e.id) }])).toBe(300);
      expect(
        await s.events.deleteByIds(
          R,
          evs.map((e) => e.id),
        ),
      ).toBe(300);
    }
  });

  test('tag filters, many tags per event, ordering ties by id', async () => {
    for (const [name, s] of await both()) {
      const pks = Array.from({ length: 500 }, () => randHex(32));
      const contacts = fakeEvent({ kind: 3, tags: pks.map((p) => ['p', p]), created_at: 5 });
      expect((await s.events.save(R, contacts)).status, name).toBe('saved');
      const t1 = fakeEvent({
        tags: [
          ['e', 'x'],
          ['t', 'a'],
          ['t', 'a'],
        ],
        created_at: 10,
      });
      const t2 = fakeEvent({
        tags: [
          ['e', 'x'],
          ['t', 'b'],
        ],
        created_at: 10,
      });
      const t3 = fakeEvent({
        tags: [
          ['e', 'y'],
          ['T', 'a'],
          ['long', 'a'],
        ],
        created_at: 11,
      });
      for (const e of [t1, t2, t3]) await s.events.save(R, e);
      expect((await s.events.query(R, [{ '#p': [pks[42]!] }]))[0]?.id).toBe(contacts.id);
      const ex = await s.events.query(R, [{ '#e': ['x'] }]);
      expect(ex.map((e) => e.id)).toEqual([t1.id, t2.id].sort());
      expect(
        (await s.events.query(R, [{ '#e': ['x', 'y'], '#t': ['a'] }])).map((e) => e.id),
      ).toEqual([t1.id]);
      expect((await s.events.query(R, [{ '#T': ['a'] }])).map((e) => e.id)).toEqual([t3.id]);
      expect(await s.events.query(R, [{ '#e': [] }])).toEqual([]);
      expect(await s.events.count(R, [{ '#t': ['a', 'b'] }])).toBe(2);
      expect((await s.events.query(R, [{ '#e': ['x'], since: 11 }])).length).toBe(0);
    }
  });

  test('per-filter limits and maxLimit', async () => {
    for (const [, s] of await both()) {
      for (let i = 0; i < 10; i++) {
        await s.events.save(R, fakeEvent({ kind: i % 2, created_at: i }));
      }
      const r = await s.events.query(R, [
        { kinds: [0], limit: 2 },
        { kinds: [1], limit: 3 },
      ]);
      expect(r.map((e) => e.created_at)).toEqual([9, 8, 7, 6, 5]);
      expect((await s.events.query(R, [{ limit: 50 }], { maxLimit: 4 })).length).toBe(4);
      expect(await s.events.query(R, [{ limit: 0 }])).toEqual([]);
    }
  });

  test('search uses the full-text index', async () => {
    for (const [, s] of await both()) {
      const a = fakeEvent({ content: 'Bitcoin and Nostr are friends' });
      const b = fakeEvent({ content: 'Only nostr here' });
      const dm = fakeEvent({ kind: 4, content: 'nostr secret' });
      for (const e of [a, b, dm]) await s.events.save(R, e);
      expect((await s.events.query(R, [{ search: 'nost' }])).length).toBe(2);
      expect((await s.events.query(R, [{ search: 'NOSTR bitcoin' }]))[0]?.id).toBe(a.id);
      expect((await s.events.query(R, [{ search: 'nostr language:en' }])).length).toBe(2);
      expect(await s.events.query(R, [{ search: '"quoted' }])).toEqual([]);
      await s.events.deleteByIds(R, [a.id]);
      expect((await s.events.query(R, [{ search: 'bitcoin' }])).length).toBe(0);
    }
  });

  test('group commit: concurrent replaceable versions resolve to the newest', async () => {
    const s = await createSqlStores({ driver: 'sqlite' });
    await s.events.init();
    const pubkey = randHex(32);
    const versions = Array.from({ length: 20 }, (_, i) =>
      fakeEvent({ pubkey, kind: 10002, created_at: 100 + i }),
    );
    const shuffled = [...versions].sort(() => Math.random() - 0.5);
    const results = await Promise.all(shuffled.map((e) => s.events.save(R, e)));
    expect(results.filter((r) => r.status === 'saved').length).toBeGreaterThan(0);
    const got = await s.events.query(R, [{ kinds: [10002], authors: [pubkey] }]);
    expect(got.map((e) => e.id)).toEqual([versions[19]!.id]);
    expect((await s.events.stats(R)).events).toBe(1);
    await s.close();
  });

  test('d1: a save is one batch round trip', async () => {
    const shim = new D1Shim();
    const s = await createSqlStores({ driver: 'd1', database: shim });
    await s.events.init();
    const before = shim.batches;
    await s.events.save(R, fakeEvent({ kind: 0 }));
    expect(shim.batches - before).toBe(1);
  });

  test('stats and expiry index', async () => {
    for (const [, s] of await both()) {
      await s.events.save('a', fakeEvent({ created_at: 5 }));
      await s.events.save('b', fakeEvent({ created_at: 9, tags: [['expiration', '20']] }));
      const all = await s.events.stats();
      expect(all.events).toBe(2);
      expect(all.oldest).toBe(5);
      expect(all.newest).toBe(9);
      expect((await s.events.stats('zzz')).oldest).toBeUndefined();
      expect(await s.events.deleteExpired(20)).toBe(1);
    }
  });
});

describe('d1 shim fidelity', () => {
  test('rejects >100 params, transactions, undefined', async () => {
    const shim = new D1Shim();
    const params = Array.from({ length: 101 }, (_, i) => i);
    await expect(
      shim
        .prepare(`SELECT ${params.map(() => '?').join(',')}`)
        .bind(...params)
        .all(),
    ).rejects.toThrow(/too many SQL variables/);
    expect(() => shim.prepare('BEGIN TRANSACTION')).toThrow(/batch/);
    expect(() => shim.prepare('SELECT ?').bind(undefined)).toThrow(/D1_TYPE_ERROR/);
    expect(await shim.prepare('SELECT 1 AS a').first<number>('a')).toBe(1);
    expect(await shim.prepare('SELECT 1 AS a').raw({ columnNames: true })).toEqual([['a'], [1]]);
  });

  test('batch is atomic', async () => {
    const shim = new D1Shim();
    await shim.prepare('CREATE TABLE t (x INTEGER PRIMARY KEY)').run();
    await expect(
      shim.batch([
        shim.prepare('INSERT INTO t VALUES (1)'),
        shim.prepare('INSERT INTO t VALUES (1)'),
      ]),
    ).rejects.toThrow();
    expect(await shim.prepare('SELECT COUNT(*) AS n FROM t').first<number>('n')).toBe(0);
  });
});

describe('migrations', () => {
  test('splitStatements drops comment-only chunks', () => {
    expect(
      splitStatements('-- c\n--> statement-breakpoint\nSELECT 1;\n--> statement-breakpoint\n'),
    ).toEqual(['SELECT 1;']);
  });

  test('idempotent, file-backed, and extensible via registerMigrations', async () => {
    const dir = `${process.env.TMPDIR ?? '/tmp'}/beamhop-storage-${randHex(4)}`;
    const s1 = await createSqlStores({ driver: 'sqlite', dataDir: dir });
    const first = await s1.migrate();
    expect(first.applied).toContain('storage-sql/0000_init');
    expect((await s1.migrate()).applied).toEqual([]);
    await s1.close();

    const unregister = registerMigrations({
      module: 'test-ext',
      sqlite: [{ tag: '0000_ext', sql: 'CREATE TABLE ext_things (id TEXT PRIMARY KEY)' }],
      pg: [{ tag: '0000_ext', sql: 'CREATE TABLE ext_things (id TEXT PRIMARY KEY)' }],
    });
    try {
      expect(registeredMigrations().map((m) => m.module)).toEqual(['storage-sql', 'test-ext']);
      const s2 = await createSqlStores({ driver: 'sqlite', url: `file:${dir}/db/beamhop.sqlite` });
      expect((await s2.migrate()).applied).toEqual(['test-ext/0000_ext']);
      const rows = await s2.exec.all({
        sql: `SELECT module, tag FROM ${MIGRATIONS_TABLE}`,
        params: [],
      });
      expect(rows.length).toBe(3);
      await s2.close();
    } finally {
      unregister();
    }
    expect(registeredMigrations().map((m) => m.module)).toEqual(['storage-sql']);
  });

  test('D1: migrations already applied by wrangler are recognised', async () => {
    const shim = new D1Shim();
    // What `wrangler d1 migrations apply` does with migrations/sqlite/*.sql.
    await shim
      .prepare(
        'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP)',
      )
      .run();
    for (const m of sqliteMigrations) {
      await shim.batch(splitStatements(m.sql).map((q) => shim.prepare(q)));
      await shim.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(`${m.tag}.sql`).run();
    }
    const s = await createSqlStores({ driver: 'd1', d1: shim });
    expect((await s.migrate()).applied).toEqual([]);
    expect((await s.events.save(R, fakeEvent())).status).toBe('saved');
  });

  test('root entry bundles for Workers without bun:sqlite or postgres', async () => {
    const out = await Bun.build({
      entrypoints: [`${import.meta.dir}/../src/index.ts`],
      target: 'browser',
      external: ['@beamhop/core'],
    });
    expect(out.success).toBe(true);
    const code = await out.outputs[0]!.text();
    expect(code).not.toContain('from "bun:sqlite"');
    expect(code).not.toContain('from "postgres"');
  });

  test('migrate on D1 and on a caller-owned bun Database', async () => {
    const shim = new D1Shim();
    const s = await createSqlStores({ driver: 'd1', database: shim, migrate: false });
    expect((await migrate(s.exec)).applied.length).toBe(2);
    const db = new Database(':memory:');
    const s2 = await createSqlStores({ driver: 'sqlite', database: db });
    await s2.docs.init();
    await s2.docs.put('c', 'k', { a: 1 });
    await s2.close();
    // Caller-owned database is still open.
    expect(db.query('SELECT COUNT(*) AS n FROM docs').get()).toEqual({ n: 1 });
  });
});
