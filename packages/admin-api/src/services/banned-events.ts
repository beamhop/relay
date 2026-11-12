import type { AdminRole, Db, EventBanView, HookRegistry, Logger } from "@beamhop/sdk";
import { ROLE_RANK, type RoleService } from "./roles";

/** initial load attempts (and the waits between them, ms) before the cache falls back to per-event lookups */
const LOAD_RETRIES_MS = [100, 400];
/** most bans a list call returns */
export const BAN_LIST_MAX = 10_000;

/**
 * Event ids banned through NIP-86 (`admin_banned_events`), enforced on write. The database is the source of truth, so
 * every instance sharing it enforces the same bans: the id set is a cache re-read once it is older than `ttlMs`. While it
 * can't be read, each write is checked against the database directly, and when that fails too the check throws (the
 * write hook then rejects the event) — enforcement never silently stops.
 */
export class BannedEventCache {
  private ids = new Set<string>();
  private loadedAt = Number.NEGATIVE_INFINITY;
  private loading: Promise<void> | undefined;
  /** local bans / unbans, numbered, so a reload that started before one can't undo it */
  private seq = 0;
  private recent = new Map<string, { banned: boolean; seq: number }>();

  constructor(
    private readonly db: Db,
    private readonly nowMs: () => number,
    private readonly ttlMs: number,
    private readonly logger: Logger,
  ) {}

  /** First load, retried a couple of times; on failure the cache stays stale and keeps trying on use. */
  async init(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.load();
      } catch (err) {
        if (attempt >= LOAD_RETRIES_MS.length) {
          this.logger.error("could not load banned event ids; checking each write against the database until it works", { error: String(err) });
          return;
        }
        await new Promise((r) => setTimeout(r, LOAD_RETRIES_MS[attempt]));
      }
    }
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      const startSeq = this.seq;
      try {
        const rows = await this.db.all<{ id: string }>("SELECT id FROM admin_banned_events");
        const ids = new Set(rows.map((r) => r.id));
        for (const [id, m] of this.recent) {
          if (m.seq <= startSeq) this.recent.delete(id);
          else if (m.banned) ids.add(id);
          else ids.delete(id);
        }
        this.ids = ids;
        this.loadedAt = this.nowMs();
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  async has(id: string): Promise<boolean> {
    if (this.nowMs() - this.loadedAt >= this.ttlMs) {
      try {
        await this.load();
      } catch (err) {
        this.logger.warn("banned event ids reload failed; checking the database for this event", { error: String(err) });
        return !!(await this.db.get<{ x: number }>("SELECT 1 AS x FROM admin_banned_events WHERE id = ?", [id]));
      }
    }
    return this.ids.has(id);
  }

  /** Reads the id set again now (the database was switched). Throws when it can't be read. */
  async reload(): Promise<void> {
    this.loadedAt = Number.NEGATIVE_INFINITY;
    await this.load();
  }

  /** Call after the database row was written / removed. */
  set(id: string, banned: boolean): void {
    this.recent.set(id, { banned, seq: ++this.seq });
    if (banned) this.ids.add(id);
    else this.ids.delete(id);
  }
}

interface BanRow {
  id: string;
  reason: string;
  by: string;
  at: number | string;
  by_role: string | null;
}

/**
 * Event bans (NIP-86 banevent / unbanevent / allowevent, REST /events/bans): the `admin_banned_events` rows, the write
 * hook that refuses banned ids (through any instance) and the rank rule for lifting a ban. Permission checks and
 * auditing stay with the callers, like ModerationService.
 */
export class BannedEventService {
  private readonly cache: BannedEventCache;
  private offWrite: (() => void) | undefined;

  constructor(
    private readonly db: Db,
    private readonly roles: RoleService,
    private readonly nowSec: () => number,
    cache: { nowMs: () => number; ttlMs: number; logger: Logger },
  ) {
    this.cache = new BannedEventCache(db, cache.nowMs, cache.ttlMs, cache.logger);
  }

  /** Loads the id cache and starts enforcing bans on write. */
  async start(hooks: HookRegistry): Promise<void> {
    await this.cache.init();
    this.offWrite?.();
    this.offWrite = hooks.onWrite(
      async (event) => ((await this.cache.has(event.id)) ? { action: "reject", reason: "blocked: this event was banned by the relay operator" } : undefined),
      "admin",
      0,
    );
  }

  /** Reloads the banned id cache (the database was switched at runtime). */
  reload(): Promise<void> {
    return this.cache.reload();
  }

  /** Stops enforcing (admin API stopped). */
  stop(): void {
    this.offWrite?.();
    this.offWrite = undefined;
  }

  private row(id: string) {
    return this.db.get<BanRow>("SELECT id, reason, by, at, by_role FROM admin_banned_events WHERE id = ?", [id]);
  }

  /**
   * The role a ban counts as placed by: the recorded one; rows from before roles were recorded: the banner's current
   * rank; an unknown role string counts as owner.
   */
  private async banRole(row: Pick<BanRow, "by" | "by_role">): Promise<AdminRole | null> {
    return row.by_role === null ? this.roles.rankRole(row.by) : row.by_role in ROLE_RANK ? (row.by_role as AdminRole) : "owner";
  }

  /**
   * An event ban can only be lifted by a role at least as high as the one that placed it: the ban's role when `role`
   * is outranked by it, else null (also when there is no ban).
   */
  async liftBlockedBy(id: string, role: AdminRole): Promise<AdminRole | null> {
    const row = await this.row(id);
    const banner = row ? await this.banRole(row) : null;
    return banner && ROLE_RANK[banner] > ROLE_RANK[role] ? banner : null;
  }

  async get(id: string): Promise<EventBanView | undefined> {
    const row = await this.row(id);
    return row && toView(row);
  }

  /** Newest first. */
  async list(limit = BAN_LIST_MAX): Promise<EventBanView[]> {
    const rows = await this.db.all<BanRow>("SELECT id, reason, by, at, by_role FROM admin_banned_events ORDER BY at DESC LIMIT ?", [
      Math.min(Math.max(1, limit), BAN_LIST_MAX),
    ]);
    return rows.map(toView);
  }

  /**
   * Records the ban (and enforces it at once). A ban already placed by a higher role stays on record as theirs, so it
   * keeps needing their rank to lift.
   */
  async ban(id: string, reason: string, actor: string, role: AdminRole): Promise<void> {
    const existing = await this.row(id);
    const existingRole = existing ? await this.banRole(existing) : null;
    if (!existingRole || ROLE_RANK[existingRole] <= ROLE_RANK[role]) {
      await this.db.run(
        `INSERT INTO admin_banned_events (id, reason, by, at, by_role) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET reason = excluded.reason, by = excluded.by, at = excluded.at, by_role = excluded.by_role`,
        [id, reason, actor, this.nowSec(), role],
      );
    }
    this.cache.set(id, true);
  }

  /** Lifts the write block (the rank check is the caller's: liftBlockedBy). Whether there was a ban. */
  async lift(id: string): Promise<boolean> {
    const lifted = (await this.db.run("DELETE FROM admin_banned_events WHERE id = ?", [id])).changes > 0;
    this.cache.set(id, false);
    return lifted;
  }
}

const toView = (r: BanRow): EventBanView => ({ id: r.id, reason: r.reason, by: r.by, at: Number(r.at), byRole: (r.by_role as AdminRole | null) ?? null });
