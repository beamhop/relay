// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, test } from 'bun:test';
import type { AppEvents, EffectiveLimits } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import { HOLDS_SERVICE, type LegalHolds } from '../src/index.ts';
import { DAY, cleanupAll, setup } from './helpers.ts';

afterEach(cleanupAll);

const limitsWith = (days?: number) => () =>
  ({ defaultRetentionDays: days, blockedKinds: [], overridden: [] }) as unknown as EffectiveLimits;

describe.each([
  ['memory', false],
  ['sqlite', true],
])('retention (%s)', (_name, sql) => {
  test('per-kind rules delete old events of that kind only', async () => {
    const t = await setup({
      sql,
      relays: [{ id: 'main', hosts: ['a.example'], retention: [{ kinds: [7], days: 7 }] }],
    });
    const k = makeKey();
    const now = t.ports.clock.now();
    const oldReaction = t.ev(k, { kind: 7, created_at: now - 10 * DAY });
    const newReaction = t.ev(k, { kind: 7, created_at: now - 2 * DAY });
    const oldNote = t.ev(k, { kind: 1, created_at: now - 100 * DAY });
    for (const e of [oldReaction, newReaction, oldNote]) await t.ports.events.save('main', e);

    const deleted: AppEvents['event.deleted'][] = [];
    t.kernel.bus.on('event.deleted', (p) => deleted.push(p));
    const [r] = await t.svc.retention.tick();
    expect(r?.deleted).toBe(1);
    expect(await t.ports.events.getById('main', oldReaction.id)).toBeNull();
    expect(await t.ports.events.getById('main', newReaction.id)).not.toBeNull();
    expect(await t.ports.events.getById('main', oldNote.id)).not.toBeNull();
    expect(deleted).toEqual([
      { relayId: 'main', ids: [oldReaction.id], cause: 'retention', count: 1 },
    ]);
    const st = await t.svc.retention.state('main');
    expect(st.lastCompleteAt).toBe(now);
  });

  test('tier retention beats relay-wide rule; protected kinds survive', async () => {
    const t = await setup({
      sql,
      relays: [
        {
          id: 'main',
          hosts: ['a.example'],
          tiers: [
            { id: 'default', name: 'Default' },
            { id: 'plus', name: 'Plus', retentionDays: 365 },
          ],
          retention: [{ days: 30 }],
        },
      ],
    });
    const free = makeKey();
    const plus = makeKey();
    t.kernel.access.push({
      id: 'test',
      tierOf: async (_r, pk) => (pk === plus.pk ? 'plus' : undefined),
    });
    const now = t.ports.clock.now();
    const freeOld = t.ev(free, { created_at: now - 40 * DAY });
    const freeNew = t.ev(free, { created_at: now - 10 * DAY });
    const plusOld = t.ev(plus, { created_at: now - 40 * DAY });
    const plusAncient = t.ev(plus, { created_at: now - 400 * DAY });
    const profile = t.ev(free, { kind: 0, created_at: now - 400 * DAY, content: '{}' });
    for (const e of [freeOld, freeNew, plusOld, plusAncient, profile])
      await t.ports.events.save('main', e);

    await t.svc.retention.tick();
    const left = new Set((await t.ports.events.query('main', [{}])).map((e) => e.id));
    expect(left.has(freeOld.id)).toBe(false);
    expect(left.has(freeNew.id)).toBe(true);
    expect(left.has(plusOld.id)).toBe(true);
    expect(left.has(plusAncient.id)).toBe(false);
    expect(left.has(profile.id)).toBe(true);
  });

  test('goals-derived default retention applies with FakeClock', async () => {
    const t = await setup({ sql });
    t.kernel.setLimitsResolver(limitsWith(90));
    const k = makeKey();
    const e = t.ev(k);
    await t.ports.events.save('main', e);
    await t.svc.retention.tick();
    expect(await t.ports.events.getById('main', e.id)).not.toBeNull();
    t.ports.clock.advance(91 * DAY);
    await t.svc.retention.tick();
    expect(await t.ports.events.getById('main', e.id)).toBeNull();
  });

  test('legal hold blocks deletion', async () => {
    const t = await setup({ sql });
    t.kernel.setLimitsResolver(limitsWith(30));
    const held = makeKey();
    const other = makeKey();
    const now = t.ports.clock.now();
    const a = t.ev(held, { created_at: now - 60 * DAY });
    const b = t.ev(other, { created_at: now - 60 * DAY });
    await t.ports.events.save('main', a);
    await t.ports.events.save('main', b);
    const holds = t.kernel.use<LegalHolds>(HOLDS_SERVICE) as LegalHolds;
    expect(await holds.isHeld('main', { pubkey: held.pk })).toBe(false);
    const off = holds.register({ id: 'case-1', isHeld: (_r, s) => s.pubkey === held.pk });
    expect(await holds.isHeld('main', { pubkey: held.pk })).toBe(true);

    await t.svc.retention.tick();
    expect(await t.ports.events.getById('main', a.id)).not.toBeNull();
    expect(await t.ports.events.getById('main', b.id)).toBeNull();

    off();
    await t.svc.retention.tick();
    expect(await t.ports.events.getById('main', a.id)).toBeNull();
  });

  test('chunked sweep resumes from cursor across runs', async () => {
    const t = await setup({
      sql,
      lifecycle: { retention: { chunkSize: 10, maxEventsPerRun: 100 } },
      relays: [{ id: 'main', hosts: ['a.example'], retention: [{ kinds: [1], days: 1 }] }],
    });
    const k = makeKey();
    const now = t.ports.clock.now();
    for (let i = 0; i < 250; i++)
      await t.ports.events.save('main', t.ev(k, { created_at: now - 2 * DAY - i }));
    const r1 = await t.svc.retention.tick();
    expect(r1[0]?.deleted).toBe(100);
    expect(r1[0]?.complete).toBe(false);
    expect((await t.svc.retention.state('main')).lastCompleteAt).toBeUndefined();
    await t.svc.retention.tick();
    const r3 = await t.svc.retention.tick();
    expect(r3[0]?.complete).toBe(true);
    expect(await t.ports.events.count('main', [{}])).toBe(0);
  });
});

