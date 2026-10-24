import type { AdminRole, Db, Logger, UserQuery, UserRecord, UserStatus, UserStore } from "@beamhop/sdk";
import { escapeLike, greatest, insertRows, parseJson, toBool, toNum, toNumOrNull } from "./sql";

interface UserRow {
  pubkey: string;
  status: string;
  allowed: number;
  denied: number;
  role: string | null;
  notes: string;
  tags: string;
  rate_limit: string | null;
  blossom_quota: number | null;
  nip05_name: string | null;
  invited_by: string | null;
  ban_reason: string | null;
  first_seen_at: number;
  last_seen_at: number;
  event_count: number;
}

type Patch = Partial<Omit<UserRecord, "pubkey">>;

/** UserRecord field → column + serializer. */
const FIELDS: { [K in keyof Patch]-?: [column: string, toDb: (v: NonNullable<Patch[K]> | null) => unknown] } = {
  status: ["status", (v) => v ?? "active"],
  allowed: ["allowed", (v) => (v ? 1 : 0)],
  denied: ["denied", (v) => (v ? 1 : 0)],
  role: ["role", (v) => v ?? null],
  notes: ["notes", (v) => v ?? ""],
  tags: ["tags", (v) => JSON.stringify(v ?? [])],
  rateLimit: ["rate_limit", (v) => (v ? JSON.stringify(v) : null)],
  blossomQuota: ["blossom_quota", (v) => v ?? null],
  nip05Name: ["nip05_name", (v) => (v ? v.trim().toLowerCase() : null)],
  invitedBy: ["invited_by", (v) => v ?? null],
  banReason: ["ban_reason", (v) => v ?? null],
  firstSeenAt: ["first_seen_at", (v) => v ?? 0],
  lastSeenAt: ["last_seen_at", (v) => v ?? 0],
  eventCount: ["event_count", (v) => v ?? 0],
};
const FIELD_KEYS = Object.keys(FIELDS) as (keyof Patch)[];

export const defaultUser = (pubkey: string): UserRecord => ({
  pubkey,
  status: "active",
  allowed: false,
  denied: false,
  role: null,
  notes: "",
  tags: [],
  rateLimit: null,
  blossomQuota: null,
  nip05Name: null,
  invitedBy: null,
  banReason: null,
  firstSeenAt: 0,
  lastSeenAt: 0,
  eventCount: 0,
});

const rowToUser = (r: UserRow): UserRecord => ({
  pubkey: r.pubkey,
  status: (r.status as UserStatus) ?? "active",
  allowed: toBool(r.allowed),
  denied: toBool(r.denied),
  role: (r.role as AdminRole | null) ?? null,
  notes: r.notes ?? "",
  tags: parseJson<string[]>(r.tags, []),
  rateLimit: parseJson(r.rate_limit, null),
  blossomQuota: toNumOrNull(r.blossom_quota),
  nip05Name: r.nip05_name ?? null,
  invitedBy: r.invited_by ?? null,
  banReason: r.ban_reason ?? null,
  firstSeenAt: toNum(r.first_seen_at),
  lastSeenAt: toNum(r.last_seen_at),
  eventCount: toNum(r.event_count),
});

/** Inserts the user with defaults if missing, then applies only the patched columns. */
export async function upsertUser(db: Db, pubkey: string, patch: Patch): Promise<UserRecord> {
  const keys = FIELD_KEYS.filter((k) => patch[k] !== undefined);
  const merged = { ...defaultUser(pubkey), ...Object.fromEntries(keys.map((k) => [k, patch[k]])) } as UserRecord;
  const columns = ["pubkey", ...FIELD_KEYS.map((k) => FIELDS[k][0])];
  const values = [pubkey, ...FIELD_KEYS.map((k) => (FIELDS[k][1] as (v: unknown) => unknown)(merged[k]))];
  const onConflict = keys.length
    ? `DO UPDATE SET ${keys.map((k) => `${FIELDS[k][0]} = excluded.${FIELDS[k][0]}`).join(", ")}`
    : "DO NOTHING";
  await db.run(
    `INSERT INTO users (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ON CONFLICT (pubkey) ${onConflict}`,
    values,
  );
  const row = await db.get<UserRow>("SELECT * FROM users WHERE pubkey = ?", [pubkey]);
  return rowToUser(row!);
}

