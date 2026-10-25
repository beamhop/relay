import type { TaskTracker } from "@beamhop/sdk";
import type { ApiContext } from "../context";

/** how often the audit log is pruned (default once a day; the first run follows soon after start) */
export const AUDIT_PRUNE_INTERVAL_MS = 24 * 3600_000;
/** delay of the first run after start, so it doesn't compete with startup work */
const FIRST_RUN_MS = 60_000;

/**
 * Audit log retention (settings `retention.auditLogDays`, 0 = keep forever): entries older than that are deleted
 * periodically, as a task tracked by the admin API's shutdown. Every instance sharing the database may run it; the
 * deletes are idempotent. Returns the stop function (timers off; a run in progress finishes, awaited by the tracker).
 */
export function startAuditRetention(ctx: ApiContext, tasks: TaskTracker, intervalMs = AUDIT_PRUNE_INTERVAL_MS): () => void {
  let running = false;
  const run = () => {
    const days = ctx.deps.settings.get().retention.auditLogDays;
    if (running || !(days > 0)) return;
    running = true;
    void tasks
      .run("audit log retention", async () => {
        const before = ctx.nowSec() - Math.floor(days * 86400);
        const deleted = await ctx.deps.stores.audit.prune(before);
        if (deleted) ctx.logger.info("pruned audit log", { deleted, olderThanDays: days });
      })
      .finally(() => (running = false));
  };
  const unref = (t: ReturnType<typeof setTimeout>) => (t as { unref?: () => void }).unref?.();
  const first = setTimeout(run, Math.min(FIRST_RUN_MS, intervalMs));
  const every = setInterval(run, intervalMs);
  unref(first);
  unref(every);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
