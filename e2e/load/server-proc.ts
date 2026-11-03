/**
 * Child-process entry for the load tool: a real `beamhop start` (startServer: same signal handling and graceful
 * shutdown as the CLI), configured from BEAMHOP_* env, plus a stats line on stdout every LOAD_STATS_MS:
 *   STATS {"rss":…, "heapUsed":…, "fds":…, "conns":…, "objects":{…}}
 * so a soak run can watch memory, open descriptors and object counts (Map/Set/Promise/Connection…) for leaks.
 * LOAD_SEED=<n> instead bulk-inserts n synthetic events (see seed.ts) and exits.
 */
import { readdirSync } from "node:fs";
import { loadConfig, startServer, createBeamhop } from "@beamhop/server";
import { seedEvents } from "./lib/seed";

const statsMs = Number(process.env.LOAD_STATS_MS ?? 0);
const seed = Number(process.env.LOAD_SEED ?? 0);

const loaded = loadConfig({ cwd: process.cwd(), env: process.env as Record<string, string> });

if (seed > 0) {
  const beamhop = await createBeamhop(loaded.config, { autoDiscoverNpm: false, extras: loaded.extras } as never);
  const t0 = performance.now();
  const offset = Number(process.env.LOAD_SEED_OFFSET ?? 0);
  const base = Number(process.env.LOAD_SEED_BASE ?? Math.floor(Date.now() / 1000));
  const n = await seedEvents(beamhop.stores.db, seed, offset, base, (done) => console.log(`SEED ${done}`));
  console.log(`SEEDED ${n} in ${Math.round(performance.now() - t0)} ms`);
  await beamhop.stop({ reason: "seeded" });
  process.exit(0);
}

if (process.env.LOAD_EXPLAIN) {
  // query plans of the store's SQL for each filter: EXPLAIN QUERY PLAN (sqlite) / EXPLAIN ANALYZE (postgres)
  const beamhop = await createBeamhop(loaded.config, { autoDiscoverNpm: false, extras: loaded.extras } as never);
  const store = beamhop.stores.events as unknown as {
    querySql(f: object, now: number, limit?: number): { sql: string; params: unknown[] } | null;
  };
  const db = beamhop.stores.db;
  for (const { name, filter } of JSON.parse(process.env.LOAD_EXPLAIN) as { name: string; filter: { limit?: number } }[]) {
    const q = store.querySql(filter, Math.floor(Date.now() / 1000), filter.limit ?? 500);
    if (!q) continue;
    const rows =
      db.dialect === "sqlite"
        ? (await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${q.sql}`, q.params)).map((r) => r.detail)
        : (await db.all<Record<string, string>>(`EXPLAIN (ANALYZE, BUFFERS) ${q.sql}`, q.params)).map((r) => Object.values(r)[0]);
    console.log(`PLAN ${JSON.stringify({ name, plan: rows })}`);
  }
  await beamhop.stop({ reason: "explained" });
  process.exit(0);
}

const started = await startServer(loaded, { runtime: "bun" });
console.log(`READY ${started.server.port}`);

if (statsMs > 0) {
  const { heapStats } = await import("bun:jsc");
  const WATCH = ["Map", "Set", "Promise", "Connection", "WebSocket", "AbortController", "Timeout", "Array", "Function"];
  setInterval(() => {
    const m = process.memoryUsage();
    const h = heapStats();
    let fds = -1;
    try {
      fds = readdirSync("/dev/fd").length;
    } catch {
      /* not available */
    }
    const objects: Record<string, number> = {};
    for (const k of WATCH) objects[k] = h.objectTypeCounts[k] ?? 0;
    console.log(
      `STATS ${JSON.stringify({ t: Date.now(), rss: m.rss, heapUsed: m.heapUsed, heapObjects: h.objectCount, fds, conns: started.beamhop.relay.connections().length, objects })}`,
    );
  }, statsMs).unref();
}
