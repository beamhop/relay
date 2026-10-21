// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type AppEvents, type Kernel, type RelayId, verifyEvent } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import {
  getConversationKey,
  decrypt as nip44decrypt,
  encrypt as nip44encrypt,
} from 'nostr-tools/nip44';
import { fromHex } from '../src/bytes.ts';
import {
  ALERTS_KEYS_COLLECTION,
  AUDIT_COLLECTION,
  type AuditRecord,
  KEYS_COLLECTION,
  type KeyRecord,
  RELAY_GROUP_KEYS_COLLECTION,
  SignerError,
} from '../src/index.ts';
import { randomMasterKey, runAction, setup } from './helpers.ts';

function record<K extends keyof AppEvents>(kernel: Kernel, name: K): AppEvents[K][] {
  const out: AppEvents[K][] = [];
  kernel.bus.on(name, (p) => out.push(p));
  return out;
}

describe('isolated signer', () => {
  test('ensureKey is idempotent and stores only the wrapped key', async () => {
    const { svc, ports } = await setup();
    const pk = await svc.ensureKey('google:alice');
    expect(pk).toMatch(/^[0-9a-f]{64}$/);
    expect(await svc.ensureKey('google:alice')).toBe(pk);
    expect(await svc.pubkeyOf('google:alice')).toBe(pk);
    expect(await svc.isManaged(pk)).toBe(true);
    expect(await svc.isManaged(makeKey().pk)).toBe(false);
    const rec = await ports.docs.get<KeyRecord>(KEYS_COLLECTION, 'google:alice');
    expect(rec).toMatchObject({ subjectId: 'google:alice', pubkey: pk, status: 'active' });
    expect(JSON.stringify(rec)).not.toMatch(/"(sk|secretKey)"/);
    expect(rec?.wrappedSk?.length).toBeGreaterThan(60);
  });

  test('signs valid events and audits who/what/which client', async () => {
    const { kernel, svc, ports } = await setup();
    const actions = record(kernel, 'admin.action');
    const pk = await svc.ensureKey('google:alice');
    const ev = await svc.sign(
      'google:alice',
      { kind: 1, content: 'hi', tags: [] },
      { sessionId: 's1', client: 'Team client' },
    );
    expect(ev.pubkey).toBe(pk);
    expect(verifyEvent(ev)).toBe(true);
    const audit = await ports.docs.list<AuditRecord>(AUDIT_COLLECTION);
    const sign = audit.items.map((i) => i.value).find((a) => a.op === 'sign');
    expect(sign).toMatchObject({
      subjectId: 'google:alice',
      kind: 1,
      eventId: ev.id,
      sessionId: 's1',
      client: 'Team client',
      via: 'api',
      ok: true,
    });
    const busSign = actions.find((a) => a.actionId === 'keyvault.sign');
    expect(busSign).toMatchObject({ principalId: 'session:s1', ok: true });
    expect(busSign?.summary).toBe('Signed a post for google:alice via Team client');

    // Wrong author / malformed / unknown subject are refused and audited.
    await expect(
      svc.sign('google:alice', { kind: 1, content: '', tags: [], pubkey: makeKey().pk }),
    ).rejects.toThrow(/different author/);
    await expect(
      svc.sign('google:alice', { kind: 1, content: 5, tags: [] } as never),
    ).rejects.toBeInstanceOf(SignerError);
    await expect(svc.sign('google:nobody', { kind: 1, content: '', tags: [] })).rejects.toThrow(
      /No managed key/,
    );
    const failed = (await ports.docs.list<AuditRecord>(AUDIT_COLLECTION)).items.filter(
      (i) => !i.value.ok,
    );
    expect(failed).toHaveLength(3);
  });

  test('zeroizes decrypted key material after use (best effort)', async () => {
    const { svc, rt } = await setup();
    await svc.ensureKey('google:alice');
    const seen: Uint8Array[] = [];
    const orig = rt.envelope.decrypt.bind(rt.envelope);
    rt.envelope.decrypt = async (blob, context) => {
      const out = await orig(blob, context);
      seen.push(out);
      return out;
    };
    await svc.sign('google:alice', { kind: 1, content: 'x', tags: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.length).toBe(32);
    expect(seen[0]!.every((b) => b === 0)).toBe(true);
  });

  test('NIP-44 encrypt/decrypt interoperate with nostr-tools', async () => {
    const { svc } = await setup();
    const pk = await svc.ensureKey('google:alice');
    const bob = makeKey();
    const ct = await svc.nip44Encrypt('google:alice', bob.pk, 'hello bob');
    expect(nip44decrypt(ct, getConversationKey(fromHex(bob.sk), pk))).toBe('hello bob');
    const back = nip44encrypt('hi alice', getConversationKey(fromHex(bob.sk), pk));
    expect(await svc.nip44Decrypt('google:alice', bob.pk, back)).toBe('hi alice');
  });

  test('per-key rate limit refuses bursts and raises an alert', async () => {
    const notes: string[] = [];
    const { svc, kernel, clock } = await setup({ keyvault: { signing: { perMinute: 3 } } });
    kernel.setNotifier(async (n) => {
      notes.push(n.title);
    });
    await svc.ensureKey('google:alice');
    await svc.ensureKey('google:bob');
    for (let i = 0; i < 3; i++)
      await svc.sign('google:alice', { kind: 1, content: `${i}`, tags: [] });
    const err = await svc.sign('google:alice', { kind: 1, content: 'x', tags: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(SignerError);
    expect(err.code).toBe('rate-limited');
    await svc.sign('google:bob', { kind: 1, content: 'other key', tags: [] });
    expect(notes).toEqual(['Unusual signing activity']);
    clock.advance(60);
    await svc.sign('google:alice', { kind: 1, content: 'later', tags: [] });
  });
});

describe('crypto-shred', () => {
  test('identity-style destroyKey(subject, reason) shreds now; key cannot sign afterwards', async () => {
    const { svc, ports } = await setup();
    const pk = await svc.ensureKey('google:alice');
    await svc.destroyKey('google:alice', 'offboarded');
    expect((await svc.keyState('google:alice'))?.status).toBe('destroyed');
    const rec = await ports.docs.get<KeyRecord>(KEYS_COLLECTION, 'google:alice');
    expect(rec?.status).toBe('destroyed');
    expect(rec?.wrappedSk).toBeUndefined();
    expect(await svc.isManaged(pk)).toBe(false);
    await expect(svc.sign('google:alice', { kind: 1, content: '', tags: [] })).rejects.toThrow();
    // A returning employee gets a brand-new key.
    const pk2 = await svc.ensureKey('google:alice');
    expect(pk2).not.toBe(pk);
  });

  test('is blocked by a legal hold, then completes when the hold ends', async () => {
    let held = true;
    const calls: Array<[RelayId, { pubkey?: string }]> = [];
    const { svc, kernel, ports, clock } = await setup({
      before: () => {},
    });
    kernel.provide('lifecycle.holds', {
      active: () => true,
      isHeld: async (relayId: RelayId, s: { pubkey?: string }) => {
        calls.push([relayId, s]);
        return held;
      },
    });
    const pk = await svc.ensureKey('google:alice');
    const r = await runAction(kernel, 'keyvault.destroy-key', {
      subjectId: 'google:alice',
      afterDays: 1,
      reason: 'left the company',
    });
    expect(r.output).toMatchObject({ status: 'scheduled' });
    await expect(svc.sign('google:alice', { kind: 1, content: '', tags: [] })).rejects.toThrow(
      /scheduled for destruction/,
    );
    clock.advance(2 * 86400);
    await ports.scheduler.tick('keyvault.shred');
    expect(calls[0]).toEqual(['main', { pubkey: pk }]);
    let rec = await ports.docs.get<KeyRecord>(KEYS_COLLECTION, 'google:alice');
    expect(rec?.status).toBe('pending-destroy');
    expect(rec?.wrappedSk).toBeDefined();
    expect(rec?.heldSince).toBeDefined();
    const cards = await kernel.cards[0]!.cards(null);
    expect(cards.map((c) => c.id)).toContain('keyvault.destroy-held');

    held = false;
    await ports.scheduler.tick('keyvault.shred');
    rec = await ports.docs.get<KeyRecord>(KEYS_COLLECTION, 'google:alice');
    expect(rec?.status).toBe('destroyed');
    expect(rec?.wrappedSk).toBeUndefined();
  });

  test('a failing hold check counts as held; cancel restores signing', async () => {
    const { svc, kernel, ports } = await setup();
    kernel.provide('lifecycle.holds', {
      isHeld: async () => {
        throw new Error('down');
      },
    });
    await svc.ensureKey('google:alice');
    await svc.destroyKey('google:alice', 'x');
    expect(await svc.keyState('google:alice')).toMatchObject({
      status: 'pending-destroy',
      held: true,
    });
    expect(await svc.cancelDestroy('google:alice')).toBe(true);
    const rec = await ports.docs.get<KeyRecord>(KEYS_COLLECTION, 'google:alice');
    expect(rec?.status).toBe('active');
    await svc.sign('google:alice', { kind: 1, content: 'back', tags: [] });
  });
});

describe('module wiring', () => {
  test('sets ports.keyWrapper and wraps the legacy alerts key on start', async () => {
    const legacySk = makeKey().sk;
    const { ports, kernel } = await setup({
      keyvault: { migrate: { relayGroupKeys: true } },
      ports: {
        docs: await (async () => {
          const { MemoryDocStore } = await import('@beamhop/testkit');
          const d = new MemoryDocStore();
          await d.put(ALERTS_KEYS_COLLECTION, 'nostr', { sk: legacySk });
          await d.put(RELAY_GROUP_KEYS_COLLECTION, 'main', {
            secretKey: legacySk,
            pubkey: 'pk',
            createdAt: 1,
          });
          return d;
        })(),
      },
    });
    expect(ports.keyWrapper?.provider).toBe('keyvault');
    const alerts = await ports.docs.get<{ sk?: string; wrapped?: string; provider?: string }>(
      ALERTS_KEYS_COLLECTION,
      'nostr',
    );
    expect(alerts?.sk).toBeUndefined();
    expect(alerts?.provider).toBe('keyvault');
    const raw = await ports.keyWrapper!.unwrap(
      Uint8Array.from(atob(alerts!.wrapped!), (c) => c.charCodeAt(0)),
    );
    expect(Buffer.from(raw).toString('hex')).toBe(legacySk);
    const group = await ports.docs.get<Record<string, unknown>>(
      RELAY_GROUP_KEYS_COLLECTION,
      'main',
    );
    expect(group).toMatchObject({ pubkey: 'pk', createdAt: 1, provider: 'keyvault' });
    expect(group?.secretKey).toBeUndefined();
    // Re-running is a no-op.
    const again = await runAction(kernel, 'keyvault.wrap-legacy-keys', { relayGroupKeys: true });
    expect(again.output).toMatchObject({ wrapped: [], alreadyWrapped: 2 });
  });

  test('relay group keys are left alone by default', async () => {
    const { MemoryDocStore } = await import('@beamhop/testkit');
    const docs = new MemoryDocStore();
    await docs.put(RELAY_GROUP_KEYS_COLLECTION, 'main', {
      secretKey: 'ab',
      pubkey: 'p',
      createdAt: 1,
    });
    await setup({ ports: { docs } });
    expect(await docs.get(RELAY_GROUP_KEYS_COLLECTION, 'main')).toMatchObject({ secretKey: 'ab' });
  });

  test('rotate-kek action re-wraps under the new master key', async () => {
    const oldKey = randomMasterKey();
    const first = await setup({ keyvault: { kek: { provider: 'local', key: oldKey } } });
    await first.svc.ensureKey('google:alice');
    const second = await setup({
      ports: { docs: first.ports.docs },
      keyvault: {
        kek: { provider: 'local', key: randomMasterKey() },
        previousKeks: [{ provider: 'local', key: oldKey }],
      },
    });
    const cards = await second.kernel.cards[0]!.cards(null);
    expect(cards.map((c) => c.id)).toEqual(['keyvault.local-kek', 'keyvault.rotation-pending']);
    const preview = await second.kernel.actions.get('keyvault.rotate-kek')!.preview!(
      { force: false },
      { principal: { id: 'x', roles: {}, via: 'token' }, relayId: null, ports: second.ports },
    );
    expect(preview[0]?.text).toMatch(/^1 data key /); // the default tenant's DEK
    const res = await runAction(second.kernel, 'keyvault.rotate-kek', {});
    expect(res.output).toMatchObject({ rewrapped: 1, failed: [] });
    // Works with only the new key now.
    const third = await setup({
      ports: { docs: first.ports.docs },
      keyvault: { kek: second.rt.cfg().kek },
    });
    const ev = await third.svc.sign('google:alice', { kind: 1, content: 'ok', tags: [] });
    expect(verifyEvent(ev)).toBe(true);
  });

  test('health checks report KEK reachability and an unusable master key', async () => {
    const ok = await setup();
    const kek = ok.kernel.health.find((h) => h.id === 'keyvault.kek')!;
    expect((await kek.run(null)).status).toBe('ok');
    const bad = await setup({ keyvault: { kek: { provider: 'local', key: 'short' } } });
    const r = await bad.kernel.health.find((h) => h.id === 'keyvault.kek')!.run(null);
    expect(r.status).toBe('critical');
    expect(bad.ports.keyWrapper).toBeUndefined();
    const cards = await bad.kernel.cards[0]!.cards(null);
    expect(cards[0]?.id).toBe('keyvault.not-ready');
    await expect(bad.svc.ensureKey('google:a')).rejects.toThrow(/not ready/);
    const status = await runAction(ok.kernel, 'keyvault.status', {});
    expect(status.output).toMatchObject({ provider: 'local', ready: true });
  });
});
