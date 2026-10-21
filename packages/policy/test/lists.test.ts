// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { makeKey } from '@beamhop/testkit';
import { npubToHex } from '../src/lists.ts';
import { setup } from './helpers.ts';

// Valid NIP-19 vector (npub ↔ hex).
const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
const HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';

describe('policy.explain-limits what-if', () => {
  test('goals and persona preview limits without changing the relay', async () => {
    const { act, kernel } = await setup();
    const base = await act('policy.explain-limits', {});
    expect((base.result.output as { whatIf?: unknown }).whatIf).toBeUndefined();
    const before = kernel.relay('main')!.goals.openness;

    const strict = await act('policy.explain-limits', { goals: { openness: 0 } });
    const out = strict.result.output as {
      limits: { eventsPerMinute: number };
      current: { eventsPerMinute: number };
      whatIf: { goals: { openness: number } };
      changes: Array<{ field: string; from: unknown; to: unknown }>;
    };
    expect(out.whatIf.goals.openness).toBe(0);
    expect(out.changes.length).toBeGreaterThan(0);
    for (const c of out.changes) expect(c.from).not.toEqual(c.to);
    expect(kernel.relay('main')!.goals.openness).toBe(before);

    const team = await act('policy.explain-limits', { persona: 'private-team' });
    expect((team.result.output as { whatIf: { persona: string } }).whatIf.persona).toBe(
      'private-team',
    );
    // Same goals as now → nothing changes.
    const same = await act('policy.explain-limits', {
      goals: kernel.relay('main')!.goals,
    });
    expect((same.result.output as { changes: unknown[] }).changes).toEqual([]);
  });
});

