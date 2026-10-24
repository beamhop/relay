/**
 * The bundled plugins loaded the way operators do it: `plugins.packages` (plugins/hello, plugins/spam-filter) and
 * enabled on first boot via `plugins.enabled`. Covers the hooks the existing admin-system test doesn't: hello's
 * query clamp, visibility hook, ping route and UI bundle; spam-filter's heuristics, exemptions, shadow mode, admin
 * routes and metrics. Plugin sources are only read.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { RelayClient, newUser, sign } from "../harness/client";
import { api } from "./admin-helpers";
import { RELAXED_LIMITS, clients, rand } from "./core-helpers";
import { bootGap, type GapRelay } from "./gap-helpers";

const PLUGINS = join(import.meta.dir, "../../plugins");
let relay: GapRelay;
const pool = clients();
let c: RelayClient;

const owner = () => relay.owner.sk;
const pluginSettings = async (name: string, values: Record<string, unknown>) => {
  const r = await api(relay.http, owner(), "PATCH", `/plugins/${name}/settings`, { values });
  if (r.status !== 200) throw new Error(`plugin settings ${name}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.values;
};

beforeAll(async () => {
  relay = await bootGap({
    overrides: { plugins: { packages: [join(PLUGINS, "hello"), join(PLUGINS, "spam-filter")] } },
    extras: { pluginsEnabled: ["hello", "spam-filter"] },
  });
  const s = await api(relay.http, owner(), "PATCH", "/settings", { limits: RELAXED_LIMITS });
  if (s.status !== 200) throw new Error(`settings: ${s.status}`);
  c = await pool.connect(relay.ws);
});
afterAll(async () => {
  pool.closeAll();
  await relay?.stop();
});

describe("loading", () => {
  test("both packages are discovered and running because plugins.enabled listed them", async () => {
    const r = await api(relay.http, owner(), "GET", "/plugins");
    expect(r.status).toBe(200);
    const byName = Object.fromEntries(r.body.items.map((p: any) => [p.name, p]));
    expect(byName.hello?.enabled).toBe(true);
    expect(byName["spam-filter"]?.enabled).toBe(true);
  });

  test("hello serves its public ping route and its admin UI bundle", async () => {
    const ping = await fetch(`${relay.http}/plugins/hello/ping`);
    expect(ping.status).toBe(200);
    expect(await ping.text()).toBe("pong");
    const ui = await fetch(`${relay.http}/admin/plugins-ui/hello.js`);
    expect(ui.status).toBe(200);
    expect(ui.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(ui.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ui.headers.get("cache-control")).toBe("no-cache");
    expect((await ui.text()).length).toBeGreaterThan(0);
    // spam-filter has no UI bundle
    expect((await fetch(`${relay.http}/admin/plugins-ui/spam-filter.js`)).status).toBe(404);
  });

  test("plugin metrics are exported on /metrics", async () => {
    const body = await (await fetch(`${relay.http}/metrics`)).text();
    expect(body).toContain("hello_events_seen");
  });
});

describe("hello: query and visibility hooks", () => {
  test("maxQueryLimit clamps an explicit REQ limit but leaves limit-less filters to the relay default", async () => {
    // spam-filter rate-limits new pubkeys to 5 notes/min; the owner is exempt, so seed with a kind it doesn't score
    const u = newUser();
    for (let i = 0; i < 6; i++) expect((await c.publish(sign(u.sk, { kind: 7, content: `clamp ${i} ${rand()}`, created_at: Math.floor(Date.now() / 1000) - i }))).ok).toBe(true);
    await pluginSettings("hello", { maxQueryLimit: 3 });
    try {
      expect((await c.query("clamped", [{ authors: [u.pubkey], limit: 50 }])).events.length).toBe(3);
      expect((await c.query("small", [{ authors: [u.pubkey], limit: 2 }])).events.length).toBe(2);
      expect((await c.query("nolimit", [{ authors: [u.pubkey] }])).events.length).toBe(6);
    } finally {
      await pluginSettings("hello", { maxQueryLimit: 500 });
    }
    expect((await c.query("unclamped", [{ authors: [u.pubkey], limit: 50 }])).events.length).toBe(6);
  });

  test("hiddenKinds hides stored and live events of that kind from readers until removed", async () => {
    const u = newUser();
    const KIND = 30333;
    await pluginSettings("hello", { hiddenKinds: [KIND] });
    try {
      const watcher = await pool.connect(relay.ws);
      watcher.send(["REQ", "hidden-live", { kinds: [KIND, 1], authors: [u.pubkey] }]);
      await watcher.waitFor((m) => m[0] === "EOSE" && m[1] === "hidden-live");
      const hidden = sign(u.sk, { kind: KIND, tags: [["d", rand()]], content: "secret-ish" });
      const shown = sign(u.sk, { kind: 1, content: `visible ${rand()}` });
      expect((await c.publish(hidden)).ok).toBe(true); // still stored
      expect((await c.publish(shown)).ok).toBe(true);
      const live = await watcher.waitFor((m) => m[0] === "EVENT" && m[1] === "hidden-live");
      expect((live[2] as { id: string }).id).toBe(shown.id);
      await watcher.expectNone((m) => m[0] === "EVENT" && (m[2] as { id: string }).id === hidden.id, 200);
      expect((await c.query("hidden-stored", [{ ids: [hidden.id, shown.id] }])).events.map((e) => e.id)).toEqual([shown.id]);
      await pluginSettings("hello", { hiddenKinds: [] });
      expect((await c.query("unhidden", [{ ids: [hidden.id] }])).events.map((e) => e.id)).toEqual([hidden.id]);
    } finally {
      await pluginSettings("hello", { hiddenKinds: [] });
    }
  });
});

describe("spam-filter", () => {
  test("a mention flood (26 p tags) is rejected with the scorer's reason; the configured owner is exempt", async () => {
    const tags = Array.from({ length: 26 }, () => ["p", newUser().pubkey]);
    const spam = sign(newUser().sk, { kind: 1, content: `hey all ${rand()}`, tags });
    expect(await c.publish(spam)).toEqual({ ok: false, message: "blocked: looks like spam (26 mentions)" });
    expect((await c.query("spam-q", [{ ids: [spam.id] }])).events).toEqual([]);
    const fromOwner = sign(owner(), { kind: 1, content: `owner shout ${rand()}`, tags });
    expect((await c.publish(fromOwner)).ok).toBe(true);
    // kinds outside the scored list pass
    expect((await c.publish(sign(newUser().sk, { kind: 7, content: "+", tags }))).ok).toBe(true);
  });

  test("the same text from more than 3 pubkeys is rejected from the 4th on", async () => {
    const text = `Buy cheap followers now, totally legit offer ${rand()}`;
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await c.publish(sign(newUser().sk, { kind: 1, content: text })));
    expect(results.slice(0, 3).every((r) => r.ok)).toBe(true);
    for (const r of results.slice(3)) {
      expect(r.ok).toBe(false);
      expect(r.message).toStartWith("blocked: looks like spam (same content from");
    }
  });

  test("a brand-new pubkey posting more than 5 notes a minute is rejected; re-sending the same signed event is not a repeat", async () => {
    const u = newUser();
    const evs = Array.from({ length: 7 }, (_, i) => sign(u.sk, { kind: 1, content: `note number ${i} ${rand()}` }));
    const out = [];
    for (const e of evs) out.push(await c.publish(e));
    expect(out.slice(0, 5).every((r) => r.ok)).toBe(true);
    expect(out[5]).toEqual({ ok: false, message: "blocked: looks like spam (new account posting 6/min)" });
    // a client retry of an accepted event keeps its verdict (duplicate), not a new rate hit
    const retry = await c.publish(evs[0]);
    expect(retry.ok).toBe(true);
  });

  test("shadow mode answers OK true but drops the event; switching back to reject restores OK false", async () => {
    await pluginSettings("spam-filter", { action: "shadow" });
    const tags = Array.from({ length: 30 }, () => ["p", newUser().pubkey]);
    try {
      const ev = sign(newUser().sk, { kind: 1, content: `shadowed ${rand()}`, tags });
      const watcher = await pool.connect(relay.ws);
      watcher.send(["REQ", "shadow-live", { ids: [ev.id] }]);
      await watcher.waitFor((m) => m[0] === "EOSE" && m[1] === "shadow-live");
      const r = await c.publish(ev);
      expect(r.ok).toBe(true);
      await watcher.expectNone((m) => m[0] === "EVENT" && m[1] === "shadow-live", 200);
      expect((await c.query("shadow-q", [{ ids: [ev.id] }])).events).toEqual([]);
    } finally {
      await pluginSettings("spam-filter", { action: "reject" });
    }
    const again = sign(newUser().sk, { kind: 1, content: `rejected again ${rand()}`, tags });
    expect((await c.publish(again)).ok).toBe(false);
  });

  test("admin routes: /score previews a verdict without recording it, rejects malformed bodies; /stats counts blocks", async () => {
    const tags = Array.from({ length: 40 }, () => ["p", newUser().pubkey]);
    const preview = await api(relay.http, owner(), "POST", "/plugins/x/spam-filter/score", { pubkey: newUser().pubkey, kind: 1, tags, content: "hi" });
    expect(preview.status).toBe(200);
    expect(preview.body.score).toBeGreaterThanOrEqual(1);
    expect(preview.body.reasons).toContain("40 mentions");
    expect((await api(relay.http, owner(), "POST", "/plugins/x/spam-filter/score", { kind: "1" })).status).toBe(400);
    const stats = await api(relay.http, owner(), "GET", "/plugins/x/spam-filter/stats");
    expect(stats.status).toBe(200);
    expect(stats.body.blocked).toBeGreaterThanOrEqual(1);
    expect(stats.body.recent[0]).toMatchObject({ kind: 1 });
    const body = await (await fetch(`${relay.http}/metrics`)).text();
    expect(body).toContain("spam_filter_blocked_total");
  });

  test("disabling the plugin at runtime removes its write hook; re-enabling restores it", async () => {
    const tags = Array.from({ length: 30 }, () => ["p", newUser().pubkey]);
    expect((await api(relay.http, owner(), "POST", "/plugins/spam-filter/disable")).body.enabled).toBe(false);
    try {
      expect((await c.publish(sign(newUser().sk, { kind: 1, content: `free ${rand()}`, tags }))).ok).toBe(true);
    } finally {
      expect((await api(relay.http, owner(), "POST", "/plugins/spam-filter/enable")).body.enabled).toBe(true);
    }
    expect((await c.publish(sign(newUser().sk, { kind: 1, content: `blocked ${rand()}`, tags }))).ok).toBe(false);
  });
});
