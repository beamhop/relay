// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import type { ActionContext, Principal } from '@beamhop/core';
import { COL } from '../src/store.ts';
import { makeKernel } from './helpers.ts';

const OWNER: Principal = { id: 'owner', roles: { '*': 'owner' }, via: 'cli' };

describe('enterprise.directory-status', () => {
  test('lists providers with people counts and the last directory sync', async () => {
    const h = await makeKernel({
      enterprise: {
        relays: ['corp'],
        idps: [
          { id: 'google', type: 'google', clientId: 'g' },
          {
            id: 'acme',
            type: 'oidc',
            label: 'Sign in with Acme',
            issuer: 'https://idp.example',
            clientId: 'c',
          },
        ],
      },
    });
    const def = h.kernel.actions.get('enterprise.directory-status');
    if (!def) throw new Error('action not registered');
    expect(def.readOnly).toBe(true);
    await h.kernel.ports.docs.put(COL.sync, 'google-last:google', {
      at: 1234,
      report: { users: { seen: 3 } },
    });
    const ctx: ActionContext = { principal: OWNER, relayId: null, ports: h.kernel.ports };
    const r = await def.run(def.input.parse({}), ctx);
    const out = r.output as {
      providers: Array<{ id: string; name: string; people: number; provisioning: string }>;
      directorySync: { enabled: boolean; configured: boolean; lastRunAt: number | null };
    };
    expect(out.providers.map((p) => [p.id, p.name, p.people, p.provisioning])).toEqual([
      ['google', 'Google Workspace', 0, 'none'],
      ['acme', 'Sign in with Acme', 0, 'none'],
    ]);
    expect(out.directorySync).toMatchObject({ enabled: false, configured: false, lastRunAt: 1234 });
  });
});
