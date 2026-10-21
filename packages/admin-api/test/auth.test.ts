// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import type { AdminClaimService } from '../src/index.ts';
import {
  NODE,
  ORIGIN,
  addMember,
  boot,
  bootClaimed,
  call,
  makeKey,
  nip98,
  nostrLogin,
} from './helpers.ts';
import { SoftAuthenticator } from './webauthn.ts';

describe('first-run claim', () => {
  test('claim code → first Nostr login becomes owner with recovery codes', async () => {
    const env = await boot();
    const claim = env.kernel.use<AdminClaimService>('admin.claim')!;
    expect(await claim.isClaimed()).toBe(false);
    const { code } = await claim.issueCode();
    expect(code).toMatch(/^[A-Z0-9]{4}(-[A-Z0-9]{4}){3}$/);
    expect((await claim.issueCode()).code).toBe(code); // stable until used

    const status = await call(env.kernel, 'GET', `${NODE}/auth/status`);
    expect(status.json.claimed).toBe(false);

    const owner = makeKey();
    const bad = await nostrLogin(env, owner, { claimCode: 'WRONG-CODE' });
    expect(bad.status).toBe(403);

    const res = await nostrLogin(env, owner, { claimCode: code.toLowerCase() });
    expect(res.status).toBe(200);
    expect(res.json.token).toBeString();
    expect(res.json.recoveryCodes).toHaveLength(10);
    expect(res.json.principal.roles).toEqual({ '*': 'owner' });
    expect(await claim.isClaimed()).toBe(true);
    expect(await claim.code()).toBeNull();
    await expect(claim.issueCode()).rejects.toThrow();

    // The code is one-time.
    const again = await nostrLogin(env, makeKey(), { claimCode: code });
    expect(again.status).toBe(403);

    const me = await call(env.kernel, 'GET', `${NODE}/auth/me`, { token: res.json.token });
    expect(me.status).toBe(200);
    expect(me.json.id).toBe(owner.pk);
    expect(me.json.permissions['*']).toContain('admins.manage');
  });

  test('`self` alias and unknown nodes', async () => {
    const env = await bootClaimed();
    const ok = await call(env.kernel, 'GET', `${ORIGIN}/api/v1/nodes/self/auth/me`, {
      token: env.ownerToken,
    });
    expect(ok.status).toBe(200);
    const nope = await call(env.kernel, 'GET', `${ORIGIN}/api/v1/nodes/other/auth/me`, {
      token: env.ownerToken,
    });
    expect(nope.status).toBe(404);
    expect(nope.json.error.code).toBe('unknown_node');
    const relay = await call(env.kernel, 'GET', `${NODE}/relays/ghost/config`, {
      token: env.ownerToken,
    });
    expect(relay.status).toBe(404);
  });
});

