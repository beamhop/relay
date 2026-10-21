// SPDX-License-Identifier: AGPL-3.0-or-later
/** Built-in AuthProviders registered into `kernel.authProviders`. */
import type { AuthProvider, Kernel, NostrEvent, Principal } from '@beamhop/core';
import type { Directory } from './directory.ts';
import { verifyNip98 } from './nip98.ts';
import type { SessionService } from './sessions.ts';
import type { TokenService } from './tokens.ts';

/** NIP-98 events already verified (and consumed) for a request, so handlers can reuse them. */
export const verifiedNip98 = new WeakMap<
  Request,
  { ok: true; event: NostrEvent } | { ok: false; reason: string }
>();

export async function readBody(req: Request): Promise<Uint8Array> {
  if (req.method === 'GET' || req.method === 'HEAD' || !req.body) return new Uint8Array();
  return new Uint8Array(await req.clone().arrayBuffer());
}

/** Verify (once per request) the NIP-98 header of `req`. */
export async function nip98For(
  kernel: Kernel,
  req: Request,
): Promise<{ ok: true; event: NostrEvent } | { ok: false; reason: string }> {
  const cached = verifiedNip98.get(req);
  if (cached) return cached;
  // Results (including failures) are cached per request: the event is consumed on first
  // verification and the body can only be read before the handler consumes it.
  const res = await verifyNip98(kernel.ports, req, {
    trustProxy: kernel.config().node.trustProxy,
    body: await readBody(req),
  });
  verifiedNip98.set(req, res);
  return res;
}

export function signerVia(req: Request): Principal['via'] {
  return req.headers.get('x-nostr-signer')?.toLowerCase() === 'nip46' ? 'nip46' : 'nip07';
}

export function builtinProviders(
  kernel: Kernel,
  dir: Directory,
  sessions: SessionService,
  tokens: TokenService,
): AuthProvider[] {
  const bearer = (req: Request) => {
    const h = req.headers.get('authorization');
    return h && /^bearer\s/i.test(h) ? h.replace(/^bearer\s+/i, '').trim() : null;
  };
  return [
    {
      id: 'session',
      label: 'Signed-in session',
      async authenticate(req) {
        const t = bearer(req);
        if (!t || t.startsWith('bh_')) return null;
        const claims = await sessions.verify(t);
        if (!claims) return null;
        const rec = await dir.get(claims.sub);
        return rec ? dir.principalOf(rec, claims.via) : null;
      },
    },
    {
      id: 'token',
      label: 'API token',
      async authenticate(req) {
        const t = bearer(req);
        if (!t?.startsWith('bh_')) return null;
        const tok = await tokens.verify(t);
        if (!tok) return null;
        const rec = await dir.get(tok.adminId);
        if (!rec) return null;
        await tokens.touch(tok);
        const p: Principal = {
          id: `token:${tok.id}`,
          roles: { ...rec.roles },
          via: 'token',
          scopes: [...tok.scopes],
          displayName: `${dir.principalOf(rec, 'token').displayName} (token “${tok.name}”)`,
        };
        if (rec.pubkey) p.pubkey = rec.pubkey;
        return p;
      },
    },
    {
      id: 'nostr',
      label: 'Sign in with Nostr',
      async authenticate(req) {
        const h = req.headers.get('authorization');
        if (!h || !/^nostr\s/i.test(h)) return null;
        const res = await nip98For(kernel, req);
        if (!res.ok) return null;
        const rec = await dir.get(res.event.pubkey);
        return rec ? dir.principalOf(rec, signerVia(req)) : null;
      },
    },
  ];
}
