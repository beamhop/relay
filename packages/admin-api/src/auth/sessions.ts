// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Session JWTs (jose, HS256). Signing keys live in the DocStore so every
 * instance of a node (Bun process, CF isolates) shares them; they rotate on a
 * schedule and older keys stay valid for one session lifetime.
 */
import type { Ports, Principal } from '@beamhop/core';
import { SignJWT, decodeProtectedHeader, jwtVerify } from 'jose';
import { COL } from '../settings.ts';
import { b64urlDecode, b64urlEncode } from '../util.ts';

interface SigningKey {
  kid: string;
  secret: string;
  createdAt: number;
}

export interface SessionClaims {
  sub: string;
  via: Principal['via'];
  jti: string;
  exp: number;
  iat: number;
}

export interface IssuedSession {
  token: string;
  expiresAt: number;
}

export class SessionService {
  constructor(
    private readonly ports: Ports,
    private readonly opts: () => { ttlSeconds: number; rotationDays: number; issuer: string },
  ) {}

  private async keys(): Promise<SigningKey[]> {
    const page = await this.ports.docs.list<SigningKey>(COL.keys, { limit: 100 });
    return page.items.map((i) => i.value).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Current signing key; creates one if none exists or the newest is past rotation. */
  async currentKey(): Promise<SigningKey> {
    const keys = await this.keys();
    const newest = keys[0];
    const now = this.ports.clock.now();
    if (newest && now - newest.createdAt < this.opts().rotationDays * 86400) return newest;
    return this.rotate();
  }

  /** Create a new signing key and drop keys that can no longer verify a live session. */
  async rotate(): Promise<SigningKey> {
    const now = this.ports.clock.now();
    const key: SigningKey = {
      kid: this.ports.crypto.randomHex(8),
      secret: b64urlEncode(crypto.getRandomValues(new Uint8Array(32))),
      createdAt: now,
    };
    await this.ports.docs.put(COL.keys, `${String(now).padStart(12, '0')}-${key.kid}`, key);
    const { ttlSeconds } = this.opts();
    const page = await this.ports.docs.list<SigningKey>(COL.keys, { limit: 100 });
    const sorted = page.items.sort((a, b) => b.value.createdAt - a.value.createdAt);
    // Keep the new key and the previous one; drop anything older than a session lifetime beyond that.
    for (const [i, item] of sorted.entries()) {
      if (i >= 2 && now - item.value.createdAt > ttlSeconds * 2)
        await this.ports.docs.delete(COL.keys, item.key);
    }
    return key;
  }

  async issue(sub: string, via: Principal['via']): Promise<IssuedSession> {
    const key = await this.currentKey();
    const now = this.ports.clock.now();
    const { ttlSeconds, issuer } = this.opts();
    const exp = now + ttlSeconds;
    const token = await new SignJWT({ via })
      .setProtectedHeader({ alg: 'HS256', kid: key.kid, typ: 'JWT' })
      .setSubject(sub)
      .setIssuer(issuer)
      .setJti(this.ports.crypto.randomHex(16))
      .setIssuedAt(now)
      .setExpirationTime(exp)
      .sign(b64urlDecode(key.secret));
    return { token, expiresAt: exp };
  }

  /** Verify a session JWT; null when invalid, expired, revoked, or signed by an unknown key. */
  async verify(token: string): Promise<SessionClaims | null> {
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(token).kid;
    } catch {
      return null;
    }
    const key = (await this.keys()).find((k) => k.kid === kid);
    if (!key) return null;
    try {
      const { payload } = await jwtVerify(token, b64urlDecode(key.secret), {
        issuer: this.opts().issuer,
        algorithms: ['HS256'],
        currentDate: new Date(this.ports.clock.nowMs()),
      });
      if (!payload.sub || !payload.jti || !payload.exp || !payload.iat) return null;
      if (await this.ports.docs.get(COL.revoked, payload.jti)) return null;
      return {
        sub: payload.sub,
        via: (payload.via as Principal['via']) ?? 'nip07',
        jti: payload.jti,
        exp: payload.exp,
        iat: payload.iat,
      };
    } catch {
      return null;
    }
  }

  async revoke(claims: Pick<SessionClaims, 'jti' | 'exp'>): Promise<void> {
    await this.ports.docs.put(COL.revoked, claims.jti, { exp: claims.exp });
  }

  /** Drop revocation entries for sessions that have expired anyway. */
  async gc(): Promise<void> {
    const now = this.ports.clock.now();
    const page = await this.ports.docs.list<{ exp: number }>(COL.revoked, { limit: 1000 });
    for (const i of page.items)
      if (i.value.exp < now) await this.ports.docs.delete(COL.revoked, i.key);
  }
}
