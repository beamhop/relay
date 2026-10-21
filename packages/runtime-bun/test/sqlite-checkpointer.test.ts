// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { parseConfig } from '@beamhop/core';
import { type Row, createSqlStores } from '@beamhop/storage-sql';
import { MemoryLogger, makeEvent, makeKey } from '@beamhop/testkit';
import { createDefaultPorts, ensureDataDir } from '../src/index.ts';
import { startSqliteCheckpointer } from '../src/sqlite-checkpointer.ts';
import { WorkerEventStore } from '../src/sqlite-writer.ts';
import { tempDir } from './helpers.ts';

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out');
    await Bun.sleep(10);
  }
}

describe('background SQLite checkpoints', () => {
  test('a worker thread copies the log into the database while the main thread writes', async () => {
    const path = join(tempDir('beamhop-cp-'), 'db.sqlite');
    const stores = await createSqlStores({
      driver: 'sqlite',
      path,
      pragmas: { wal_autocheckpoint: 0 },
    });
    expect(stores.file).toBe(path);
    await stores.events.init();
    const cp = await startSqliteCheckpointer(path, { intervalMs: 20, restartFrames: 1 });
    expect(cp).not.toBeNull();
    const k = makeKey();
    for (let i = 0; i < 20; i++)
      await Promise.all(
        Array.from({ length: 50 }, () => stores.events.save('r', makeEvent(k, { kind: 1 }))),
      );

    await waitFor(() => (cp?.stats().frames ?? 0) > 0 && (cp?.stats().restarts ?? 0) > 0);
    await cp?.stop();
    expect(cp?.stats().runs).toBeGreaterThan(0);
    // The log was started over instead of growing without bound.
    expect(cp?.stats().logFrames).toBeLessThan(2000);
    expect((await stores.events.stats('r')).events).toBe(1000);
    await stores.close();
  });

  test('a database that cannot be opened: no checkpointer', async () => {
    const cp = await startSqliteCheckpointer(join(tempDir('beamhop-cp-'), 'missing', 'db.sqlite'));
    expect(cp).toBeNull();
  });

  test('default ports: SQLite checkpoints in the background, writes stay here unless asked', async () => {
    const dir = tempDir('beamhop-cp-');
    const layout = ensureDataDir(dir);
    const cfg = parseConfig({ node: { dataDir: dir } });
    const autocheckpoint = async (exec: unknown) =>
      (
        await (exec as { all(q: { sql: string; params: unknown[] }): Promise<Row[]> }).all({
          sql: 'PRAGMA wal_autocheckpoint',
          params: [],
        })
      )[0]?.wal_autocheckpoint;

    const res = await createDefaultPorts(cfg, layout, new MemoryLogger());
    expect(await autocheckpoint(res.sql?.exec)).toBe(0);
    expect(res.ports.events).not.toBeInstanceOf(WorkerEventStore);
    await res.close();

    const off = await createDefaultPorts(cfg, layout, new MemoryLogger(), {
      backgroundCheckpoint: false,
    });
    expect(await autocheckpoint(off.sql?.exec)).toBe(1000);
    await off.close();

    const threaded = await createDefaultPorts(cfg, layout, new MemoryLogger(), {
      writerThread: true,
    });
    expect(threaded.ports.events).toBeInstanceOf(WorkerEventStore);
    const e = makeEvent(makeKey(), { kind: 1 });
    expect((await threaded.ports.events.save('main', e)).status).toBe('saved');
    expect((await threaded.ports.events.getById('main', e.id))?.id).toBe(e.id);
    await threaded.close();
  });

  test('in-memory databases have no file to checkpoint', async () => {
    const stores = await createSqlStores({ driver: 'sqlite', path: ':memory:' });
    expect(stores.file).toBeUndefined();
    await stores.close();
  });
});
