// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Team (employee) sessions after SSO: an HttpOnly cookie holding an HS256 JWT
 * (`jose`). The signing secret lives in the DocStore so every instance of the
 * node shares it. A session is valid only while its binding is active and the
 * session id is still recorded (offboarding deletes them).
 */
import type { Kernel } from '@beamhop/core';
import { SignJWT, jwtVerify } from 'jose';
import { COL } from './store.ts';
import { b64urlDecode, randomToken, readCookie } from './util.ts';

export const TEAM_COOKIE = 'bh_team';
export const STATE_COOKIE = 'bh_sso';

export interface TeamSessionRecord {
  sid: string;
  bindingKey: string;
  createdAt: number;
  expiresAt: number;
}

export class TeamSessions {
  constructor(
    private readonly kernel: Kernel,
    private readonly ttl: () => number,
  ) {}

  private async secret(): Promise<Uint8Array> {
    const docs = this.kernel.ports.docs;
    const cur = await docs.get<{ secret: string }>(COL.secrets, 'team-session');
    if (cur) return b64urlDecode(cur.secret);
    const next = { secret: randomToken(32), createdAt: this.kernel.ports.clock.now() };
    if (await docs.cas(COL.secrets, 'team-session', null, next)) return b64urlDecode(next.secret);
    const again = await docs.get<{ secret: string }>(COL.secrets, 'team-session');
    if (!again) throw new Error('session secret unavailable');
    return b64urlDecode(again.secret);
  }

  private key(bindingKey: string, sid: string) {
    return `${bindingKey}/${sid}`;
  }

  async issue(bindingKey: string): Promise<{ token: string; rec: TeamSessionRecord }> {
    const now = this.kernel.ports.clock.now();
    const rec: TeamSessionRecord = {
      sid: this.kernel.ports.crypto.randomHex(16),
      bindingKey,
      createdAt: now,
      expiresAt: now + this.ttl(),
    };
    await this.kernel.ports.docs.put(COL.teamSessions, this.key(bindingKey, rec.sid), rec);
    const token = await new SignJWT({ sid: rec.sid })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(bindingKey)
      .setIssuedAt(now)
      .setExpirationTime(rec.expiresAt)
      .setAudience('beamhop-team')
      .sign(await this.secret());
    return { token, rec };
  }

  async verify(token: string): Promise<TeamSessionRecord | null> {
    try {
      const { payload } = await jwtVerify(token, await this.secret(), {
        algorithms: ['HS256'],
        audience: 'beamhop-team',
        currentDate: new Date(this.kernel.ports.clock.nowMs()),
      });
      const sid = payload.sid;
      if (typeof sid !== 'string' || !payload.sub) return null;
      return await this.kernel.ports.docs.get<TeamSessionRecord>(
        COL.teamSessions,
        this.key(payload.sub, sid),
      );
    } catch {
      return null;
    }
  }

  fromRequest(req: Request): Promise<TeamSessionRecord | null> {
    const cookie = readCookie(req.headers.get('cookie'), TEAM_COOKIE);
    const auth = req.headers.get('authorization');
    const bearer = auth && /^bearer\s/i.test(auth) ? auth.replace(/^bearer\s+/i, '') : undefined;
    const token = cookie ?? bearer;
    return token ? this.verify(token) : Promise.resolve(null);
  }

  get(bindingKey: string, sid: string): Promise<TeamSessionRecord | null> {
    return this.kernel.ports.docs.get<TeamSessionRecord>(
      COL.teamSessions,
      this.key(bindingKey, sid),
    );
  }

  /** Find a session by id alone (scans; sessions are few per node). */
  async find(sid: string): Promise<TeamSessionRecord | null> {
    let cursor: string | undefined;
    do {
      const page = await this.kernel.ports.docs.list<TeamSessionRecord>(COL.teamSessions, {
        limit: 1000,
        ...(cursor ? { cursor } : {}),
      });
      for (const i of page.items) if (i.value.sid === sid) return i.value;
      cursor = page.items.length ? page.cursor : undefined;
    } while (cursor);
    return null;
  }

  async list(bindingKey: string): Promise<TeamSessionRecord[]> {
    const page = await this.kernel.ports.docs.list<TeamSessionRecord>(COL.teamSessions, {
      prefix: `${bindingKey}/`,
      limit: 1000,
    });
    return page.items.map((i) => i.value);
  }

  async revokeAll(bindingKey: string): Promise<TeamSessionRecord[]> {
    const all = await this.list(bindingKey);
    for (const s of all)
      await this.kernel.ports.docs.delete(COL.teamSessions, this.key(bindingKey, s.sid));
    return all;
  }

  async gc(): Promise<void> {
    const now = this.kernel.ports.clock.now();
    const page = await this.kernel.ports.docs.list<TeamSessionRecord>(COL.teamSessions, {
      limit: 1000,
    });
    for (const i of page.items)
      if (i.value.expiresAt < now) await this.kernel.ports.docs.delete(COL.teamSessions, i.key);
  }
}