describe('NIP-98 login', () => {
  test('unknown key is refused; bad events are refused', async () => {
    const env = await bootClaimed();
    const stranger = await nostrLogin(env, makeKey());
    expect(stranger.status).toBe(403);
    expect(stranger.json.error.code).toBe('not_admin');

    const url = `${NODE}/auth/nostr`;
    // Wrong URL
    let auth = await nip98(env.ports, env.owner, `${NODE}/auth/other`, 'POST');
    let r = await call(env.kernel, 'POST', url, { headers: { authorization: auth } });
    expect(r.status).toBe(401);
    expect(r.json.error.technical).toBe('url mismatch');
    // Wrong method
    auth = await nip98(env.ports, env.owner, url, 'GET');
    r = await call(env.kernel, 'POST', url, { headers: { authorization: auth } });
    expect(r.json.error.technical).toBe('method mismatch');
    // Too old
    auth = await nip98(env.ports, env.owner, url, 'POST', undefined, env.ports.clock.now() - 120);
    r = await call(env.kernel, 'POST', url, { headers: { authorization: auth } });
    expect(r.status).toBe(401);
    // Body without payload hash
    auth = await nip98(env.ports, env.owner, url, 'POST');
    r = await call(env.kernel, 'POST', url, {
      headers: { authorization: auth },
      body: { displayName: 'x' },
    });
    expect(r.json.error.technical).toContain('payload');
    // Tampered signature
    auth = await nip98(env.ports, env.owner, url, 'POST');
    const ev = JSON.parse(atob(auth.slice(6)));
    ev.sig = `${ev.sig.slice(0, -2)}00`;
    r = await call(env.kernel, 'POST', url, {
      headers: { authorization: `Nostr ${btoa(JSON.stringify(ev))}` },
    });
    expect(r.json.error.technical).toBe('bad signature');
  });

  test('replayed auth event is refused', async () => {
    const env = await bootClaimed();
    const url = `${NODE}/auth/nostr`;
    const auth = await nip98(env.ports, env.owner, url, 'POST');
    const first = await call(env.kernel, 'POST', url, { headers: { authorization: auth } });
    expect(first.status).toBe(200);
    expect(first.json.principal.via).toBe('nip07');
    const second = await call(env.kernel, 'POST', url, { headers: { authorization: auth } });
    expect(second.status).toBe(401);
    expect(second.json.error.technical).toBe('auth event already used');
  });

  test('NIP-46 signer header and per-request NIP-98 auth on any route', async () => {
    const env = await bootClaimed();
    const url = `${NODE}/auth/me`;
    const auth = await nip98(env.ports, env.owner, url, 'GET');
    const r = await call(env.kernel, 'GET', url, {
      headers: { authorization: auth, 'x-nostr-signer': 'nip46' },
    });
    expect(r.status).toBe(200);
    expect(r.json.via).toBe('nip46');
  });

  test('sessions expire, survive key rotation, and can be revoked', async () => {
    const env = await bootClaimed();
    const me = () => call(env.kernel, 'GET', `${NODE}/auth/me`, { token: env.ownerToken });
    expect((await me()).status).toBe(200);
    // Rotation: old sessions keep working.
    env.ports.clock.advance(8 * 86400 - 12 * 3600);
    await env.ports.scheduler.tick('admin-api.rotate-keys');
    const fresh = await nostrLogin(env, env.owner);
    expect(fresh.status).toBe(200);
    // Old token expired by now (12h TTL), new one valid.
    expect((await me()).status).toBe(401);
    const meFresh = await call(env.kernel, 'GET', `${NODE}/auth/me`, { token: fresh.json.token });
    expect(meFresh.status).toBe(200);
    // Logout revokes.
    const out = await call(env.kernel, 'POST', `${NODE}/auth/logout`, { token: fresh.json.token });
    expect(out.status).toBe(200);
    expect(
      (await call(env.kernel, 'GET', `${NODE}/auth/me`, { token: fresh.json.token })).status,
    ).toBe(401);
    // Garbage tokens
    expect((await call(env.kernel, 'GET', `${NODE}/auth/me`, { token: 'a.b.c' })).status).toBe(401);
  });
});

describe('recovery and second owner', () => {
  test('recovery code makes a new key an owner, once', async () => {
    const env = await bootClaimed();
    const newKey = makeKey();
    const code = env.recoveryCodes[3]!;
    const r = await nostrLogin(env, newKey, { recoveryCode: code });
    expect(r.status).toBe(200);
    expect(r.json.principal.roles['*']).toBe('owner');
    const again = await nostrLogin(env, makeKey(), { recoveryCode: code });
    expect(again.status).toBe(403);
    const left = await call(env.kernel, 'GET', `${NODE}/auth/recovery-codes`, {
      token: r.json.token,
    });
    expect(left.json.remaining).toBe(9);
  });

  test('second owner via invite; regenerate codes', async () => {
    const env = await bootClaimed();
    const second = await addMember(env, 'owner');
    const me = await call(env.kernel, 'GET', `${NODE}/auth/me`, { token: second.token });
    expect(me.json.roles['*']).toBe('owner');
    const regen = await call(env.kernel, 'POST', `${NODE}/actions/admins.recovery-codes`, {
      token: second.token,
      body: { input: {} },
    });
    expect(regen.status).toBe(200);
    expect(regen.json.output.codes).toHaveLength(10);
    // Old codes no longer work.
    const old = await nostrLogin(env, makeKey(), { recoveryCode: env.recoveryCodes[0] });
    expect(old.status).toBe(403);
    const fresh = await nostrLogin(env, makeKey(), { recoveryCode: regen.json.output.codes[0] });
    expect(fresh.status).toBe(200);
  });

  test('invite code redeemed at Nostr login', async () => {
    const env = await bootClaimed();
    const inv = await call(env.kernel, 'POST', `${NODE}/actions/admins.invite`, {
      token: env.ownerToken,
      body: { input: { role: 'moderator', relayId: 'team', displayName: 'Mo' } },
    });
    expect(inv.status).toBe(200);
    const code = inv.json.output.code as string;
    const key = makeKey();
    const r = await nostrLogin(env, key, { inviteCode: code });
    expect(r.status).toBe(200);
    expect(r.json.principal.roles).toEqual({ team: 'moderator' });
    expect(r.json.principal.displayName).toBe('Mo');
    expect((await nostrLogin(env, makeKey(), { inviteCode: code })).status).toBe(403);
  });
});

