import { createHash, randomBytes } from "node:crypto";
import type { Db } from "@beamhop/sdk";

export const SESSION_TTL_SEC = 7 * 24 * 3600;
/** absolute lifetime: sliding renewal never extends a session past createdAt + this */
export const SESSION_MAX_AGE_SEC = 30 * 24 * 3600;
/** how often (sec) a used session's sliding expiry is persisted */
const TOUCH_INTERVAL_SEC = 60;
/**
 * How long (ms) a cached session is trusted before it is re-read from the database, so a logout or revocation on
 * another instance sharing the database takes effect here within this window (without a query per request).
 */
export const SESSION_REVALIDATE_MS = 5_000;

/** The database only keeps this hash of a session id: the raw id lives in the cookie alone. */
export const hashSessionId = (token: string) => createHash("sha256").update(token).digest("hex");

export type LoginMethod = "nostr" | "password" | "passkey";

export interface SessionRecord {
  /** sha256 of the cookie value: the stored key, and what push devices (and other server-side state) refer to */
  id: string;
  /** the cookie value (never stored) */
  token: string;
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
const fromRow = (r: Row, token: string): SessionRecord => ({
  id: r.id,
  token,
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
  /** keyed by hashed id; `checkedAt` (ms): when the record was last read from the database */
  private cache = new Map<string, { s: SessionRecord; checkedAt: number }>();
  private lastPurge = 0;
  /**
   * Called when sessions end without a logout: with the id of one found expired on lookup, or without one after the
   * periodic sweep (to drop whatever the swept sessions left behind, e.g. their push devices).
   */
  onExpired: (id?: string) => Promise<void> = async () => {};

  constructor(
    private readonly db: Db,
    private readonly nowMs: () => number,
  ) {}

  private nowSec() {
    return Math.floor(this.nowMs() / 1000);
  }

  async create(pubkey: string, method: LoginMethod, ip: string | null, userAgent: string | null): Promise<SessionRecord> {
    const now = this.nowSec();
    const token = randomBytes(32).toString("hex");
    const s: SessionRecord = {
      id: hashSessionId(token),
      token,
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

  /** Looks a session up by its cookie value. */
  async get(token: string): Promise<SessionRecord | undefined> {
    if (!ID_RE.test(token)) return undefined;
    const id = hashSessionId(token);
    const cached = this.cache.get(id);
    let s = cached && this.nowMs() - cached.checkedAt < SESSION_REVALIDATE_MS ? cached.s : undefined;
    if (!s) {
      const row = await this.db.get<Row>("SELECT * FROM admin_sessions WHERE id = ?", [id]);
      if (!row) {
        // revoked by another instance (which dropped its devices), or swept
        this.cache.delete(id);
        return undefined;
      }
      // the stored expiry may have been slid by another instance
      s = fromRow(row, token);
      this.remember(s);
      await this.maybePurge();
    }
    const now = this.nowSec();
    if (s.expiresAt <= now || now - s.createdAt >= SESSION_MAX_AGE_SEC) {
      await this.destroy(id);
      await this.onExpired(id);
      return undefined;
    }
    return s;
  }

  /** Sliding expiry; returns true when the expiry was extended (cookie should be re-issued). */
  async touch(s: SessionRecord): Promise<boolean> {
    const now = this.nowSec();
    if (now - s.lastSeenAt < TOUCH_INTERVAL_SEC) return false;
    const expiresAt = Math.min(now + SESSION_TTL_SEC, s.createdAt + SESSION_MAX_AGE_SEC);
    s.lastSeenAt = now;
    if (expiresAt <= s.expiresAt) {
      await this.db.run("UPDATE admin_sessions SET last_seen_at = ? WHERE id = ?", [s.lastSeenAt, s.id]);
      return false;
    }
    s.expiresAt = expiresAt;
    await this.db.run("UPDATE admin_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?", [s.lastSeenAt, s.expiresAt, s.id]);
    return true;
  }

  /** `id`: the hashed id (SessionRecord.id). */
  async destroy(id: string): Promise<void> {
    this.cache.delete(id);
    await this.db.run("DELETE FROM admin_sessions WHERE id = ?", [id]);
  }

  /** Destroys all sessions of a pubkey, optionally keeping one (by hashed id). */
  async destroyAllFor(pubkey: string, exceptId?: string): Promise<void> {
    for (const [id, e] of this.cache) if (e.s.pubkey === pubkey && id !== exceptId) this.cache.delete(id);
    await this.db.run("DELETE FROM admin_sessions WHERE pubkey = ? AND id <> ?", [pubkey, exceptId ?? ""]);
  }

  private remember(s: SessionRecord) {
    if (!this.cache.has(s.id) && this.cache.size >= 5000) {
      const first = this.cache.keys().next();
      if (!first.done) this.cache.delete(first.value);
    }
    this.cache.set(s.id, { s, checkedAt: this.nowMs() });
  }

  private async maybePurge() {
    const now = this.nowSec();
    if (now - this.lastPurge < 3600) return;
    this.lastPurge = now;
    await this.db.run("DELETE FROM admin_sessions WHERE expires_at <= ?", [now]);
    await this.onExpired();
  }
}
