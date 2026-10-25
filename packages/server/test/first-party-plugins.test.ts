import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EventBus, HookRegistry, createLogger, type NostrEvent } from "@beamhop/sdk";
import { createPluginManager, type ServerPluginManager } from "../src/plugins/manager";
import { SpamScorer } from "../../../plugins/spam-filter/src/index";
import { stubMetrics, stubRelay, stubSettings, stubStores, testConfig } from "./stubs";

const pluginsDir = join(import.meta.dir, "../../../plugins");
let n = 0;
const ev = (content: string, pubkey = "a".repeat(64), tags: string[][] = []) =>
  ({ id: String(++n).padStart(64, "0"), pubkey, created_at: 0, kind: 1, tags, content, sig: "s" }) as NostrEvent;

describe("first-party plugins", () => {
  let pm: ServerPluginManager;
  const hooks = new HookRegistry();
  const stores = stubStores();
  beforeAll(async () => {
    pm = createPluginManager({
      config: testConfig({ plugins: { dir: pluginsDir } }),
      stores, settings: stubSettings(), hooks, bus: new EventBus(), logger: createLogger("error"), relay: stubRelay(), metrics: stubMetrics(),
      defaultEnabled: ["hello", "spam-filter"], autoDiscoverNpm: false,
    });
    await pm.start();
  });
  afterAll(() => pm.stop());

  test("both load and run", () => {
    const names = Object.fromEntries(pm.list().map((p) => [p.name, p.status]));
    expect(names).toMatchObject({ hello: "running", "spam-filter": "running" });
    expect(pm.get("hello")!.settingsSchema).toBeDefined();
  });

  test("hello blocks the configured word and clamps limits", async () => {
    expect((await hooks.runWrite(ev("this has a FORBIDDEN-WORD in it"), { source: "ws" })).result).toBe("reject");
    await pm.updateSettings("hello", { blockedWord: "", maxQueryLimit: 10 }, "t");
    expect((await hooks.runWrite(ev("this has a forbidden-word in it"), { source: "ws" })).result).toBe("next");
    expect(await hooks.runQuery([{ kinds: [1], limit: 100 }], { source: "ws" })).toEqual({ filters: [{ kinds: [1], limit: 10 }] });
    const res = await pm.handlePublic("hello", new Request("http://x/plugins/hello/"));
    expect((await res!.json()).greeting).toBe("Hello from beamhop!");
  });

  test("hello buffers rejections instead of writing the database per rejected event", async () => {
    await pm.updateSettings("hello", { blockedWord: "bufferme" }, "t");
    await pm.adminRoutes.fetch(new Request("http://x/hello/stats")); // flush earlier tests' rejections
    const sql: string[] = [];
    const run = stores.db.run;
    stores.db.run = async (q, p) => {
      sql.push(q);
      return run(q, p);
    };
    try {
      for (let i = 0; i < 20; i++) expect((await hooks.runWrite(ev(`bufferme ${i}`, i.toString(16).padStart(64, "d")), { source: "ws" })).result).toBe("reject");
      expect(sql).toEqual([]);
      // the admin stats route flushes first: one insert per buffered rejection plus one prune, in a transaction
      await pm.adminRoutes.fetch(new Request("http://x/hello/stats"));
      expect(sql.filter((q) => q.startsWith("INSERT"))).toHaveLength(20);
      expect(sql.filter((q) => q.startsWith("DELETE"))).toHaveLength(1);
    } finally {
      stores.db.run = run;
    }
  });

  test("spam-filter rejects copy/paste floods across pubkeys", async () => {
    const msg = "Check out this amazing giveaway, totally not a scam!!!";
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await hooks.runWrite(ev(msg, String(i).repeat(64)), { source: "ws" })).result);
    expect(results.slice(0, 3)).toEqual(["next", "next", "next"]);
    expect(results[4]).toBe("reject");
    const stats = await (await pm.adminRoutes.fetch(new Request("http://x/spam-filter/stats"))).json();
    expect(stats.blocked).toBeGreaterThan(0);
  });

  test("spam-filter /score validates tags instead of throwing", async () => {
    const score = (tags: unknown) =>
      pm.adminRoutes.fetch(new Request("http://x/spam-filter/score", { method: "POST", body: JSON.stringify({ pubkey: "a".repeat(64), kind: 1, content: "hi", tags }) }));
    expect((await score([null])).status).toBe(400);
    expect((await score([["p", 5]])).status).toBe(400);
    expect((await score([["p", "b".repeat(64)]])).status).toBe(200);
  });
});

describe("SpamScorer heuristics", () => {
  const settings = () => ({
    kinds: [1], threshold: 1, action: "reject" as const, exemptPubkeys: [], exemptAdmins: true,
    duplicateWindowSec: 900, duplicateMaxPubkeys: 3, duplicateMinLength: 20, duplicateWeight: 1,
    repeatMaxPerPubkey: 3, repeatWeight: 0.6, maxLinks: 4, maxLinkRatio: 0.5, linkWeight: 0.6,
    maxMentions: 25, mentionWeight: 1, newAccountAgeSec: 3600, newAccountEventsPerMinute: 5, newAccountLinkWeight: 0.4, rateWeight: 1,
  });
  const old = Math.floor(Date.now() / 1000) - 86400 * 30;

  test("link density + new account", () => {
    const s = new SpamScorer(settings);
    const links = "https://a.com https://b.com https://c.com";
    expect(s.score(ev(links), { firstSeenAt: old }).score).toBe(0.6);
    expect(s.score(ev(links, "b".repeat(64))).score).toBe(1); // new account adds 0.4
  });

  test("mention flood and new-account rate limit", () => {
    const s = new SpamScorer(settings);
    const tags = Array.from({ length: 30 }, (_, i) => ["p", String(i)]);
    expect(s.score(ev("hi", "c".repeat(64), tags), { firstSeenAt: old }).reasons).toContain("30 mentions");
    let last = { score: 0, reasons: [] as string[] };
    for (let i = 0; i < 7; i++) last = s.score(ev(`msg ${i}`, "d".repeat(64)));
    expect(last.score).toBeGreaterThanOrEqual(1);
    for (let i = 0; i < 7; i++) last = s.score(ev(`msg ${i}`, "e".repeat(64)), { firstSeenAt: old });
    expect(last.score).toBe(0);
  });

  test("re-sending the same signed event (client retry) is not counted as a repeat or towards the rate", () => {
    const s = new SpamScorer(settings);
    const once = { ...ev("check out my new site at https://example.com please"), id: "f".repeat(64) };
    const first = s.score(once);
    expect(first.score).toBe(0.4); // new account posting a link
    for (let i = 0; i < 8; i++) expect(s.score({ ...once }).score).toBe(first.score);
  });
});
