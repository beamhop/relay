import type { Db, Logger } from "@beamhop/sdk";

/** initial load attempts (and the waits between them, ms) before the cache falls back to per-event lookups */
const LOAD_RETRIES_MS = [100, 400];

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

  /** Call after the database row was written / removed. */
  set(id: string, banned: boolean): void {
    this.recent.set(id, { banned, seq: ++this.seq });
    if (banned) this.ids.add(id);
    else this.ids.delete(id);
  }
}
