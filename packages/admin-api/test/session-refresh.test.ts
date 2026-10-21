// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import type { AdminSessionsService } from '../src/index.ts';
import { NODE, bootClaimed, call } from './helpers.ts';

const REFRESH = `${NODE}/session/refresh`;

describe('session refresh', () => {
  test('a Nostr session is swapped for a fresh one with a sliding expiry', async () => {
    const env = await bootClaimed();
    env.ports.clock.advance(3600);
    const r = await call(env.kernel, 'POST', REFRESH, { token: env.ownerToken });
    expect(r.status).toBe(200);
    expect(r.json.token).toBeString();
    expect(r.json.token).not.toBe(env.ownerToken);
    expect(r.json.expiresAt).toBe(env.ports.clock.now() + 12 * 3600);
    expect(r.json.principal.id).toBe(env.owner.pk);
    const me = await call(env.kernel, 'GET', `${NODE}/auth/me`, { token: r.json.token });
    expect(me.status).toBe(200);
    expect(me.json.via).toBe('nip07');
  });

  test('the absolute max age bounds every refresh', async () => {
    const env = await bootClaimed();
    let token = env.ownerToken;
    const start = env.ports.clock.now();
    const maxAge = 7 * 86400;
    // Refresh every 11 hours until the max age caps the expiry.
    for (let i = 0; i < 20; i++) {
      env.ports.clock.advance(11 * 3600);
      const r = await call(env.kernel, 'POST', REFRESH, { token });
      if (env.ports.clock.now() >= start + maxAge) {
        expect(r.status).toBe(401);
        break;
      }
      expect(r.status).toBe(200);
      expect(r.json.expiresAt).toBeLessThanOrEqual(start + maxAge);
      token = r.json.token;
    }
    // The last token expires exactly at the max age.
    env.ports.clock.ms = (start + maxAge - 10) * 1000;
    const last = await call(env.kernel, 'POST', REFRESH, { token });
    expect(last.status).toBe(200);
    expect(last.json.expiresAt).toBe(start + maxAge);
    env.ports.clock.ms = (start + maxAge) * 1000;
    const late = await call(env.kernel, 'POST', REFRESH, { token: last.json.token });
    expect(late.status).toBe(401);
  });

  test('expired, revoked, missing and API-token credentials are refused', async () => {
    const env = await bootClaimed();
    expect((await call(env.kernel, 'POST', REFRESH)).status).toBe(401);
    expect((await call(env.kernel, 'POST', REFRESH, { token: 'garbage' })).status).toBe(401);
    const api = await call(env.kernel, 'POST', `${NODE}/actions/tokens.create`, {
      token: env.ownerToken,
      body: { input: { name: 'ci', scopes: ['relay.read'] } },
    });
    expect(api.status).toBe(200);
    const bh = api.json.output.token as string;
    const r = await call(env.kernel, 'POST', REFRESH, { token: bh });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('not_a_session');
    // Logged-out sessions cannot be refreshed.
    const second = await call(env.kernel, 'POST', REFRESH, { token: env.ownerToken });
    await call(env.kernel, 'POST', `${NODE}/auth/logout`, { token: second.json.token });
    expect((await call(env.kernel, 'POST', REFRESH, { token: second.json.token })).status).toBe(
      401,
    );
    // Expired sessions cannot be refreshed.
    env.ports.clock.advance(12 * 3600 + 1);
    const old = await call(env.kernel, 'POST', REFRESH, { token: env.ownerToken });
    expect(old.status).toBe(401);
    expect(old.json.error.code).toBe('session_expired');
  });

  test('SSO and passkey sessions refresh too; removed admins cannot', async () => {
    const env = await bootClaimed();
    const dir = env.kernel.use<{
      put(r: unknown): Promise<void>;
      remove(id: string): Promise<boolean>;
    }>('admin.directory')!;
    await dir.put({
      id: 'sso:google:alice',
      roles: { '*': 'admin' },
      createdAt: env.ports.clock.now(),
      createdBy: 'enterprise-identity',
      displayName: 'Alice',
    });
    const sessions = env.kernel.use<AdminSessionsService>('admin.sessions')!;
    for (const via of ['sso', 'passkey'] as const) {
      const s = await sessions.issue('sso:google:alice', via);
      env.ports.clock.advance(60);
      const r = await call(env.kernel, 'POST', REFRESH, { token: s.token });
      expect(r.status).toBe(200);
      expect(r.json.principal.via).toBe(via);
    }
    const s = await sessions.issue('sso:google:alice', 'sso');
    await dir.remove('sso:google:alice');
    const r = await call(env.kernel, 'POST', REFRESH, { token: s.token });
    expect(r.status).toBe(401);
  });
});
