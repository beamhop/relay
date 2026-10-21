// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type KeyWrapper, getPublicKey } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import {
  GROUPS_KEY_COLLECTION,
  GROUPS_SERVICE,
  type GroupsService,
  REVOKED_CHANNEL,
  type StoredGroupKey,
} from '../src/index.ts';
import { setup } from './helpers.ts';

/** Toy wrapper: XOR with a fixed pad plus a provider marker (enough to prove wrap/unwrap). */
function xorWrapper(provider = 'test-kms'): KeyWrapper & { calls: number } {
  const pad = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
  const w = {
    provider,
    calls: 0,
    async wrap(p: Uint8Array) {
      w.calls++;
      const k = pad(p.length);
      return Uint8Array.from(p, (b, i) => b ^ (k[i] as number));
    },
    async unwrap(c: Uint8Array) {
      w.calls++;
      const k = pad(c.length);
      return Uint8Array.from(c, (b, i) => b ^ (k[i] as number));
    },
  };
  return w;
}

const toB64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const hex = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));

describe('RelayEngine.disconnectPubkey', () => {
  test('closes only the connections authenticated as that key', async () => {
    const h = await setup();
    const alice = makeKey();
    const bob = makeKey();
    const a1 = await h.connect();
    const a2 = await h.connect();
    const b = await h.connect();
    const anon = await h.connect();
    await h.auth(a1, alice);
    await h.auth(a2, alice);
    await h.auth(b, bob);
    const closed = h.record('conn.close');

    expect(h.engine.disconnectPubkey(alice.pk, 'left the company')).toBe(2);
    for (const c of [a1, a2]) {
      expect(c.closedWith?.code).toBe(1008);
      expect(c.of('NOTICE').at(-1)?.[1]).toBe('restricted: left the company');
    }
    expect(b.closedWith).toBeNull();
    expect(anon.closedWith).toBeNull();
    expect(closed).toHaveLength(2);
    expect(h.engine.connectionCount()).toBe(2);
    // Idempotent.
    expect(h.engine.disconnectPubkey(alice.pk)).toBe(0);
  });

  test('a message on the enterprise.revoked channel disconnects cluster-wide', async () => {
    const h = await setup();
    const alice = makeKey();
    const c = await h.connect();
    await h.auth(c, alice);
    await h.ports.pubsub.publish(REVOKED_CHANNEL, { pubkey: alice.pk, reason: 'offboarded' });
    expect(c.closedWith?.code).toBe(1008);
    // Garbage is ignored.
    await h.ports.pubsub.publish(REVOKED_CHANNEL, { pubkey: 'nope' });
    await h.ports.pubsub.publish(REVOKED_CHANNEL, null);
    expect(REVOKED_CHANNEL).toBe('enterprise.revoked');
  });
});

describe('NIP-29 group key records', () => {
  test('reads the wrapped { pubkey, createdAt, wrapped, provider } shape', async () => {
    const wrapper = xorWrapper();
    const sk = makeKey().sk;
    const pubkey = getPublicKey(sk);
    const h = await setup({ ports: { keyWrapper: wrapper } });
    const rec: StoredGroupKey = {
      pubkey,
      createdAt: 1,
      wrapped: toB64(await wrapper.wrap(hex(sk))),
      provider: wrapper.provider,
    };
    await h.ports.docs.put(GROUPS_KEY_COLLECTION, 'main', rec);
    const groups = h.kernel.use<GroupsService>(GROUPS_SERVICE)!;
    expect(await groups.relayKey('main')).toEqual({ pubkey, secretKey: sk });
  });

  test('new keys are stored wrapped when a key wrapper is configured', async () => {
    const wrapper = xorWrapper();
    const h = await setup({ ports: { keyWrapper: wrapper } });
    const groups = h.kernel.use<GroupsService>(GROUPS_SERVICE)!;
    const key = await groups.relayKey('main');
    const stored = await h.ports.docs.get<StoredGroupKey>(GROUPS_KEY_COLLECTION, 'main');
    expect(stored?.secretKey).toBeUndefined();
    expect(stored?.provider).toBe('test-kms');
    expect(stored?.pubkey).toBe(key.pubkey);
    expect(getPublicKey(key.secretKey)).toBe(key.pubkey);
  });

  test('a wrapped key without a wrapper, or with the wrong key, fails loudly', async () => {
    const wrapper = xorWrapper();
    const sk = makeKey().sk;
    const rec: StoredGroupKey = {
      pubkey: getPublicKey(sk),
      createdAt: 1,
      wrapped: toB64(await wrapper.wrap(hex(sk))),
      provider: 'x',
    };
    const h = await setup();
    await h.ports.docs.put(GROUPS_KEY_COLLECTION, 'main', rec);
    const groups = h.kernel.use<GroupsService>(GROUPS_SERVICE)!;
    await expect(groups.relayKey('main')).rejects.toThrow(/no key wrapper/);

    const h2 = await setup({ ports: { keyWrapper: wrapper } });
    await h2.ports.docs.put(GROUPS_KEY_COLLECTION, 'main', { ...rec, pubkey: makeKey().pk });
    const g2 = h2.kernel.use<GroupsService>(GROUPS_SERVICE)!;
    await expect(g2.relayKey('main')).rejects.toThrow(/does not match/);
  });
});