describe('list actions', () => {
  test('npub decoding', () => {
    expect(npubToHex(NPUB)).toBe(HEX);
    expect(npubToHex('npub1xyz')).toBeUndefined();
  });

  test('users.list merges activity, tiers, storage and status; pages and searches', async () => {
    const env = await setup({
      tiers: [{ id: 'trusted', name: 'Trusted' }],
    });
    const { act, kernel, ports, svc } = env;
    const [a, b, c, d] = [makeKey(), makeKey(), makeKey(), makeKey()];
    const t0 = ports.clock.now();
    kernel.bus.emit('event.accepted', {
      relayId: 'main',
      event: env.ev(a),
      latencyMs: 1,
    });
    ports.clock.advance(1000);
    kernel.bus.emit('auth.success', { relayId: 'main', connId: 'x', pubkey: b.pk });
    await ports.blobIndex.addOwner({
      relayId: 'main',
      sha256: 'f'.repeat(64),
      pubkey: c.pk,
      size: 1234,
      type: 'image/png',
      uploadedAt: t0 + 10,
    });
    await svc.idle();
    await act('moderation.ban-pubkey', { pubkeys: [d.pk], reason: 'spam' });
    await act('moderation.mute-pubkey', { pubkeys: [b.pk] });
    await act('users.set-tier', { pubkey: a.pk, tier: 'trusted' });
    await act('access.add-allowlist', { pubkeys: [c.pk] });

    const all = await act('users.list', {});
    const out = all.result.output as {
      users: Array<Record<string, unknown>>;
      total: number;
      cursor?: string;
    };
    expect(out.total).toBe(4);
    const by = new Map(out.users.map((u) => [u.pubkey, u]));
    expect(out.users[0]?.pubkey).toBe(b.pk); // most recent first
    expect(by.get(a.pk)).toMatchObject({ tier: 'trusted', tierExplicit: true, firstSeen: t0 });
    expect(by.get(b.pk)).toMatchObject({ muted: true, lastSeen: t0 + 1000 });
    expect(by.get(c.pk)).toMatchObject({ storageBytes: 1234, files: 1, allowlisted: true });
    expect(by.get(d.pk)).toMatchObject({ banned: true });

    const p1 = await act('users.list', { limit: 3 });
    const o1 = p1.result.output as { users: unknown[]; cursor?: string };
    expect(o1.users).toHaveLength(3);
    expect(o1.cursor).toBe('3');
    const p2 = await act('users.list', { limit: 3, cursor: o1.cursor });
    const o2 = p2.result.output as { users: unknown[]; cursor?: string };
    expect(o2.users).toHaveLength(1);
    expect(o2.cursor).toBeUndefined();

    const banned = await act('users.list', { status: 'banned' });
    expect((banned.result.output as { users: Array<{ pubkey: string }> }).users).toEqual([
      expect.objectContaining({ pubkey: d.pk }),
    ]);
    const found = await act('users.list', { search: c.pk.slice(10, 20) });
    expect((found.result.output as { total: number }).total).toBe(1);
    const recent = await act('users.list', { activeWithinDays: 1 });
    expect((recent.result.output as { total: number }).total).toBeGreaterThanOrEqual(3);
  });

  test('users.list: effective quota, used, remaining, over quota (override, tier, goals)', async () => {
    const MB = 1024 * 1024;
    const env = await setup({ tiers: [{ id: 'big', name: 'Big', blobQuotaBytes: 50 * MB }] });
    const { act, kernel, ports } = env;
    const [a, b, c] = [makeKey(), makeKey(), makeKey()];
    const own = (pubkey: string, size: number, n: string) =>
      ports.blobIndex.addOwner({
        relayId: 'main',
        sha256: n.repeat(64),
        pubkey,
        size,
        type: 'image/png',
        uploadedAt: ports.clock.now(),
      });
    await own(a.pk, 10 * MB, 'a');
    await own(b.pk, 30 * MB, 'b');
    await own(c.pk, 5 * MB, 'c');
    await act('users.set-tier', { pubkey: b.pk, tier: 'big' });
    await ports.docs.put('blossom.quotas', `main:${c.pk}`, { quotaBytes: 4 * MB });
    const goalsQuota = kernel.limits('main').defaultBlobQuotaBytes;

    const out = (await act('users.list', {})).result.output as {
      users: Array<Record<string, unknown>>;
    };
    const by = new Map(out.users.map((u) => [u.pubkey, u]));
    expect(by.get(a.pk)).toMatchObject({
      quotaBytes: goalsQuota,
      usedBytes: 10 * MB,
      storageBytes: 10 * MB,
      remainingBytes: goalsQuota - 10 * MB,
      overQuota: false,
    });
    expect(by.get(b.pk)).toMatchObject({
      quotaBytes: 50 * MB,
      remainingBytes: 20 * MB,
      overQuota: false,
    });
    expect(by.get(c.pk)).toMatchObject({ quotaBytes: 4 * MB, remainingBytes: 0, overQuota: true });
  });

  test('explain-limits what-if reports who would be near or over their storage limit', async () => {
    const MB = 1024 * 1024;
    const { act, kernel, ports } = await setup({ goals: { storage: 50 } });
    const [a, b, c] = [makeKey(), makeKey(), makeKey()];
    const own = (pubkey: string, size: number, n: string) =>
      ports.blobIndex.addOwner({
        relayId: 'main',
        sha256: n.repeat(64),
        pubkey,
        size,
        type: 'image/png',
        uploadedAt: ports.clock.now(),
      });
    await own(a.pk, 90 * MB, 'a'); // near 100 MB
    await own(b.pk, 600 * MB, 'b'); // over 100 MB
    await own(c.pk, 1024, 'c');
    await own('anonymous', 900 * MB, 'd'); // not a person
    expect(kernel.limits('main').defaultBlobQuotaBytes).toBeGreaterThan((600 * MB) / 0.8);
    const res = await act('policy.explain-limits', { goals: { storage: 0 } });
    const out = res.result.output as {
      limits: { defaultBlobQuotaBytes: number };
      quotaImpact: { nearQuota: number; overQuota: number; before: unknown };
    };
    expect(out.limits.defaultBlobQuotaBytes).toBe(100 * MB);
    expect(out.quotaImpact).toMatchObject({ nearQuota: 1, overQuota: 1 });
    expect(out.quotaImpact.before).toEqual({ nearQuota: 0, overQuota: 0 });
  });

  test('NIP-86 backing lists: banned, muted, allowed, invites', async () => {
    const { act, ports } = await setup();
    const [a, b, c] = [makeKey(), makeKey(), makeKey()];
    await act('moderation.ban-pubkey', { pubkeys: [a.pk], reason: 'spam' });
    await act('moderation.mute-pubkey', { pubkeys: [b.pk], hours: 1 });
    await act('access.add-allowlist', { pubkeys: [c.pk], note: 'friend' });
    await act('access.create-invite', { maxUses: 1 });

    const bans = await act('moderation.list-banned-pubkeys', {});
    expect(bans.result.output).toEqual({
      pubkeys: [expect.objectContaining({ pubkey: a.pk, reason: 'spam' })],
    });
    const mutes = await act('moderation.list-muted-pubkeys', {});
    expect((mutes.result.output as { pubkeys: Array<{ pubkey: string }> }).pubkeys[0]?.pubkey).toBe(
      b.pk,
    );
    const allowed = await act('access.list-allowed-pubkeys', {});
    expect(allowed.result.output).toEqual({
      pubkeys: [expect.objectContaining({ pubkey: c.pk, reason: 'friend', via: 'admin' })],
    });
    const invites = await act('access.list-invites', {});
    const inv = (invites.result.output as { invites: Array<{ status: string }> }).invites;
    expect(inv).toHaveLength(1);
    expect(inv[0]?.status).toBe('active');

    // Expired mutes / invites drop out.
    ports.clock.advance(30 * 86400);
    const later = await act('moderation.list-muted-pubkeys', {});
    expect((later.result.output as { pubkeys: unknown[] }).pubkeys).toEqual([]);
    expect(
      ((await act('access.list-invites', {})).result.output as { invites: unknown[] }).invites,
    ).toEqual([]);
    expect(
      (
        (await act('access.list-invites', { includeExpired: true })).result.output as {
          invites: unknown[];
        }
      ).invites,
    ).toHaveLength(1);
  });
});
