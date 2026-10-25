/**
 * beamhop-plugin-hello — a tour of every plugin capability:
 * settings schema, migrations, write/query/visibility hooks, public + admin HTTP routes,
 * background jobs, bus subscriptions, custom metrics and an admin-ui bundle.
 *
 * Only *type* imports from @beamhop/sdk are used and the syntax is erasable TypeScript, so this
 * file runs as-is on Bun and on Node ≥ 22.18 (type stripping) without a build step.
 */
import { z } from "zod";
import type { BeamhopPlugin, NostrEvent } from "@beamhop/sdk";

const Settings = z.object({
  /** events containing this word (case-insensitive) are rejected; empty = off */
  blockedWord: z.string().default("forbidden-word").describe("Reject events containing this word"),
  /** greeting returned by GET /plugins/hello/ */
  greeting: z.string().default("Hello from beamhop!").describe("Greeting served at /plugins/hello/"),
  /** clamp every REQ filter limit to this value */
  maxQueryLimit: z.number().int().min(1).max(5000).default(500).describe("Clamp REQ filter limits"),
  /** hide events of these kinds from readers (they are still stored) */
  hiddenKinds: z.array(z.number().int()).default([]).describe("Kinds hidden from REQ results"),
  /** how often the heartbeat job runs */
  tickSeconds: z.number().int().min(5).default(60).describe("Heartbeat job interval"),
});
type HelloSettings = z.infer<typeof Settings>;

let teardownFn: (() => Promise<void>) | undefined;

const plugin: BeamhopPlugin<typeof Settings> = {
  name: "hello",
  version: "0.1.0",
  description: "Example plugin: word filter, query clamp, routes, job, metrics and an admin page.",
  settings: Settings,
  migrations: [
    {
      id: "001_init",
      up: "CREATE TABLE IF NOT EXISTS plugin_hello_rejections (id TEXT PRIMARY KEY, pubkey TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL)",
    },
    {
      // postgres INTEGER is 32-bit (overflows in 2038); sqlite INTEGER is already 64-bit
      id: "002_bigint_at",
      up: { sqlite: "SELECT 1", postgres: "ALTER TABLE plugin_hello_rejections ALTER COLUMN at TYPE BIGINT" },
    },
  ],
  // relative to the plugin package root; built by `bun run build:ui`
  ui: "./dist/ui.js",

  async setup(ctx) {
    const { logger, db, settings } = ctx;
    /** rejected-event log is fed by anonymous writers, so it is capped */
    const MAX_REJECTION_ROWS = 1000;
    let seen = 0;
    let rejected = 0;
    const rejectedCounter = ctx.metrics.counter("hello_rejected_total", "events rejected by the hello plugin");
    const seenGauge = ctx.metrics.gauge("hello_events_seen", "accepted events observed since the plugin started");

    // rejections are buffered in memory and written in one transaction by the flush job: a flood of rejected
    // events doesn't turn into a database write per event on the publish path
    type Rejection = { id: string; pubkey: string; at: number; reason: string };
    let pending: Rejection[] = [];
    const flush = async () => {
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      await db.tx(async (tx) => {
        for (const r of batch) {
          await tx.run("INSERT INTO plugin_hello_rejections (id, pubkey, at, reason) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING", [r.id, r.pubkey, r.at, r.reason]);
        }
        await tx.run(
          "DELETE FROM plugin_hello_rejections WHERE id NOT IN (SELECT id FROM plugin_hello_rejections ORDER BY at DESC, id DESC LIMIT ?)",
          [MAX_REJECTION_ROWS],
        );
      });
    };
    const stopFlush = ctx.jobs.every("flush-rejections", 5_000, flush);

    // --- write hook: reject a configurable word
    ctx.hooks.onWrite((event: NostrEvent) => {
      const word = settings.get().blockedWord.trim().toLowerCase();
      if (!word || !event.content.toLowerCase().includes(word)) return undefined;
      rejected++;
      rejectedCounter.add(1, { kind: String(event.kind) });
      // only the newest MAX_REJECTION_ROWS would survive the prune anyway
      if (pending.length >= MAX_REJECTION_ROWS) pending.shift();
      pending.push({ id: event.id, pubkey: event.pubkey, at: Math.floor(Date.now() / 1000), reason: `contains "${word}"` });
      return { action: "reject", reason: `blocked: contains a forbidden word` };
    });

    // --- query hook: clamp limits
    ctx.hooks.onQuery((filters) => {
      const max = settings.get().maxQueryLimit;
      if (!filters.some((f) => (f.limit ?? 0) > max)) return undefined;
      return filters.map((f) => (f.limit !== undefined && f.limit > max ? { ...f, limit: max } : f));
    });

    // --- visibility hook: hide kinds from readers (must be sync & fast)
    ctx.hooks.onVisibility((event) => !settings.get().hiddenKinds.includes(event.kind));

    // --- bus subscription (auto-removed on disable)
    ctx.on("event.accepted", () => {
      seen++;
      seenGauge.set(seen);
    });

    // --- public routes: /plugins/hello/*
    ctx.http.get("/", (c) => c.json({ greeting: settings.get().greeting, relay: ctx.runtimeSettings().info.name, seen, rejected }));
    ctx.http.get("/ping", (c) => c.text("pong"));

    // --- admin routes: /admin/api/plugins/x/hello/* (session + RBAC applied by admin-api)
    ctx.adminHttp.get("/stats", async (c) => {
      await flush();
      const recent = await db.all("SELECT id, pubkey, at, reason FROM plugin_hello_rejections ORDER BY at DESC LIMIT 20");
      return c.json({ seen, rejected, recent });
    });
    ctx.adminHttp.post("/reset", async (c) => {
      seen = 0;
      rejected = 0;
      pending = [];
      await db.run("DELETE FROM plugin_hello_rejections");
      await ctx.audit.record({ actor: `plugin:${ctx.name}`, action: "hello.reset", target: null, details: {}, ip: null });
      return c.json({ ok: true });
    });

    // --- background job, restarted when settings change
    const startJob = (s: HelloSettings) => ctx.jobs.every("heartbeat", s.tickSeconds * 1000, () => logger.debug("heartbeat", { seen, rejected }));
    let stopJob = startJob(settings.get());
    const offSettings = settings.onChange((s) => {
      stopJob();
      stopJob = startJob(s);
      logger.info("settings updated", { blockedWord: s.blockedWord });
    });

    teardownFn = async () => {
      offSettings();
      stopJob();
      stopFlush();
      // write what is still buffered (the host awaits teardown before closing the database)
      await flush().catch((err) => logger.warn("final flush of rejections failed", { error: String(err) }));
    };
    logger.info(`hello plugin ready (blocked word: "${settings.get().blockedWord}")`);
  },

  async teardown() {
    // hooks/routes/jobs/listeners are removed by the host; this is for anything else you created
    const fn = teardownFn;
    teardownFn = undefined;
    await fn?.();
  },
};

export default plugin;
