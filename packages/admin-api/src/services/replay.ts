import type { Db } from "@beamhop/sdk";

/** how often (sec) expired ids are swept */
const PURGE_INTERVAL_SEC = 60;

/**
 * Single-use ids (NIP-98 auth event ids) recorded in the database rather than in process memory, so a captured
 * authorization can't be replayed against another instance sharing the database (or after a restart).
 */
export class ReplayGuard {
  private lastPurge = 0;

  constructor(
    private readonly db: Db,
    private readonly nowMs: () => number,
  ) {}

  /** Records `id` for `ttlMs`; false when it was already recorded (a replay). Atomic across concurrent requests. */
  async consume(id: string, ttlMs: number): Promise<boolean> {
    const r = await this.db.run("INSERT INTO admin_used_auth (id, expires_at) VALUES (?, ?) ON CONFLICT (id) DO NOTHING", [
      id,
      Math.ceil((this.nowMs() + ttlMs) / 1000),
    ]);
    await this.maybePurge();
    return r.changes > 0;
  }

  private async maybePurge() {
    const now = Math.floor(this.nowMs() / 1000);
    if (now - this.lastPurge < PURGE_INTERVAL_SEC) return;
    this.lastPurge = now;
    await this.db.run("DELETE FROM admin_used_auth WHERE expires_at < ?", [now]);
  }
}
