// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { defineModule } from '@beamhop/core';
import type { DirectoryLike, LifecycleLike } from '../src/index.ts';
import { COL } from '../src/index.ts';
import { setup } from './helpers.ts';

function directory() {
  const st = { admins: [{ id: 'owner-1' }], codes: 0 };
  const dir: DirectoryLike = {
    list: async () => st.admins,
    recoveryCodesLeft: async () => st.codes,
  };
  const mod = defineModule({
    id: 'fake-directory',
    register(k) {
      k.provide('admin.directory', dir);
    },
  });
  return { st, mod };
}

describe('setup checklist', () => {
  test('progresses item by item and hides itself when complete', async () => {
    const d = directory();
    const lifecycle: { last: { at: number; ok: boolean } | null } = { last: null };
    const lc: LifecycleLike = { lastBackup: async () => lifecycle.last };
    const { act, kernel, ports } = await setup({
      modules: [
        d.mod,
        defineModule({ id: 'fake-lifecycle', register: (k) => k.provide('lifecycle', lc) }),
      ],
    });
    const check = async () => (await act('experience.checklist', {})).output;

    let c = await check();
    expect(c.total).toBe(6);
    expect(c.done).toBe(0);
    expect(c.percent).toBe(0);
    expect(c.hidden).toBe(false);
    const ids = c.items.map((i: { id: string }) => i.id);
    expect(ids).toEqual([
      'recovery-codes',
      'backups',
      'alerts',
      'landing-page',
      'moderator',
      'test-relay',
    ]);
    for (const i of c.items) expect(i.link.screen).toMatch(/^\//);
    expect(c.items.find((i: { id: string }) => i.id === 'moderator').link.actionId).toBe(
      'admins.invite',
    );

    d.st.codes = 10;
    expect((await check()).done).toBe(1);

    const cfg = kernel.config();
    await kernel.applyConfig({
      ...cfg,
      backups: { ...cfg.backups, enabled: true },
      alerts: { ...cfg.alerts, channels: [{ type: 'webpush', id: 'phone' }] },
    });
    c = await check();
    const backups = c.items.find((i: { id: string }) => i.id === 'backups');
    expect(backups.done).toBe(false); // on, but no backup finished yet
    expect(backups.status).toContain('waiting');
    lifecycle.last = { at: ports.clock.now(), ok: true };
    c = await check();
    expect(c.done).toBe(3);

    // Name changed but no description: not yet.
    const relay = kernel.config().relays[0]!;
    await kernel.applyConfig({
      ...kernel.config(),
      relays: [{ ...relay, info: { ...relay.info, name: 'Cats of Nostr' } }],
    });
    expect((await check()).done).toBe(3);
    await kernel.applyConfig({
      ...kernel.config(),
      relays: [
        { ...relay, info: { ...relay.info, name: 'Cats of Nostr', description: 'Cat pictures' } },
      ],
    });
    expect((await check()).done).toBe(4);

    d.st.admins.push({ id: 'mod-1' });
    expect((await check()).done).toBe(5);

    await ports.docs.put(COL.testRuns, 'main', { ok: true });
    c = await check();
    expect(c.done).toBe(6);
    expect(c.percent).toBe(100);
    expect(c.complete).toBe(true);
    expect(c.hidden).toBe(true);

    // Stays hidden even if something regresses later.
    d.st.admins.pop();
    c = await check();
    expect(c.complete).toBe(false);
    expect(c.hidden).toBe(true);
  });

  test('backups item: in-progress while the first copy runs, failed with the reason, then done', async () => {
    const st: { last: { at: number; ok: boolean; error?: string } | null; running: boolean } = {
      last: null,
      running: true,
    };
    const lc: LifecycleLike = {
      lastBackup: async () => st.last,
      backupInProgress: () => st.running,
    };
    const { act, kernel, ports } = await setup({
      config: { backups: { enabled: true } },
      modules: [
        defineModule({ id: 'fake-lifecycle', register: (k) => k.provide('lifecycle', lc) }),
      ],
    });
    const item = async () =>
      (await act('experience.checklist', {})).output.items.find(
        (i: { id: string }) => i.id === 'backups',
      );
    let b = await item();
    expect(b.state).toBe('in-progress');
    expect(b.done).toBe(false);
    expect(b.detail).toBe('Backups are on — making the first copy…');

    st.running = false;
    st.last = { at: ports.clock.now(), ok: false, error: 'disk full' };
    b = await item();
    expect(b.state).toBe('failed');
    expect(b.detail).toBe('The last backup failed: disk full');

    st.last = { at: ports.clock.now(), ok: true };
    b = await item();
    expect(b.state).toBe('done');
    expect(b.done).toBe(true);
    expect(b.detail).toBeUndefined();

    await kernel.applyConfig({
      ...kernel.config(),
      backups: { ...kernel.config().backups, enabled: false },
    });
    b = await item();
    expect(b.state).toBe('todo');
    // Every item carries a state.
    const all = (await act('experience.checklist', {})).output.items;
    for (const i of all) expect(['done', 'todo', 'in-progress', 'failed']).toContain(i.state);
  });

  test('items whose module is missing are not counted', async () => {
    const { act } = await setup();
    const c = (await act('experience.checklist', {})).output;
    expect(c.items.find((i: { id: string }) => i.id === 'recovery-codes').available).toBe(false);
    expect(c.total).toBe(4);
  });
});
