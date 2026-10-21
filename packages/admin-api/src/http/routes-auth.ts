// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sign-in routes: Nostr (NIP-98 from NIP-07/NIP-46 signers), passkeys, the
 * first-run claim, invites and owner recovery codes. All issue session JWTs.
 */
import { type Principal, type Role, permissionsFor } from '@beamhop/core';
import { z } from 'zod';
import { type AdminRecord, displayNameOf, isOwner } from '../auth/directory.ts';
import type { RpContext } from '../auth/passkeys.ts';
import { nip98For, signerVia } from '../auth/providers.ts';
import { HttpError } from '../util.ts';
import { type Api, type Ctx, type Deps, op, requirePrincipal } from './api.ts';

const Codes = z.object({
  claimCode: z
    .string()
    .max(100)
    .optional()
    .describe('One-time code printed by the server on first start'),
  inviteCode: z.string().max(100).optional().describe('Invite code from an owner'),
  recoveryCode: z.string().max(100).optional().describe('Owner recovery code'),
  displayName: z.string().max(80).optional().describe('Name shown to the team'),
});
type CodesT = z.infer<typeof Codes>;

const WebAuthnResponse = z
  .record(z.string(), z.unknown())
  .describe('WebAuthn credential JSON from the browser');

export function rpContext(deps: Deps, c: Ctx): RpContext {
  const s = deps.settings().passkeys;
  const url = new URL(c.req.url);
  if (deps.kernel.config().node.trustProxy) {
    const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
    const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
    if (host) url.host = host;
    if (proto) url.protocol = `${proto}:`;
  }
  const rpId = s.rpId ?? url.hostname;
  const origins = new Set<string>([...s.origins, url.origin]);
  const origin = c.req.header('origin');
  if (origin) {
    try {
      const h = new URL(origin).hostname;
      if (h === rpId || h.endsWith(`.${rpId}`)) origins.add(new URL(origin).origin);
    } catch {
      // ignore malformed Origin
    }
  }
  return { rpId, rpName: s.rpName, origins: [...origins] };
}

export function describePrincipal(deps: Deps, p: Principal) {
  const relays = deps.kernel.config().relays.map((r) => r.id);
  const permissions: Record<string, string[]> = { '*': [...permissionsFor(p, null)] };
  for (const r of relays) permissions[r] = [...permissionsFor(p, r)];
  return {
    id: p.id,
    pubkey: p.pubkey,
    displayName: p.displayName,
    roles: p.roles,
    via: p.via,
    scopes: p.scopes,
    permissions,
  };
}

/**
 * Turn a redeemable code into admin membership for `id`. Returns the updated
 * record (or null when no code applies) plus recovery codes for a fresh owner.
 */
async function redeemCodes(
  deps: Deps,
  codes: CodesT,
  id: string,
  pubkey: string | undefined,
  existing: AdminRecord | null,
): Promise<{ rec: AdminRecord; recoveryCodes?: string[]; event?: [string, string] } | null> {
  const { dir, kernel } = deps;
  const now = kernel.ports.clock.now();
  const base = (roles: AdminRecord['roles'], createdBy: string): AdminRecord => {
    const rec: AdminRecord = existing
      ? { ...existing, roles: { ...existing.roles, ...roles } }
      : { id, roles, createdAt: now, createdBy };
    if (pubkey) rec.pubkey = pubkey;
    if (codes.displayName && !rec.displayName) rec.displayName = codes.displayName;
    return rec;
  };
  if (codes.claimCode) {
    if (!(await dir.redeemClaim(codes.claimCode)))
      throw new HttpError(
        403,
        'bad_code',
        'That claim code is not valid (or this relay is already claimed)',
      );
    const rec = base({ '*': 'owner' }, 'claim');
    await dir.put(rec);
    const recoveryCodes = await dir.regenerateRecoveryCodes();
    return {
      rec,
      recoveryCodes,
      event: ['auth.claim', 'Claimed this server and became its owner'],
    };
  }
  if (codes.recoveryCode) {
    if (!(await dir.redeemRecovery(codes.recoveryCode)))
      throw new HttpError(403, 'bad_code', 'That recovery code is not valid or was already used');
    const rec = base({ '*': 'owner' }, 'recovery');
    await dir.put(rec);
    return { rec, event: ['auth.recover', 'Used an owner recovery code and became an owner'] };
  }
  if (codes.inviteCode) {
    const inv = await dir.redeemInvite(codes.inviteCode);
    if (!inv) throw new HttpError(403, 'bad_code', 'That invite code is not valid or has expired');
    const rec = base(inv.roles, inv.createdBy);
    if (inv.displayName && !rec.displayName) rec.displayName = inv.displayName;
    await dir.put(rec);
    const role = Object.values(inv.roles)[0] as Role;
    return { rec, event: ['auth.invite-accepted', `Joined the team as ${role}`] };
  }
  return null;
}

