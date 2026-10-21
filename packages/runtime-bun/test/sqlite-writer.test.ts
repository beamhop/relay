// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createSqlStores } from '@beamhop/storage-sql';
import { eventStoreContract, makeEvent, makeKey } from '@beamhop/testkit';
import { WorkerEventStore } from '../src/sqlite-writer.ts';
import { tempDir } from './helpers.ts';

const opened: WorkerEventStore[] = [];
afterAll(async () => {
  for (const s of opened.splice(0)) await s.close();
});

async function make(windowMs = 2) {
  const path = join(tempDir('beamhop-writer-'), 'db.sqlite');
  const stores = await createSqlStores({ driver: 'sqlite', path });
  await stores.migrate();
  const store = new WorkerEventStore({ path, reader: stores.events, windowMs });
  opened.push(store);
  return store;
}

eventStoreContract('sqlite writer thread', () => make());
eventStoreContract('sqlite writer thread (no window)', () => make(0));

describe('WorkerEventStore', () => {
  test('a burst of saves is one message and one transaction; reads see resolved saves', async () => {
    const s = await make();
    await s.init();
    const k = makeKey();
    const evs = Array.from({ length: 300 }, () => makeEvent(k, { kind: 1 }));
    const results = await Promise.all(evs.map((e) => s.save('r', e)));
    expect(results.every((r) => r.status === 'saved')).toBe(true);
    expect((await s.getById('r', evs[299]!.id))?.id).toBe(evs[299]!.id);
    expect((await s.save('r', evs[0]!)).status).toBe('duplicate');
    expect((await s.stats('r')).events).toBe(300);
  });

  test('writes keep their order (a delete after a save applies after it)', async () => {
    const s = await make(20);
    await s.init();
    const e = makeEvent(makeKey(), { kind: 1 });
    const saved = s.save('r', e);
    const deleted = s.deleteByIds('r', [e.id]);
    expect((await saved).status).toBe('saved');
    expect(await deleted).toBe(1);
    expect(await s.getById('r', e.id)).toBeNull();
  });

  test('a writer thread that dies refuses writes instead of losing them', async () => {
    const s = await make();
    await s.init();
    (s as unknown as { worker: Worker }).worker.terminate();
    (s as unknown as { fail(e: Error): void }).fail(new Error('gone'));
    await expect(s.save('r', makeEvent(makeKey(), { kind: 1 }))).rejects.toThrow('gone');
  });
});