describe('passkeys', () => {
  const origin = ORIGIN;

  test('claim with a passkey, then sign in with it', async () => {
    const env = await boot();
    const code = (await env.kernel.use<AdminClaimService>('admin.claim')!.issueCode()).code;
    const auth = await SoftAuthenticator.create();

    const noCode = await call(env.kernel, 'POST', `${NODE}/auth/passkey/register/options`, {
      body: {},
    });
    expect(noCode.status).toBe(401);

    const opts = await call(env.kernel, 'POST', `${NODE}/auth/passkey/register/options`, {
      body: { claimCode: code, displayName: 'Keymaster' },
      headers: { origin },
    });
    expect(opts.status).toBe(200);
    expect(opts.json.options.rp.id).toBe('localhost');
    const response = await auth.register(opts.json.options, origin);
    const done = await call(env.kernel, 'POST', `${NODE}/auth/passkey/register/verify`, {
      body: { challengeId: opts.json.challengeId, response, label: 'Laptop' },
      headers: { origin },
    });
    expect(done.status).toBe(200);
    expect(done.json.principal.id).toBe(`passkey:${auth.id}`);
    expect(done.json.principal.roles).toEqual({ '*': 'owner' });
    expect(done.json.recoveryCodes).toHaveLength(10);

    // Challenge is one-time.
    const replay = await call(env.kernel, 'POST', `${NODE}/auth/passkey/register/verify`, {
      body: { challengeId: opts.json.challengeId, response },
    });
    expect(replay.status).toBe(400);

    const lo = await call(env.kernel, 'POST', `${NODE}/auth/passkey/login/options`, {
      headers: { origin },
    });
    const assertion = await auth.login(lo.json.options, origin);
    const login = await call(env.kernel, 'POST', `${NODE}/auth/passkey/login/verify`, {
      body: { challengeId: lo.json.challengeId, response: assertion },
      headers: { origin },
    });
    expect(login.status).toBe(200);
    expect(login.json.principal.via).toBe('passkey');
    const me = await call(env.kernel, 'GET', `${NODE}/auth/me`, { token: login.json.token });
    expect(me.json.id).toBe(`passkey:${auth.id}`);
  });

  test('a signed-in Nostr admin adds a passkey; a wrong key is rejected', async () => {
    const env = await bootClaimed();
    const auth = await SoftAuthenticator.create();
    const opts = await call(env.kernel, 'POST', `${NODE}/auth/passkey/register/options`, {
      token: env.ownerToken,
      body: {},
    });
    expect(opts.status).toBe(200);
    const done = await call(env.kernel, 'POST', `${NODE}/auth/passkey/register/verify`, {
      body: {
        challengeId: opts.json.challengeId,
        response: await auth.register(opts.json.options, origin),
      },
    });
    expect(done.status).toBe(200);
    expect(done.json.credentialId).toBe(auth.id);

    const lo = await call(env.kernel, 'POST', `${NODE}/auth/passkey/login/options`);
    const login = await call(env.kernel, 'POST', `${NODE}/auth/passkey/login/verify`, {
      body: {
        challengeId: lo.json.challengeId,
        response: await auth.login(lo.json.options, origin),
      },
    });
    expect(login.status).toBe(200);
    expect(login.json.principal.id).toBe(env.owner.pk);

    // An unregistered authenticator (or wrong origin) fails.
    const other = await SoftAuthenticator.create();
    const lo2 = await call(env.kernel, 'POST', `${NODE}/auth/passkey/login/options`);
    const bad = await call(env.kernel, 'POST', `${NODE}/auth/passkey/login/verify`, {
      body: {
        challengeId: lo2.json.challengeId,
        response: await other.login(lo2.json.options, origin),
      },
    });
    expect(bad.status).toBe(401);
    const lo3 = await call(env.kernel, 'POST', `${NODE}/auth/passkey/login/options`);
    const evil = await call(env.kernel, 'POST', `${NODE}/auth/passkey/login/verify`, {
      body: {
        challengeId: lo3.json.challengeId,
        response: await auth.login(lo3.json.options, 'https://evil.example'),
      },
    });
    expect(evil.status).toBe(401);
  });
});