async function checkCodes(deps: Deps, codes: CodesT): Promise<boolean> {
  if (codes.claimCode) return deps.dir.checkClaim(codes.claimCode);
  if (codes.recoveryCode) return deps.dir.checkRecovery(codes.recoveryCode);
  if (codes.inviteCode) return !!(await deps.dir.peekInvite(codes.inviteCode));
  return false;
}

function emitAuth(deps: Deps, principalId: string, ev: [string, string] | undefined) {
  if (!ev) return;
  deps.kernel.bus.emit('admin.action', {
    relayId: null,
    actionId: ev[0],
    principalId,
    input: {},
    summary: ev[1],
    ok: true,
  });
}

async function sessionResponse(
  c: Ctx,
  deps: Deps,
  rec: AdminRecord,
  via: Principal['via'],
  extra: Record<string, unknown> = {},
) {
  const s = await deps.sessions.issue(rec.id, via);
  await deps.audit.flush();
  return c.json({
    token: s.token,
    expiresAt: s.expiresAt,
    principal: describePrincipal(deps, deps.dir.principalOf(rec, via)),
    ...extra,
  });
}

export function authRoutes(api: Api, deps: Deps): void {
  const { kernel, dir, passkeys } = deps;
  const tags = ['Sign-in'];

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/auth/status',
      scope: 'node',
      guard: 'public',
      tags,
      summary: 'Is this server claimed, and how can I sign in?',
    },
    async (c) =>
      c.json({
        node: kernel.config().node.id,
        claimed: await dir.isClaimed(),
        providers: kernel.authProviders.map((p) => ({ id: p.id, label: p.label })),
        passkeys: true,
      }),
  );

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/auth/me',
      scope: 'node',
      guard: 'authenticated',
      tags,
      summary: 'Who am I and what may I do?',
    },
    async (c) => c.json(describePrincipal(deps, requirePrincipal(c))),
  );

  op(
    api,
    deps,
    {
      method: 'post',
      path: '/auth/nostr',
      scope: 'node',
      guard: 'public',
      tags,
      summary: 'Sign in with Nostr (NIP-07 extension or NIP-46 bunker)',
      description:
        'Send a NIP-98 `Authorization: Nostr …` header (kind 27235, `u` = this URL, `method` = POST, `payload` = SHA-256 of the body when present). Optional body redeems a claim, invite or recovery code.',
      body: Codes,
    },
    async (c, { body }) => {
      const res = await nip98For(kernel, c.req.raw);
      if (!res.ok)
        throw new HttpError(401, 'bad_signature', 'Sign-in failed. Please try again.', res.reason);
      const pk = res.event.pubkey;
      const existing = await dir.get(pk);
      const redeemed = await redeemCodes(deps, body, pk, pk, existing);
      const rec = redeemed?.rec ?? existing;
      if (!rec)
        throw new HttpError(
          403,
          'not_admin',
          'This key is not on the team yet. Ask an owner for an invite.',
        );
      emitAuth(deps, rec.id, redeemed?.event);
      return sessionResponse(
        c,
        deps,
        rec,
        signerVia(c.req.raw),
        redeemed?.recoveryCodes ? { recoveryCodes: redeemed.recoveryCodes } : {},
      );
    },
  );

  op(
    api,
    deps,
    {
      method: 'post',
      path: '/auth/passkey/register/options',
      scope: 'node',
      guard: 'public',
      tags,
      summary: 'Start adding a passkey',
      description:
        'Signed-in admins add a passkey to their account; new admins pass a claim, invite or recovery code.',
      body: Codes.extend({ label: z.string().max(80).optional() }),
    },
    async (c, { body, principal }) => {
      const rp = rpContext(deps, c);
      if (principal) {
        if (principal.via === 'token')
          throw new HttpError(403, 'forbidden', 'API tokens cannot add passkeys');
        const rec = await dir.get(principal.id);
        if (!rec) throw new HttpError(403, 'forbidden', 'Only team members can add passkeys');
        return c.json(
          await passkeys.registrationOptions(rp, {
            adminId: rec.id,
            userName: displayNameOf(rec, rec.id),
          }),
        );
      }
      if (!(await checkCodes(deps, body)))
        throw new HttpError(
          401,
          'unauthenticated',
          'Sign in first, or enter a valid claim, invite or recovery code',
        );
      const who: Parameters<typeof passkeys.registrationOptions>[1] = {
        userName: body.displayName ?? 'Beamhop admin',
      };
      if (body.claimCode) who.claimCode = body.claimCode;
      if (body.inviteCode) who.inviteCode = body.inviteCode;
      if (body.recoveryCode) who.recoveryCode = body.recoveryCode;
      if (body.displayName) who.displayName = body.displayName;
      return c.json(await passkeys.registrationOptions(rp, who));
    },
  );

  op(
    api,
    deps,
    {
      method: 'post',
      path: '/auth/passkey/register/verify',
      scope: 'node',
      guard: 'public',
      tags,
      summary: 'Finish adding a passkey',
      body: z.object({
        challengeId: z.string(),
        response: WebAuthnResponse,
        label: z.string().max(80).optional(),
      }),
    },
    async (c, { body }) => {
      const ch = await passkeys.takeChallenge(body.challengeId, 'register');
      if (!ch)
        throw new HttpError(
          400,
          'bad_challenge',
          'This passkey request expired. Please start again.',
        );
      let cred: Awaited<ReturnType<typeof passkeys.verifyRegistration>>;
      try {
        cred = await passkeys.verifyRegistration(ch, body.response as never);
      } catch (err) {
        throw new HttpError(
          400,
          'passkey_failed',
          'The passkey could not be verified',
          String(err),
        );
      }
      if (!cred) throw new HttpError(400, 'passkey_failed', 'The passkey could not be verified');
      if (ch.adminId) {
        const rec = await dir.get(ch.adminId);
        if (!rec) throw new HttpError(403, 'forbidden', 'Only team members can add passkeys');
        await passkeys.saveCredential(rec.id, cred, body.label);
        emitAuth(deps, rec.id, ['auth.passkey-added', 'Added a passkey']);
        await deps.audit.flush();
        return c.json({ ok: true, credentialId: cred.id });
      }
      const id = `passkey:${cred.id}`;
      const codes: CodesT = {};
      if (ch.claimCode) codes.claimCode = ch.claimCode;
      if (ch.inviteCode) codes.inviteCode = ch.inviteCode;
      if (ch.recoveryCode) codes.recoveryCode = ch.recoveryCode;
      if (ch.displayName) codes.displayName = ch.displayName;
      const redeemed = await redeemCodes(deps, codes, id, undefined, null);
      if (!redeemed) throw new HttpError(401, 'unauthenticated', 'A valid code is required');
      await passkeys.saveCredential(redeemed.rec.id, cred, body.label);
      emitAuth(deps, redeemed.rec.id, redeemed.event);
      return sessionResponse(
        c,
        deps,
        redeemed.rec,
        'passkey',
        redeemed.recoveryCodes ? { recoveryCodes: redeemed.recoveryCodes } : {},
      );
    },
  );

  op(
    api,
    deps,
    {
      method: 'post',
      path: '/auth/passkey/login/options',
      scope: 'node',
      guard: 'public',
      tags,
      summary: 'Start signing in with a passkey',
    },
    async (c) => c.json(await passkeys.loginOptions(rpContext(deps, c))),
  );

  op(
    api,
    deps,
    {
      method: 'post',
      path: '/auth/passkey/login/verify',
      scope: 'node',
      guard: 'public',
      tags,
      summary: 'Finish signing in with a passkey',
      body: z.object({
        challengeId: z.string(),
        response: WebAuthnResponse,
        recoveryCode: z
          .string()
          .max(100)
          .optional()
          .describe('Owner recovery code (regain owner access)'),
      }),
    },
    async (c, { body }) => {
      const ch = await passkeys.takeChallenge(body.challengeId, 'login');
      if (!ch)
        throw new HttpError(
          400,
          'bad_challenge',
          'This sign-in request expired. Please start again.',
        );
      const pk = await passkeys.verifyLogin(ch, body.response as never);
      if (!pk) throw new HttpError(401, 'passkey_failed', 'That passkey was not accepted');
      const existing = await dir.get(pk.adminId);
      const redeemed = body.recoveryCode
        ? await redeemCodes(
            deps,
            { recoveryCode: body.recoveryCode },
            pk.adminId,
            existing?.pubkey,
            existing,
          )
        : null;
      const rec = redeemed?.rec ?? existing;
      if (!rec) throw new HttpError(403, 'not_admin', 'This passkey no longer has access');
      emitAuth(deps, rec.id, redeemed?.event);
      return sessionResponse(c, deps, rec, 'passkey');
    },
  );

  op(
    api,
    deps,
    {
      method: 'post',
      path: '/auth/logout',
      scope: 'node',
      guard: 'authenticated',
      tags,
      summary: 'Sign out (ends this session)',
    },
    async (c) => {
      const h = c.req.header('authorization') ?? '';
      const t = h.replace(/^bearer\s+/i, '');
      const claims =
        /^bearer\s/i.test(h) && !t.startsWith('bh_') ? await deps.sessions.verify(t) : null;
      if (claims) await deps.sessions.revoke(claims);
      return c.json({ ok: true });
    },
  );

  op(
    api,
    deps,
    {
      method: 'get',
      path: '/auth/recovery-codes',
      scope: 'node',
      guard: 'admins.manage',
      tags,
      summary: 'How many owner recovery codes are left',
    },
    async (c) => {
      const me = await dir.get(requirePrincipal(c).id);
      return c.json({ remaining: await dir.recoveryCodesLeft(), owner: isOwner(me) });
    },
  );
}
