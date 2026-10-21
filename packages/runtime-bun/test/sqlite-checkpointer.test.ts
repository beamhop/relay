// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createSqlStores } from '@beamhop/storage-sql';
import { makeEvent, makeKey } from '@beamhop/testkit';
import {
  BACKGROUND_CHECKPOINT_SAFETY_PAGES,
  startSqliteCheckpointer,
} from '../src/sqlite-checkpointer.ts';
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
      pragmas: { wal_autocheckpoint: BACKGROUND_CHECKPOINT_SAFETY_PAGES },
    });
    expect(stores.file).toBe(path);
    await stores.events.init();
    const cp = await startSqliteCheckpointer(path, { intervalMs: 20 });
    expect(cp).not.toBeNull();
    const k = makeKey();
    for (let i = 0; i < 20; i++)
      await Promise.all(
        Array.from({ length: 50 }, () => stores.events.save('r', makeEvent(k, { kind: 1 }))),
      );
    await waitFor(() => (cp?.stats().frames ?? 0) > 0);
    await cp?.stop();
    expect(cp?.stats().runs).toBeGreaterThan(0);
    expect((await stores.events.stats('r')).events).toBe(1000);
    await stores.close();
  });

  test('in-memory databases have no file to checkpoint', async () => {
    const stores = await createSqlStores({ driver: 'sqlite', path: ':memory:' });
    expect(stores.file).toBeUndefined();
    await stores.close();
  });
});
