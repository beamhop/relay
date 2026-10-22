import { z } from "zod";
import { definePlugin } from "@beamhop/sdk";

export const calls = { setup: 0, teardown: 0, jobs: 0, events: 0 };
export default definePlugin({
  name: "good",
  version: "1.2.3",
  description: "good fixture",
  settings: z.object({ word: z.string().min(1).default("spam"), limit: z.number().int().max(10).default(3) }),
  migrations: [{ id: "001", up: "CREATE TABLE IF NOT EXISTS plugin_good (id TEXT)" }],
  ui: "./ui.js",
  setup(ctx) {
    calls.setup++;
    ctx.hooks.onWrite((ev) => (ev.content.includes(ctx.settings.get().word) ? { action: "reject", reason: "blocked: word" } : undefined));
    ctx.http.get("/hello", (c) => c.json({ hello: ctx.name, path: c.req.path }));
    ctx.adminHttp.get("/stats", (c) => c.json({ word: ctx.settings.get().word }));
    ctx.jobs.every("tick", 100, () => { calls.jobs++; });
    ctx.on("connection.open", () => { calls.events++; });
  },
  teardown() {
    calls.teardown++;
  },
});
