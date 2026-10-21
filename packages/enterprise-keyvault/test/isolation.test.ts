// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import type { KeyVaultService } from '@beamhop/enterprise-identity';
import { SERVICE, keyvaultRuntime } from '../src/index.ts';
import { setup } from './helpers.ts';

describe('isolation (§12.0)', () => {
  test('without module config: no routes, actions, services, checks, cards, jobs or wrapper', async () => {
    const bare = await setup({ keyvault: null, withRelay: true });
    const base = await setup({ keyvault: null, withRelay: true });
    expect(bare.kernel.use(SERVICE)).toBeUndefined();
    expect(keyvaultRuntime(bare.kernel)).toBeUndefined();
    expect(
      bare.kernel.actions.list().filter((a) => /^(keyvault|escrow)\./.test(a.id)),
    ).toHaveLength(0);
    expect(bare.kernel.health.filter((h) => h.id.startsWith('keyvault'))).toHaveLength(0);
    expect(bare.kernel.cards.filter((c) => c.id === 'keyvault')).toHaveLength(0);
    expect(bare.kernel.ui).toHaveLength(0);
    expect(bare.ports.keyWrapper).toBeUndefined();
    expect([...bare.ports.scheduler.jobs.keys()].filter((j) => j.startsWith('keyvault'))).toEqual(
      [],
    );
    expect(bare.kernel.http.routes.length).toBe(base.kernel.http.routes.length);
    expect(bare.kernel.config().modules['enterprise-keyvault']).toBeUndefined();
    expect(await bare.ports.docs.list('keyvault.deks')).toEqual({ items: [] });
  });

  test('with module config everything is registered', async () => {
    const h = await setup({ withRelay: true });
    expect(h.kernel.use(SERVICE)).toBeDefined();
    expect(
      h.kernel.actions
        .list()
        .map((a) => a.id)
        .filter((id) => /^(keyvault|escrow)\./.test(id)),
    ).toEqual([
      'escrow.decrypt-dm',
      'keyvault.audit',
      'keyvault.cancel-destroy',
      'keyvault.destroy-key',
      'keyvault.revoke-sessions',
      'keyvault.rotate-kek',
      'keyvault.status',
      'keyvault.wrap-legacy-keys',
    ]);
    for (const id of ['escrow.decrypt-dm', 'keyvault.rotate-kek', 'keyvault.destroy-key'])
      expect(h.kernel.actions.get(id)?.sensitive).toBe(true);
    expect(h.ports.keyWrapper?.provider).toBe('keyvault');
    expect([...h.ports.scheduler.jobs.keys()]).toContain('keyvault.shred');
  });
});

describe('contract with enterprise-identity', () => {
  test('the service satisfies the identity module’s KeyVaultService view', async () => {
    const h = await setup();
    const view: KeyVaultService = h.svc; // compile-time check
    const pk = await view.ensureKey('google:alice');
    expect(await view.bunkerUrlFor('sid', 'google:alice')).toStartWith('bunker://');
    const ev = await view.sign?.('google:alice', {
      kind: 0,
      content: '{}',
      tags: [],
      created_at: 1,
      pubkey: pk,
    });
    expect(ev?.pubkey).toBe(pk);
    await view.revokeSessions?.('google:alice', 'sid');
    await view.destroyKey?.('google:alice', 'grace period over');
    expect(await h.svc.pubkeyOf('google:alice')).toBeNull();
  });
});