describe('blob expiry', () => {
  test('tier retention sets expiresAt on upload', async () => {
    const t = await setup({
      relays: [
        {
          id: 'main',
          hosts: ['a.example'],
          tiers: [{ id: 'default', name: 'Default', retentionDays: 30 }],
        },
      ],
    });
    const k = makeKey();
    const sha = 'a'.repeat(64);
    const uploadedAt = t.ports.clock.now();
    await t.ports.blobIndex.addOwner({
      relayId: 'main',
      sha256: sha,
      pubkey: k.pk,
      size: 10,
      type: 'image/png',
      uploadedAt,
    });
    t.kernel.bus.emit('blob.uploaded', {
      relayId: 'main',
      sha256: sha,
      size: 10,
      type: 'image/png',
      pubkey: k.pk,
    });
    await t.svc.idle();
    const [own] = await t.ports.blobIndex.owners('main', sha);
    expect(own?.expiresAt).toBe(uploadedAt + 30 * DAY);
  });

  test('no tier retention → no expiry; held blobs are postponed', async () => {
    const t = await setup();
    const k = makeKey();
    const sha = 'b'.repeat(64);
    const now = t.ports.clock.now();
    await t.ports.blobIndex.addOwner({
      relayId: 'main',
      sha256: sha,
      pubkey: k.pk,
      size: 10,
      type: 'image/png',
      uploadedAt: now,
    });
    t.kernel.bus.emit('blob.uploaded', {
      relayId: 'main',
      sha256: sha,
      size: 10,
      type: 'image/png',
      pubkey: k.pk,
    });
    await t.svc.idle();
    expect((await t.ports.blobIndex.owners('main', sha))[0]?.expiresAt).toBeUndefined();

    await t.ports.blobIndex.addOwner({
      relayId: 'main',
      sha256: sha,
      pubkey: k.pk,
      size: 10,
      type: 'image/png',
      uploadedAt: now,
      expiresAt: now + 60,
    });
    t.svc.holds.register({ id: 'hold', isHeld: (_r, s) => s.sha256 === sha });
    await t.svc.retention.tick();
    const exp = (await t.ports.blobIndex.owners('main', sha))[0]?.expiresAt ?? 0;
    expect(exp).toBeGreaterThan(now + 3600);
  });
});

describe('storage caps', () => {
  const big = 'x'.repeat(2000);

  async function fill(t: Awaited<ReturnType<typeof setup>>) {
    const k = makeKey();
    const now = t.ports.clock.now();
    const reactions = [];
    for (let i = 0; i < 20; i++) {
      const e = t.ev(k, { kind: 7, content: big, created_at: now - (30 - i) * DAY });
      reactions.push(e);
      await t.ports.events.save('main', e);
    }
    const note = t.ev(k, { kind: 1, content: big, created_at: now - 40 * DAY });
    await t.ports.events.save('main', note);
    return { reactions, note };
  }

  test('over the cap → suggestion card only (no autopilot)', async () => {
    const t = await setup({ lifecycle: { storageCaps: { main: { maxBytes: 30_000 } } } });
    const { reactions } = await fill(t);
    await t.svc.retention.tick();
    expect(await t.ports.events.count('main', [{}])).toBe(21);
    const cards = (await t.kernel.cards[0]?.cards('main')) ?? [];
    const card = cards.find((c) => c.id === 'lifecycle.storage-over:main');
    expect(card?.primary?.actionId).toBe('lifecycle.prune-storage');

    const { preview, result } = await t.act('lifecycle.prune-storage', {});
    expect(preview[0]?.kind).toBe('remove');
    expect((result.output as { deleted: number }).deleted).toBeGreaterThan(0);
    // Oldest reactions went first; the regular note stays.
    expect(await t.ports.events.getById('main', reactions[0]?.id as string)).toBeNull();
    expect(await t.ports.events.getById('main', reactions[19]?.id as string)).not.toBeNull();
    const stats = await t.ports.events.stats('main');
    expect(stats.bytes).toBeLessThanOrEqual(27_000);
  });

  test('autoPrune enabled → the scheduled job prunes', async () => {
    const t = await setup({
      lifecycle: { storageCaps: { '*': { maxBytes: 30_000, autoPrune: true } } },
    });
    const { note } = await fill(t);
    const [r] = await t.svc.retention.tick();
    expect(r?.pruned).toBeGreaterThan(0);
    expect(await t.ports.events.getById('main', note.id)).not.toBeNull();
    const cards = (await t.kernel.cards[0]?.cards('main')) ?? [];
    expect(cards.some((c) => c.id.startsWith('lifecycle.storage-over'))).toBe(false);
  });
});

describe('restore guard', () => {
  test('writes are refused while restoring', async () => {
    const t = await setup();
    const k = makeKey();
    const e = t.ev(k);
    const ctx = { relayId: 'main', now: t.ports.clock.now() };
    expect((await t.kernel.policy.run('onEvent', [e, ctx])).action).toBe('accept');
    (t.svc as unknown as { backups: { rt: { restoring: boolean } } }).backups.rt.restoring = true;
    const d = await t.kernel.policy.run('onEvent', [e, ctx]);
    expect(d.action).toBe('reject');
  });
});
