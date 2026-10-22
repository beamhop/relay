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

let teardownFn: (() => void) | undefined;

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
  ],
  // relative to the plugin package root; built by `bun run build:ui`
  ui: "./dist/ui.js",

  async setup(ctx) {
    const { logger, db, settings } = ctx;
    let seen = 0;
    let rejected = 0;
    const rejectedCounter = ctx.metrics.counter("hello_rejected_total", "events rejected by the hello plugin");
    const seenGauge = ctx.metrics.gauge("hello_events_seen", "accepted events observed since the plugin started");

    // --- write hook: reject a configurable word
    ctx.hooks.onWrite(async (event: NostrEvent) => {
      const word = settings.get().blockedWord.trim().toLowerCase();
      if (!word || !event.content.toLowerCase().includes(word)) return undefined;
      rejected++;
      rejectedCounter.add(1, { kind: String(event.kind) });
      await db.run("INSERT INTO plugin_hello_rejections (id, pubkey, at, reason) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING", [
        event.id, event.pubkey, Math.floor(Date.now() / 1000), `contains "${word}"`,
      ]);
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
      const recent = await db.all("SELECT id, pubkey, at, reason FROM plugin_hello_rejections ORDER BY at DESC LIMIT 20");
      return c.json({ seen, rejected, recent });
    });
    ctx.adminHttp.post("/reset", async (c) => {
      seen = 0;
      rejected = 0;
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

    teardownFn = () => {
      offSettings();
      stopJob();
    };
    logger.info(`hello plugin ready (blocked word: "${settings.get().blockedWord}")`);
  },

  teardown() {
    // hooks/routes/jobs/listeners are removed by the host; this is for anything else you created
    teardownFn?.();
    teardownFn = undefined;
  },
};

export default plugin;
