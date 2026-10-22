import { randomBytes } from "node:crypto";
import type { Db } from "@beamhop/sdk";

export const SESSION_TTL_SEC = 7 * 24 * 3600;
/** how often (sec) a used session's sliding expiry is persisted */
const TOUCH_INTERVAL_SEC = 60;

export type LoginMethod = "nostr" | "password" | "passkey";

export interface SessionRecord {
  id: string;
  pubkey: string;
  createdAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
  lastSeenAt: number;
  method: LoginMethod | "unknown";
}

interface Row {
  id: string;
  pubkey: string;
  created_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
  last_seen_at: number;
  method: string;
}
const fromRow = (r: Row): SessionRecord => ({
  id: r.id,
  pubkey: r.pubkey,
  createdAt: Number(r.created_at),
  expiresAt: Number(r.expires_at),
  ip: r.ip,
  userAgent: r.user_agent,
  lastSeenAt: Number(r.last_seen_at),
  method: (r.method as LoginMethod) ?? "unknown",
});

const ID_RE = /^[0-9a-f]{64}$/;

export class SessionService {
  private cache = new Map<string, SessionRecord>();
  private lastPurge = 0;

  constructor(
    private readonly db: Db,
    private readonly nowSec: () => number,
  ) {}

  async create(pubkey: string, method: LoginMethod, ip: string | null, userAgent: string | null): Promise<SessionRecord> {
    const now = this.nowSec();
    const s: SessionRecord = {
      id: randomBytes(32).toString("hex"),
      pubkey,
      createdAt: now,
      expiresAt: now + SESSION_TTL_SEC,
      ip,
      userAgent: userAgent ? userAgent.slice(0, 512) : null,
      lastSeenAt: now,
      method,
    };
    await this.db.run(
      "INSERT INTO admin_sessions (id, pubkey, created_at, expires_at, ip, user_agent, last_seen_at, method) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [s.id, s.pubkey, s.createdAt, s.expiresAt, s.ip, s.userAgent, s.lastSeenAt, s.method],
    );
    this.remember(s);
    await this.maybePurge();
    return s;
  }

  async get(id: string): Promise<SessionRecord | undefined> {
    if (!ID_RE.test(id)) return undefined;
    let s = this.cache.get(id);
    if (!s) {
      const row = await this.db.get<Row>("SELECT * FROM admin_sessions WHERE id = ?", [id]);
      if (!row) return undefined;
      s = fromRow(row);
      this.remember(s);
    }
    if (s.expiresAt <= this.nowSec()) {
      await this.destroy(id);
      return undefined;
    }
    return s;
  }

  /** Sliding expiry; returns true when the expiry was extended (cookie should be re-issued). */
  async touch(s: SessionRecord): Promise<boolean> {
    const now = this.nowSec();
    if (now - s.lastSeenAt < TOUCH_INTERVAL_SEC) return false;
    s.lastSeenAt = now;
    s.expiresAt = now + SESSION_TTL_SEC;
    await this.db.run("UPDATE admin_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", [s.lastSeenAt, s.expiresAt, s.id]);
    return true;
  }

  async destroy(id: string): Promise<void> {
    this.cache.delete(id);
    await this.db.run("DELETE FROM admin_sessions WHERE id = ?", [id]);
  }

  /** Destroys all sessions of a pubkey, optionally keeping one. */
  async destroyAllFor(pubkey: string, exceptId?: string): Promise<void> {
    for (const [id, s] of this.cache) if (s.pubkey === pubkey && id !== exceptId) this.cache.delete(id);
    await this.db.run("DELETE FROM admin_sessions WHERE pubkey = ? AND id <> ?", [pubkey, exceptId ?? ""]);
  }

  private remember(s: SessionRecord) {
    if (this.cache.size >= 5000) {
      const first = this.cache.keys().next();
      if (!first.done) this.cache.delete(first.value);
    }
    this.cache.set(s.id, s);
  }

  private async maybePurge() {
    const now = this.nowSec();
    if (now - this.lastPurge < 3600) return;
    this.lastPurge = now;
    await this.db.run("DELETE FROM admin_sessions WHERE expires_at <= ?", [now]);
  }
}
