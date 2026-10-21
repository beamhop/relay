// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, test } from 'bun:test';
import type { EffectiveLimits } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import {
  HOLDS_SERVICE,
  type LegalHolds,
  RETENTION_PROVIDERS_SERVICE,
  type RetentionProviders,
  createRetentionProviders,
} from '../src/index.ts';
import { DAY, cleanupAll, setup } from './helpers.ts';

afterEach(cleanupAll);

const limitsWith = (days?: number) => () =>
  ({ defaultRetentionDays: days, blockedKinds: [], overridden: [] }) as unknown as EffectiveLimits;

describe('retention provider registry', () => {
  test('longest answer wins; abstain; a failing provider keeps the data', async () => {
    const errors: string[] = [];
    const reg = createRetentionProviders((id) => errors.push(id));
    expect(reg.active()).toBe(false);
    expect(await reg.minDays('main')).toBeUndefined();
    const offA = reg.register({ id: 'a', retentionDays: () => 30, minDays: () => 30 });
    reg.register({ id: 'b', retentionDays: async (_r, pk) => (pk === 'x' ? 365 : undefined) });
    expect(await reg.daysFor('main', 'x')).toBe(365);
    expect(await reg.daysFor('main', 'y')).toBe(30);
    expect(await reg.minDays('main')).toBe(1); // b has no hint → scan from one day back
    offA();
    expect(await reg.daysFor('main', 'y')).toBeUndefined();
    reg.register({
      id: 'broken',
      retentionDays: () => {
        throw new Error('directory down');
      },
    });
    expect(await reg.daysFor('main', 'y')).toBe(Number.POSITIVE_INFINITY);
    expect(errors).toEqual(['broken']);
  });
});

describe.each([
  ['memory', false],
  ['sqlite', true],
])('retention job with providers (%s)', (_name, sql) => {
  test('providers lengthen relay retention and can add one where none exists', async () => {
    const t = await setup({ sql });
    const providers = t.kernel.use<RetentionProviders>(RETENTION_PROVIDERS_SERVICE)!;
    expect(providers).toBe(t.svc.retentionProviders);
    const finance = makeKey();
    const staff = makeKey();
    const guest = makeKey();
    const now = t.ports.clock.now();
    const evs = {
      finance: t.ev(finance, { created_at: now - 100 * DAY }),
      staff: t.ev(staff, { created_at: now - 100 * DAY }),
      guestOld: t.ev(guest, { created_at: now - 100 * DAY }),
    };
    for (const e of Object.values(evs)) await t.ports.events.save('main', e);

    // No relay retention: only the provider's answers apply (guest abstains → kept).
    providers.register({
      id: 'groups',
      retentionDays: (_r, pk) => (pk === finance.pk ? 7 * 365 : pk === staff.pk ? 90 : undefined),
      minDays: () => 90,
    });
    await t.svc.retention.tick();
    expect(await t.ports.events.getById('main', evs.finance.id)).not.toBeNull();
    expect(await t.ports.events.getById('main', evs.staff.id)).toBeNull();
    expect(await t.ports.events.getById('main', evs.guestOld.id)).not.toBeNull();

    // Relay retention 30 days: guest goes, finance is still kept (longest wins).
    t.kernel.setLimitsResolver(limitsWith(30));
    await t.svc.retention.tick();
    expect(await t.ports.events.getById('main', evs.guestOld.id)).toBeNull();
    expect(await t.ports.events.getById('main', evs.finance.id)).not.toBeNull();
  });

  test('kind rules are lengthened by providers too; holds still win', async () => {
    const t = await setup({
      sql,
      relays: [{ id: 'main', hosts: ['a.example'], retention: [{ kinds: [7], days: 7 }] }],
    });
    const kept = makeKey();
    const other = makeKey();
    const now = t.ports.clock.now();
    const a = t.ev(kept, { kind: 7, created_at: now - 30 * DAY });
    const b = t.ev(other, { kind: 7, created_at: now - 30 * DAY });
    await t.ports.events.save('main', a);
    await t.ports.events.save('main', b);
    t.svc.retentionProviders.register({
      id: 'p',
      retentionDays: (_r, pk) => (pk === kept.pk ? 365 : undefined),
    });
    await t.svc.retention.tick();
    expect(await t.ports.events.getById('main', a.id)).not.toBeNull();
    expect(await t.ports.events.getById('main', b.id)).toBeNull();

    // A provider shorter than a legal hold never deletes held data.
    t.ports.clock.advance(400 * DAY);
    const holds = t.kernel.use<LegalHolds>(HOLDS_SERVICE)!;
    const off = holds.register({ id: 'case', isHeld: (_r, s) => s.pubkey === kept.pk });
    await t.svc.retention.tick();
    expect(await t.ports.events.getById('main', a.id)).not.toBeNull();
    off();
    await t.svc.retention.tick();
    expect(await t.ports.events.getById('main', a.id)).toBeNull();
  });
});

describe('blob expiry with providers', () => {
  test('provider days set (and lengthen) the ownership expiry', async () => {
    const t = await setup({
      relays: [
        {
          id: 'main',
          hosts: ['a.example'],
          tiers: [{ id: 'default', name: 'Default', retentionDays: 30 }],
        },
      ],
    });
    const long = makeKey();
    const plain = makeKey();
    t.svc.retentionProviders.register({
      id: 'p',
      retentionDays: (_r, pk) => (pk === long.pk ? 365 : 10),
    });
    const uploadedAt = t.ports.clock.now();
    for (const [i, k] of [long, plain].entries()) {
      const sha = String(i).repeat(64);
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
    }
    await t.svc.idle();
    expect((await t.ports.blobIndex.owners('main', '0'.repeat(64)))[0]?.expiresAt).toBe(
      uploadedAt + 365 * DAY,
    );
    // Tier 30 days vs provider 10 days → the longer 30 days.
    expect((await t.ports.blobIndex.owners('main', '1'.repeat(64)))[0]?.expiresAt).toBe(
      uploadedAt + 30 * DAY,
    );
  });
});