interface Touch {
  first: number;
  last: number;
  count: number;
}

export interface UserStoreOptions {
  /** flush interval for buffered touch() calls (ms); default 2000 */
  flushIntervalMs?: number;
  /** flush early when this many distinct pubkeys are buffered; default 5000 */
  maxBuffered?: number;
}

/**
 * SQL UserStore. `touch()` is buffered in memory and flushed in batches (every ~2s, on demand via
 * `flush()`, and on `close()`); reads overlay pending touches so they're never visibly stale.
 */
export class SqlUserStore implements UserStore {
  private pending = new Map<string, Touch>();
  /** batch currently being written (still overlaid on reads until committed) */
  private inflight = new Map<string, Touch>();
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly maxBuffered: number;

  constructor(
    private db: Db,
    private logger: Logger,
    opts: UserStoreOptions = {},
  ) {
    this.maxBuffered = opts.maxBuffered ?? 5000;
    this.timer = setInterval(() => void this.flush(), opts.flushIntervalMs ?? 2000);
    (this.timer as { unref?: () => void }).unref?.();
  }

  async get(pubkey: string): Promise<UserRecord | undefined> {
    const row = await this.db.get<UserRow>("SELECT * FROM users WHERE pubkey = ?", [pubkey]);
    if (row) return this.overlay(rowToUser(row));
    return this.pending.has(pubkey) || this.inflight.has(pubkey) ? this.overlay(defaultUser(pubkey)) : undefined;
  }

  async upsert(pubkey: string, patch: Patch): Promise<UserRecord> {
    return this.overlay(await this.db.tx((tx) => upsertUser(tx, pubkey, patch)));
  }

