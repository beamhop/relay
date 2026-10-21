// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { runAction, setup } from './helpers.ts';

describe('keyvault.list-keys', () => {
  test('lists managed keys without their wrapped secret', async () => {
    const { kernel, svc } = await setup();
    const pk = await svc.ensureKey('google:alice');
    await svc.ensureKey('google:bob');
    const r = await runAction(kernel, 'keyvault.list-keys', {});
    const keys = (r.output as { keys: Array<Record<string, unknown>> }).keys;
    expect(keys.map((k) => k.subjectId).sort()).toEqual(['google:alice', 'google:bob']);
    expect(keys.find((k) => k.subjectId === 'google:alice')).toMatchObject({
      pubkey: pk,
      status: 'active',
    });
    expect(JSON.stringify(keys)).not.toContain('wrappedSk');
    const none = await runAction(kernel, 'keyvault.list-keys', { status: 'destroyed' });
    expect((none.output as { keys: unknown[] }).keys).toEqual([]);
  });
});
