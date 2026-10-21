// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { FakeClock, MemoryDocStore } from '@beamhop/testkit';
import { fromB64, toB64, utf8 } from '../src/bytes.ts';
import {
  DEKS_COLLECTION,
  type DekRecord,
  Envelope,
  type KekProvider,
  LocalMasterKeyWrapper,
  WeakKeyError,
  createKek,
  parseMasterKey,
} from '../src/index.ts';
import { randomMasterKey } from './helpers.ts';

async function local(): Promise<KekProvider> {
  return LocalMasterKeyWrapper.fromString(randomMasterKey());
}

describe('local master key', () => {
  test('refuses weak keys', () => {
    expect(() => parseMasterKey(toB64(new Uint8Array(32)))).toThrow(WeakKeyError);
    expect(() => parseMasterKey(toB64(new Uint8Array(16).fill(7)))).toThrow(/32 bytes/);
    expect(() => parseMasterKey(toB64(utf8.encode('correct horse battery staple!!!!')))).toThrow(
      WeakKeyError,
    );
    const seq = new Uint8Array(32).map((_, i) => i + 9);
    expect(() => parseMasterKey(toB64(seq))).toThrow(WeakKeyError);
    expect(() => parseMasterKey('a'.repeat(64))).toThrow(WeakKeyError);
    expect(parseMasterKey(randomMasterKey())).toHaveLength(32);
  });

  test('wraps and unwraps; id is stable per key and differs between keys', async () => {
    const key = randomMasterKey();
    const a = await LocalMasterKeyWrapper.fromString(key);
    const b = await LocalMasterKeyWrapper.fromString(key);
    const c = await local();
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
    const pt = crypto.getRandomValues(new Uint8Array(32));
    expect(await b.unwrap(await a.wrap(pt))).toEqual(pt);
    await expect(c.unwrap(await a.wrap(pt))).rejects.toThrow();
  });

  test('key from env and missing key', async () => {
    const key = randomMasterKey();
    const k = await createKek(
      { provider: 'local', keyEnv: 'BH_KV' },
      { fetch, nowMs: Date.now, env: (n) => (n === 'BH_KV' ? key : undefined) },
    );
    expect(k.provider).toBe('local');
    await expect(createKek({ provider: 'local' }, { fetch, nowMs: Date.now })).rejects.toThrow(
      /No master key/,
    );
    await expect(
      createKek({ provider: 'local', keyFile: '/x' }, { fetch, nowMs: Date.now }),
    ).rejects.toThrow(/file/);
  });
});

describe('envelope encryption', () => {
  test('round-trips per tenant, binds context, stores only wrapped DEKs', async () => {
    const docs = new MemoryDocStore();
    const kek = await local();
    const env = new Envelope(docs, new FakeClock(), () => ({ current: kek, previous: [] }));
    const msg = utf8.encode('secret key material');
    const ct = await env.encrypt('acme', msg, 'key:alice');
    expect(env.tenantOf(ct)).toBe('acme');
    expect(await env.decrypt(ct, 'key:alice')).toEqual(msg);
    await expect(env.decrypt(ct, 'key:bob')).rejects.toThrow();
    const tampered = ct.slice();
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 1;
    await expect(env.decrypt(tampered, 'key:alice')).rejects.toThrow();

    await env.encrypt('other', msg);
    const deks = await docs.list<DekRecord>(DEKS_COLLECTION);
    expect(deks.items.map((i) => i.key).sort()).toEqual(['acme', 'other']);
    for (const { value } of deks.items) {
      expect(value.kekId).toBe(kek.id);
      expect(fromB64(value.wrapped).length).toBeGreaterThan(32); // wrapped, never raw
    }

    // A fresh instance (new process) decrypts through the stored wrapped DEK.
    const env2 = new Envelope(docs, new FakeClock(), () => ({ current: kek, previous: [] }));
    expect(await env2.decrypt(ct, 'key:alice')).toEqual(msg);
  });

  test('KEK rotation re-wraps DEKs; old data stays readable; old KEK can then go', async () => {
    const docs = new MemoryDocStore();
    const oldKek = await local();
    const newKek = await local();
    const env1 = new Envelope(docs, new FakeClock(), () => ({ current: oldKek, previous: [] }));
    const ct = await env1.encrypt('acme', utf8.encode('hello'));
    await env1.encrypt('beta', utf8.encode('x'));

    const env2 = new Envelope(docs, new FakeClock(), () => ({
      current: newKek,
      previous: [oldKek],
    }));
    expect(await env2.pendingRotation()).toBe(2);
    expect(await env2.decrypt(ct)).toEqual(utf8.encode('hello'));
    const report = await env2.rotate();
    expect(report).toMatchObject({ total: 2, rewrapped: 2, failed: [] });
    expect(await env2.pendingRotation()).toBe(0);
    expect((await env2.rotate()).alreadyCurrent).toBe(2);

    const env3 = new Envelope(docs, new FakeClock(), () => ({ current: newKek, previous: [] }));
    expect(await env3.decrypt(ct)).toEqual(utf8.encode('hello'));
    // Without rotation, a missing old KEK is a clear error.
    const docs2 = new MemoryDocStore();
    const e4 = new Envelope(docs2, new FakeClock(), () => ({ current: oldKek, previous: [] }));
    const ct4 = await e4.encrypt('t', utf8.encode('y'));
    const e5 = new Envelope(docs2, new FakeClock(), () => ({ current: newKek, previous: [] }));
    await expect(e5.decrypt(ct4)).rejects.toThrow(/previousKeks/);
  });

  test('port wrapper falls back to an earlier wrapper for foreign blobs', async () => {
    const docs = new MemoryDocStore();
    const kek = await local();
    const env = new Envelope(docs, new FakeClock(), () => ({ current: kek, previous: [] }));
    const earlier = await local();
    const port = env.portWrapper(earlier);
    const pt = utf8.encode('k');
    expect(await port.unwrap(await port.wrap(pt))).toEqual(pt);
    expect(await port.unwrap(await earlier.wrap(pt))).toEqual(pt);
    await expect(env.portWrapper().unwrap(await earlier.wrap(pt))).rejects.toThrow();
  });
});