  /** `sort: "pubkey"` orders by pubkey alone (ascending): stable across pages, for callers that page through everything. */
  async list(q: UserQuery): Promise<{ items: UserRecord[]; total: number }> {
    // buffered activity changes counts/timestamps the ORDER BY uses: the overlay alone would fix the numbers but not
    // the order, so write it out first (admin listing only; touch() stays buffered on the hot path)
    if (this.pending.size && q.sort !== "pubkey") await this.flush();
    const conds: string[] = [];
    const params: unknown[] = [];
    const inList = (pks: string[]) => {
      params.push(...pks);
      return ` OR pubkey IN (${pks.map(() => "?").join(", ")})`;
    };
    if (q.search?.trim()) {
      const s = q.search.trim().toLowerCase();
      const contains = `%${escapeLike(s)}%`;
      params.push(`${escapeLike(s)}%`, `${escapeLike(s)}%`, contains, contains);
      const extra = q.searchPubkeys?.length ? inList(q.searchPubkeys) : "";
      conds.push(
        `(pubkey LIKE ? ESCAPE '\\' OR nip05_name LIKE ? ESCAPE '\\' OR LOWER(notes) LIKE ? ESCAPE '\\' OR LOWER(tags) LIKE ? ESCAPE '\\'${extra})`,
      );
    }
    if (q.status) {
      conds.push("status = ?");
      params.push(q.status);
    }
    if (q.role) {
      params.push(q.role);
      const extra = q.rolePubkeys?.length ? inList(q.rolePubkeys) : "";
      conds.push(`(role = ?${extra})`);
    }
    if (q.allowed !== undefined) {
      conds.push("allowed = ?");
      params.push(q.allowed ? 1 : 0);
    }
    if (q.tag) {
      // exact (case-sensitive) on both backends; sqlite LIKE would be case-insensitive
      conds.push(this.db.dialect === "postgres" ? "strpos(tags, ?) > 0" : "instr(tags, ?) > 0");
      params.push(JSON.stringify(q.tag));
    }
    const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
    const order =
      q.sort === "pubkey" ? null : q.sort === "firstSeen" ? "first_seen_at DESC" : q.sort === "eventCount" ? "event_count DESC" : "last_seen_at DESC";
    const limit = Math.min(Math.max(1, Math.floor(q.limit ?? 50)), 1000);
    const offset = Math.max(0, Math.floor(q.offset ?? 0));
    const total = toNum((await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM users${where}`, params))?.n);
    const rows = await this.db.all<UserRow>(
      `SELECT * FROM users${where} ORDER BY ${order ? `${order}, ` : ""}pubkey ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return { items: rows.map((r) => this.overlay(rowToUser(r))), total };
  }

  async touch(pubkey: string, at: number): Promise<void> {
    const t = this.pending.get(pubkey);
    if (t) {
      t.count++;
      if (at > t.last) t.last = at;
      if (at < t.first) t.first = at;
    } else {
      this.pending.set(pubkey, { first: at, last: at, count: 1 });
      if (this.pending.size >= this.maxBuffered) void this.flush();
    }
  }

  async getByNip05(name: string): Promise<UserRecord | undefined> {
    const row = await this.db.get<UserRow>("SELECT * FROM users WHERE nip05_name = ?", [name.trim().toLowerCase()]);
    return row ? this.overlay(rowToUser(row)) : undefined;
  }

  async delete(pubkey: string): Promise<void> {
    // a batch being written may contain this pubkey and would re-insert the row right after the DELETE
    while (this.flushing) await this.flushing;
    this.pending.delete(pubkey);
    await this.db.run("DELETE FROM users WHERE pubkey = ?", [pubkey]);
  }

  /** Writes buffered touch() data. Safe to call concurrently. */
  async flush(): Promise<void> {
    while (this.flushing) await this.flushing;
    if (!this.pending.size) return;
    const batch = this.pending;
    this.pending = new Map();
    this.inflight = batch;
    this.flushing = this.writeTouches(batch)
      .catch((err) => {
        this.logger.error("failed to flush user activity", { err: String(err), users: batch.size });
        // put the data back so it is retried on the next flush
        for (const [pk, t] of batch) {
          const cur = this.pending.get(pk);
          if (!cur) this.pending.set(pk, t);
          else {
            cur.count += t.count;
            cur.first = Math.min(cur.first, t.first);
            cur.last = Math.max(cur.last, t.last);
          }
        }
      })
      .finally(() => {
        this.inflight = new Map();
        this.flushing = null;
      });
    await this.flushing;
  }

  /** Stops the flush timer and writes pending data. */
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }

  private async writeTouches(batch: Map<string, Touch>): Promise<void> {
    // sorted by key: concurrent upserts (several instances on one postgres) then lock rows in the same order
    const rows = [...batch].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([pk, t]) => [pk, t.first, t.last, t.count]);
    const d = this.db.dialect;
    await this.db.tx((tx) =>
      insertRows(
        tx,
        "INSERT INTO users (pubkey, first_seen_at, last_seen_at, event_count)",
        4,
        rows,
        `ON CONFLICT (pubkey) DO UPDATE SET
          last_seen_at = ${greatest(d, "users.last_seen_at", "excluded.last_seen_at")},
          event_count = users.event_count + excluded.event_count,
          first_seen_at = CASE WHEN users.first_seen_at = 0 THEN excluded.first_seen_at ELSE users.first_seen_at END`,
        200,
      ),
    );
  }

  private overlay(u: UserRecord): UserRecord {
    for (const t of [this.inflight.get(u.pubkey), this.pending.get(u.pubkey)]) {
      if (!t) continue;
      u = {
        ...u,
        firstSeenAt: u.firstSeenAt || t.first,
        lastSeenAt: Math.max(u.lastSeenAt, t.last),
        eventCount: u.eventCount + t.count,
      };
    }
    return u;
  }
}
