// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Zero-trust / identity-aware proxy mode (§12.10):
 * - Google IAP: `x-goog-iap-jwt-assertion` (ES256, JWKS public_key-jwk, iss https://cloud.google.com/iap)
 * - Cloudflare Access: `cf-access-jwt-assertion` (RS256, https://<team>/cdn-cgi/access/certs)
 * - Entra App Proxy (header-based SSO): user header, trusted only with the proxy secret
 *   or `node.trustProxy`; App Proxy does not sign these headers.
 * Verified identities map to admin principals (email → admin id) and can be exchanged
 * for a regular admin session via `admin.sessions`.
 */
import type { JWTVerifyGetKey } from 'jose';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose';
import type { NetworkConfig } from './config.ts';

export interface ZeroTrustIdentity {
  provider: 'google-iap' | 'cloudflare-access' | 'entra-app-proxy';
  email: string;
  subject: string;
}

export type ZtResult = { ok: true; identity: ZeroTrustIdentity } | { ok: false; reason: string };

const IAP_JWKS = 'https://www.gstatic.com/iap/verify/public_key-jwk';
const IAP_ISSUER = 'https://cloud.google.com/iap';

function constantEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function proxySecretOk(
  req: Request,
  secret: { header: string; value: string } | undefined,
  trustProxy: boolean,
): boolean {
  if (secret) return constantEq(req.headers.get(secret.header) ?? '', secret.value);
  return trustProxy;
}

export class ZeroTrustVerifier {
  private keys: JWTVerifyGetKey | null = null;
  private keysFor = '';

  constructor(private readonly now: () => number) {}

  private keySet(cfg: NetworkConfig['zeroTrust']): JWTVerifyGetKey {
    const id = JSON.stringify([cfg.provider, cfg.jwksUrl, cfg.jwks, cfg.teamDomain]);
    if (this.keys && this.keysFor === id) return this.keys;
    if (cfg.jwks) {
      this.keys = createLocalJWKSet(cfg.jwks as Parameters<typeof createLocalJWKSet>[0]);
    } else {
      const url =
        cfg.jwksUrl ??
        (cfg.provider === 'google-iap'
          ? IAP_JWKS
          : `https://${(cfg.teamDomain ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')}/cdn-cgi/access/certs`);
      this.keys = createRemoteJWKSet(new URL(url));
    }
    this.keysFor = id;
    return this.keys;
  }

  async verify(
    req: Request,
    cfg: NetworkConfig['zeroTrust'],
    trustProxy: boolean,
  ): Promise<ZtResult> {
    switch (cfg.provider) {
      case 'off':
        return { ok: false, reason: 'zero-trust mode is off' };
      case 'entra-app-proxy': {
        if (!proxySecretOk(req, cfg.proxySecret, trustProxy))
          return { ok: false, reason: 'Request did not come through the company proxy' };
        const user = req.headers.get(cfg.userHeader)?.trim();
        if (!user) return { ok: false, reason: 'The company proxy did not say who you are' };
        return {
          ok: true,
          identity: { provider: 'entra-app-proxy', email: user.toLowerCase(), subject: user },
        };
      }
      case 'google-iap':
      case 'cloudflare-access': {
        const header =
          cfg.provider === 'google-iap' ? 'x-goog-iap-jwt-assertion' : 'cf-access-jwt-assertion';
        let token = req.headers.get(header);
        if (!token && cfg.provider === 'cloudflare-access') {
          token =
            /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1] ?? null;
        }
        if (!token) return { ok: false, reason: 'Sign in through your company access gateway' };
        if (!cfg.audience) return { ok: false, reason: 'Zero-trust audience is not configured' };
        const issuer =
          cfg.provider === 'google-iap'
            ? IAP_ISSUER
            : `https://${(cfg.teamDomain ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')}`;
        try {
          const { payload } = await jwtVerify(token, this.keySet(cfg), {
            issuer,
            audience: cfg.audience,
            algorithms: cfg.provider === 'google-iap' ? ['ES256'] : ['RS256', 'ES256'],
            currentDate: new Date(this.now() * 1000),
            clockTolerance: 30,
          });
          const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
          if (!email || !payload.sub) return { ok: false, reason: 'The access token has no user' };
          return { ok: true, identity: { provider: cfg.provider, email, subject: payload.sub } };
        } catch {
          return { ok: false, reason: 'The company access token is not valid' };
        }
      }
    }
  }
}
