// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type NostrEvent, defineModule } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import { HELD_ARCHIVE_COLLECTION, type HeldArchiveEntry } from '../src/index.ts';
import { eventsOf, setup } from './helpers.ts';

type Subject = { pubkey?: string; eventId?: string; createdAt?: number };

function holdsModule(isHeld: (s: Subject) => boolean) {
  return defineModule({
    id: 'fake-holds',
    register(kernel) {
      kernel.provide('lifecycle.holds', {
        active: () => true,
        isHeld: async (_relayId: string, s: Subject) => isHeld(s),
      });
    },
  });
}

async function archived(h: Awaited<ReturnType<typeof setup>>, id: string) {
  return h.ports.docs.get<HeldArchiveEntry>(HELD_ARCHIVE_COLLECTION, `main/${id}`);
}

describe('legal holds on user-requested deletions', () => {
  test('NIP-09: held events are archived, then hidden; others are just deleted', async () => {
    const heldIds = new Set<string>();
    const h = await setup({ modules: [holdsModule((s) => heldIds.has(s.eventId ?? ''))] });
    const k = makeKey();
    const c = await h.connect();
    const held = h.event(k);
    const free = h.event(k);
    heldIds.add(held.id);
    await h.publish(c, held);
    await h.publish(c, free);
    const del = h.event(k, {
      kind: 5,
      tags: [
        ['e', held.id],
        ['e', free.id],
      ],
    });
    expect((await h.publish(c, del))[2]).toBe(true);
    const served = eventsOf(await h.req(c, 's', { authors: [k.pk], kinds: [1] }));
    expect(served).toEqual([]);
    expect((await archived(h, held.id))?.event).toEqual(held);
    expect((await archived(h, held.id))?.cause).toBe('nip09');
    expect(await archived(h, free.id)).toBeNull();
  });

  test('NIP-62: a held user vanishes from serving but their data is archived', async () => {
    const alice = makeKey();
    const h = await setup({ modules: [holdsModule((s) => s.pubkey === alice.pk)] });
    const c = await h.connect();
    const notes: NostrEvent[] = [];
    for (let i = 0; i < 3; i++) {
      const e = h.event(alice, { created_at: h.ports.clock.now() - 10 });
      notes.push(e);
      await h.publish(c, e);
    }
    const wrap = h.event(makeKey(), {
      kind: 1059,
      tags: [['p', alice.pk]],
      created_at: h.ports.clock.now() - 10,
    });
    await h.publish(c, wrap);
    const vanish = h.event(alice, { kind: 62, tags: [['relay', 'ALL_RELAYS']] });
    expect((await h.publish(c, vanish))[2]).toBe(true);
    expect(await h.ports.events.query('main', [{ authors: [alice.pk] }])).toEqual([]);
    for (const e of [...notes, wrap]) {
      const a = await archived(h, e.id);
      expect(a?.event.id).toBe(e.id);
      expect(a?.cause).toBe('nip62');
    }
  });

  test('without a hold provider nothing is archived', async () => {
    const h = await setup();
    const k = makeKey();
    const c = await h.connect();
    const e = h.event(k);
    await h.publish(c, e);
    await h.publish(c, h.event(k, { kind: 5, tags: [['e', e.id]] }));
    expect(await archived(h, e.id)).toBeNull();
    expect(await h.ports.events.getById('main', e.id)).toBeNull();
  });
});