describe('API tokens', () => {
  test('scoped, expiring, hashed; revocation; no escalation', async () => {
    const env = await bootClaimed();
    const created = await call(env.kernel, 'POST', `${NODE}/actions/tokens.create`, {
      token: env.ownerToken,
      body: { input: { name: 'ci', scopes: ['relay.read'], expiresInDays: 1 } },
    });
    expect(created.status).toBe(200);
    const tok = created.json.output.token as string;
    expect(tok).toMatch(/^bh_/);
    expect(JSON.stringify(created.json.output)).not.toContain('hash');

    const me = await call(env.kernel, 'GET', `${NODE}/auth/me`, { token: tok });
    expect(me.status).toBe(200);
    expect(me.json.via).toBe('token');
    expect(me.json.permissions['*']).toEqual(['relay.read']);
    // Scope narrows: cannot change config even though the owner could.
    const denied = await call(env.kernel, 'POST', `${NODE}/config/propose`, {
      token: tok,
      body: { merge: {} },
    });
    expect(denied.status).toBe(403);
    // Tokens cannot mint tokens.
    const mint = await call(env.kernel, 'POST', `${NODE}/actions/tokens.create`, {
      token: tok,
      body: { input: { name: 'x' } },
    });
    expect(mint.status).toBe(403);
    // Wrong secret
    expect(
      (await call(env.kernel, 'GET', `${NODE}/auth/me`, { token: `${tok.slice(0, -4)}0000` }))
        .status,
    ).toBe(401);
    // Expiry
    env.ports.clock.advance(86400 + 1);
    expect((await call(env.kernel, 'GET', `${NODE}/auth/me`, { token: tok })).status).toBe(401);

    // Revoke
    const t2 = await call(env.kernel, 'POST', `${NODE}/actions/tokens.create`, {
      token: (await nostrLogin(env, env.owner)).json.token,
      body: { input: { name: 'bot' } },
    });
    const ownerToken = (await nostrLogin(env, env.owner)).json.token;
    const list = await call(env.kernel, 'POST', `${NODE}/actions/tokens.list`, {
      token: ownerToken,
      body: { input: {} },
    });
    expect(list.json.output.tokens.map((t: { name: string }) => t.name)).toContain('bot');
    const rv = await call(env.kernel, 'POST', `${NODE}/actions/tokens.revoke`, {
      token: ownerToken,
      body: { input: { id: t2.json.output.id } },
    });
    expect(rv.status).toBe(200);
    expect(
      (await call(env.kernel, 'GET', `${NODE}/auth/me`, { token: t2.json.output.token })).status,
    ).toBe(401);

    // A moderator cannot grant a token more than they have.
    env.ownerToken = ownerToken;
    const mod = await addMember(env, 'moderator', 'main');
    const esc = await call(env.kernel, 'POST', `${NODE}/actions/tokens.create`, {
      token: mod.token,
      body: { input: { name: 'x', scopes: ['config.write'] } },
    });
    expect(esc.status).toBe(403);
  });
});
