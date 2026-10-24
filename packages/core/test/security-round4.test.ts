import { describe, expect, setSystemTime, test } from "bun:test";
import { compileRegexFilter, ConfigSchema, type Filter, type NostrEvent, REGEX_FILTER_MAX_INPUT, regexFilterInputLimit } from "@beamhop/sdk";
import type { RelayContext } from "../src/context";
import { createHttp } from "../src/http/app";
import { createRelay, Negentropy, NegentropyStorage, validateEventShape } from "../src";
import { GROUP_CREATES_PER_HOUR } from "../src/nips/nip29/groups";
import { MAX_VANISH_MARKERS } from "../src/pipeline/special-kinds";
import { EPHEMERAL_DEDUP_MS, VANISH_PER_MINUTE } from "../src/pipeline/write";
import { MAX_FILTER_WEIGHT_PER_CONN } from "../src/protocol/handlers";
import { restrictedSubFilters } from "../src/subscriptions/visibility";
import { compileFilter, matchCompiled, matchFilter, SEARCH_FILTER_WEIGHT } from "../src/util/filter";
import { eventually, FakeSocket, keypair, now, PUBLIC_URL, setup, sign, tick } from "./fakes";

const h = (id: string, extra: string[][] = []) => [["h", id], ...extra];
const hex = (n: number) => n.toString(16).padStart(64, "0");
type Conn = ReturnType<Awaited<ReturnType<typeof setup>>["connect"]>;

/** Runs a NIP-77 sync from a client holding `mine`; returns the ids it needs / has, or the NEG-ERR reason. */
async function sync(c: Conn, filter: object, mine: { id: string; created_at: number }[] = []): Promise<{ need: string[]; have: string[] } | string> {
  const s = new NegentropyStorage();
  for (const it of mine) s.insert(it.created_at, it.id);
  s.seal();
  const client = new Negentropy(s, 0);
  const need: string[] = [];
  const have: string[] = [];
  let msg: string | null = client.initiate();
  let first = true;
  while (msg !== null) {
    const from = c.socket.sent.length;
    c.send(first ? ["NEG-OPEN", "n", filter, msg] : ["NEG-MSG", "n", msg]);
    first = false;
    const resp = await c.socket.waitFor((m) => (m[0] === "NEG-MSG" || m[0] === "NEG-ERR") && m[1] === "n", 20_000, from);
    if (resp[0] === "NEG-ERR") return resp[2] as string;
    const r = client.reconcile(resp[2] as string);
    need.push(...r.need);
    have.push(...r.have);
    msg = r.output;
  }
  return { need, have };
}

describe("NIP-62 requests to vanish can't be used to publish (finding 1)", () => {
  test("requests that delete nothing aren't stored; they skip hooks and policies but have a per-address rate limit", async () => {
    const { connect, stores, hooks } = await setup({
      settings: { access: { mode: "whitelist" }, limits: { eventsPerMinute: 1 }, moderation: { kindBlocklist: [62] } },
    });
    let hookCalls = 0;
    hooks.onWrite(() => {
      hookCalls++;
      return { action: "reject", reason: "nope" };
    }, "test");
    const c = connect("7.7.7.7");
    const results: [string, string, boolean, string][] = [];
    for (let i = 0; i < VANISH_PER_MINUTE + 2; i++) {
      results.push(await c.publish(sign(keypair(), { kind: 62, content: `SPAM ${i} `.repeat(400), tags: [["relay", "ALL_RELAYS"], ["t", "spam"]] })));
    }
    expect(results.slice(0, VANISH_PER_MINUTE).every((r) => r[2] && r[3] === "")).toBe(true);
    expect(results.slice(VANISH_PER_MINUTE).every((r) => !r[2] && r[3].startsWith("rate-limited:"))).toBe(true);
    expect([...stores.events.events.values()].some((e) => e.kind === 62)).toBe(false);
    expect(hookCalls).toBe(0);
  });

  test("a stored request replayed is a duplicate before the vanish bucket is charged", async () => {
    const { connect, stores } = await setup();
    const kp = keypair();
    await stores.events.save(sign(kp, { created_at: now() - 5 }));
    await stores.users.upsert(kp.pk, {});
    const v = sign(kp, { kind: 62, tags: [["relay", "ALL_RELAYS"]] });
    expect((await connect("8.8.8.8").publish(v))[2]).toBe(true);
    expect(stores.events.events.has(v.id)).toBe(true);
    for (let i = 0; i < VANISH_PER_MINUTE + 2; i++) expect((await connect("8.8.8.8").publish(v))[3]).toMatch(/^duplicate:/);
  });

  test("a request that took effect is kept; oversized or policy-filtered ones only take effect", async () => {
    const { connect, stores, bus } = await setup({
      settings: { moderation: { wordFilters: [{ id: "w", pattern: "badword", isRegex: false, kinds: [], action: "reject", enabled: true }] } },
    });
    const sub = connect("9.9.9.9");
    sub.send(["REQ", "v", { kinds: [62] }]);
    await tick(10);
    const c = connect();
    const accepted: string[] = [];
    bus.on("event.accepted", ({ event }) => void (event.kind === 62 && accepted.push(event.id)));
    for (const content of ["", "x".repeat(2000), "badword"]) {
      const kp = keypair();
      const note = sign(kp, { created_at: now() - 5 });
      await c.publish(note);
      const v = sign(kp, { kind: 62, content, tags: [["relay", "ALL_RELAYS"]] });
      expect(await c.publish(v)).toEqual(["OK", v.id, true, ""]);
      expect(stores.events.events.has(note.id)).toBe(false);
      expect(stores.events.events.has(v.id)).toBe(content === "");
      expect(accepted.includes(v.id)).toBe(content === "");
    }
    await tick(10);
    expect(sub.socket.of("EVENT").length).toBe(1);
  });

  test("lasting vanish markers stop at MAX_VANISH_MARKERS (the deletion still happens)", async () => {
    const { deps, stores } = await setup();
    for (let i = 0; i < MAX_VANISH_MARKERS; i++) stores.kv.data.set(`core-vanish/${hex(i)}`, 1);
    const relay = await createRelay(deps);
    const s = new FakeSocket();
    const handle = relay.handleConnection(s, { ip: "1.2.3.4" });
    const kp = keypair();
    const note = sign(kp, { created_at: now() - 5 });
    await stores.events.save(note);
    await stores.users.upsert(kp.pk, {});
    const v = sign(kp, { kind: 62, tags: [["relay", "ALL_RELAYS"]] });
    handle.onMessage(JSON.stringify(["EVENT", v]));
    expect((await s.waitFor((m) => m[0] === "OK" && m[1] === v.id))[2]).toBe(true);
    expect(stores.events.events.has(note.id)).toBe(false);
    expect(await stores.kv.get("core-vanish", kp.pk)).toBeUndefined();
    expect(Object.keys(await stores.kv.list("core-vanish")).length).toBe(MAX_VANISH_MARKERS);
  });
});

describe("group visibility bookkeeping (finding 2)", () => {
  test("restrictedSubFilters is linear in groups and filter values", () => {
    const ids = Array.from({ length: 50_000 }, (_, i) => `g${i}`);
    const ctx = { groups: { unreadable: () => ({ privateIds: ids, hiddenIds: ids }) }, key: { pubkey: hex(1) } } as unknown as RelayContext;
    const vals = Array.from({ length: 5000 }, (_, i) => `g${i * 7}`);
    const t0 = performance.now();
    const subs = restrictedSubFilters(ctx, { "#h": vals, "#d": vals }, new Set());
    expect(performance.now() - t0).toBeLessThan(100); // was ~650 ms (50k × 5000 per narrowed field)
    expect(subs.find((f) => f["#h"] && !f.kinds)?.["#h"]?.length).toBe(5000);
  });

  test("cached unreadable() results follow membership changes", async () => {
    const { connect } = await setup();
    const admin = keypair();
    const bob = keypair();
    const a = connect("1.1.1.1");
    await a.publish(sign(admin, { kind: 9007, tags: h("pg", [["private"]]) }));
    const post = sign(admin, { kind: 9, content: "members only", tags: h("pg") });
    await a.publish(post);
    const b = connect("2.2.2.2");
    await b.auth(bob);
    expect((await b.req("r1", { "#h": ["pg"], kinds: [9] })).events).toEqual([]);
    await a.publish(sign(admin, { kind: 9000, tags: h("pg", [["p", bob.pk]]) }));
    expect((await b.req("r2", { "#h": ["pg"], kinds: [9] })).events.map((e) => e.id)).toEqual([post.id]);
    await a.publish(sign(admin, { kind: 9001, tags: h("pg", [["p", bob.pk]]) }));
    expect((await b.req("r3", { "#h": ["pg"], kinds: [9] })).events).toEqual([]);
  });

  test("group creation is rate limited per pubkey and per address; staff are exempt", async () => {
    const owner = keypair();
    const { connect } = await setup({ config: { admin: { owners: [owner.pk] } } });
    const c = connect("3.3.3.3");
    const kp = keypair();
    for (let i = 0; i < GROUP_CREATES_PER_HOUR.pubkey; i++) expect((await c.publish(sign(kp, { kind: 9007, tags: h(`k${i}`) })))[2]).toBe(true);
    expect((await c.publish(sign(kp, { kind: 9007, tags: h("one-more") })))[3]).toMatch(/^rate-limited:/);
    for (let i = 0; i < GROUP_CREATES_PER_HOUR.pubkey + 5; i++) expect((await c.publish(sign(owner, { kind: 9007, tags: h(`o${i}`) })))[2]).toBe(true);
    // per address: fresh keys don't get around it
    const d = connect("4.4.4.4");
    const results: boolean[] = [];
    for (let k = 0; k < GROUP_CREATES_PER_HOUR.ip / 5 + 1; k++) {
      const key = keypair();
      for (let i = 0; i < 5; i++) results.push((await d.publish(sign(key, { kind: 9007, tags: h(`ip${k}-${i}`) })))[2]);
    }
    expect(results.filter(Boolean).length).toBe(GROUP_CREATES_PER_HOUR.ip);
  });
});

describe("live search filters (finding 3)", () => {
  test("search filters are charged SEARCH_FILTER_WEIGHT, also when they only subscribe (limit 0)", async () => {
    const { connect } = await setup();
    const c = connect();
    const fits = Math.floor(MAX_FILTER_WEIGHT_PER_CONN / (SEARCH_FILTER_WEIGHT + 1));
    const filters = (n: number, i: number) => Array.from({ length: n }, (_, k) => ({ search: `term${i}x${k}`, limit: 0 }));
    let left = fits;
    for (let i = 0; left > 0; i++) {
      const n = Math.min(10, left);
      expect((await c.req(`s${i}`, ...filters(n, i))).end[0]).toBe("EOSE");
      left -= n;
    }
    const { end } = await c.req("over", { search: "one more", limit: 0 });
    expect(end[0]).toBe("CLOSED");
    expect(String(end[2])).toMatch(/^restricted: too many filter values/);
  });

  test("live search matching is case-insensitive with terms parsed once per filter", async () => {
    const { connect } = await setup();
    const sub = connect("5.5.5.5");
    sub.send(["REQ", "s", { search: 'Hello "big World" language:en', limit: 0 }]);
    await tick(10);
    const c = connect();
    await c.publish(sign(keypair(), { content: "hello there, BIG world!" }));
    await c.publish(sign(keypair(), { content: "hello world" }));
    await tick(10);
    expect(sub.socket.of("EVENT").map((m) => (m[2] as NostrEvent).content)).toEqual(["hello there, BIG world!"]);
    expect(compileFilter({ search: 'a "b c"' }).search).toEqual(["a", "b c"]);
  });
});

describe("NEG-OPEN preparation (finding 4)", () => {
  test("ids are listed page by page into compact storage; the result matches the full set exactly", async () => {
    const { connect, stores } = await setup();
    // three events per second, so page boundaries cut through seconds
    const all = Array.from({ length: 120_000 }, (_, i) => ({ id: hex(i + 1), created_at: 1_700_000_000 + Math.floor(i / 3) }));
    const calls: Filter[] = [];
    stores.events.queryIdsForSync = async (f: Filter) => {
      calls.push(f);
      const from = f.since === undefined ? 0 : all.findIndex((r) => r.created_at >= f.since!);
      return from < 0 ? [] : all.slice(from, from + (f.limit ?? all.length));
    };
    const r = await sync(connect(), { kinds: [1] }, all);
    expect(r).toEqual({ need: [], have: [] });
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every((f) => (f.limit ?? Infinity) <= 50_000)).toBe(true);
  }, 60_000);

  test("a page of one second that can't be paged past is refused", async () => {
    const { connect, stores } = await setup();
    stores.events.queryIdsForSync = async (f: Filter) => Array.from({ length: f.limit ?? 10 }, (_, i) => ({ id: hex(i + 1), created_at: 1_700_000_000 }));
    expect(await sync(connect(), { kinds: [1] })).toMatch(/^blocked: too many events with the same created_at/);
  });

  test("NegentropyStorage merges duplicates and leaves excluded items out", () => {
    const s = new NegentropyStorage();
    for (const [ts, n] of [[2, 1], [1, 2], [2, 1], [1, 3]]) s.insert(ts, hex(n));
    s.seal([{ id: hex(3), created_at: 1 }, { id: hex(9), created_at: 5 }]);
    expect(s.size()).toBe(2);
    expect([0, 1].map((i) => s.getItem(i).timestamp)).toEqual([1, 2]);
  });
});

describe("NIP-29 moderation (findings 5 and 7)", () => {
  test("a 9005 tombstones what it removes: anyone replaying it is refused", async () => {
    const { connect, stores } = await setup();
    const admin = keypair();
    const user = keypair();
    const a = connect("1.1.1.1");
    await a.publish(sign(admin, { kind: 9007, tags: h("g1") }));
    const msg = sign(user, { kind: 9, content: "hello", tags: h("g1") });
    await connect("2.2.2.2").publish(msg);
    await a.publish(sign(admin, { kind: 9005, tags: h("g1", [["e", msg.id]]) }));
    const replay = await connect("3.3.3.3").publish(msg);
    expect(replay[2]).toBe(false);
    expect(replay[3]).toMatch(/^blocked: .*deleted/);
    expect(stores.events.events.has(msg.id)).toBe(false);
  });

  test("previous references must point at events the author can read, found by id only", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    const admin = keypair();
    const outsider = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("pub") }));
    await c.publish(sign(admin, { kind: 9007, tags: h("priv", [["private"]]) }));
    const secret = sign(admin, { kind: 9, content: "secret", tags: h("priv") });
    await c.publish(secret);
    const dm = sign(admin, { kind: 4, content: "x", tags: [["p", keypair().pk]] });
    await c.publish(dm);
    for (const ref of [secret, dm]) {
      expect((await c.publish(sign(outsider, { kind: 9, content: "probe", tags: h("pub", [["previous", ref.id.slice(0, 8)]]) })))[3]).toMatch(/^invalid: previous/);
    }
    // the author may reference what they can read; candidates are listed by id, only the matched event is loaded
    const query = stores.events.query.bind(stores.events);
    const listIds = stores.events.queryIdsForSync.bind(stores.events);
    let loaded = 0;
    stores.events.queryIdsForSync = async (f: Filter) => {
      stores.events.query = query; // the fake lists ids through query(): not an event load
      try {
        return await listIds(f);
      } finally {
        stores.events.query = counting;
      }
    };
    const counting = async (...args: Parameters<typeof query>) => {
      const r = await query(...args);
      loaded += r.length;
      return r;
    };
    stores.events.query = counting;
    expect((await c.publish(sign(admin, { kind: 9, content: "ok", tags: h("pub", [["previous", secret.id.slice(0, 8)]]) })))[2]).toBe(true);
    expect(loaded).toBe(1);
    const many = Array.from({ length: 51 }, (_, i) => ["previous", i.toString(16).padStart(8, "0")]);
    expect((await c.publish(sign(admin, { kind: 9, content: "many", tags: h("pub", many) })))[3]).toMatch(/^invalid: too many previous/);
  });
});

describe("banned and muted authors' deletions (finding 6)", () => {
  test("take effect but aren't stored or relayed", async () => {
    const { connect, stores } = await setup();
    const victim = keypair();
    const sub = connect("9.9.9.9");
    sub.send(["REQ", "s", { "#p": [victim.pk] }, { kinds: [5] }]);
    await tick(10);
    for (const status of ["banned", "muted"] as const) {
      const kp = keypair();
      const own = sign(kp, { content: "mine", created_at: now() - 10 });
      await stores.events.save(own);
      await stores.users.upsert(kp.pk, { status });
      const c = connect(status === "banned" ? "1.1.1.1" : "1.1.1.2");
      const del = sign(kp, { kind: 5, content: "harassing text", tags: [["e", own.id], ["p", victim.pk]] });
      expect(await c.publish(del)).toEqual(["OK", del.id, true, ""]);
      expect(stores.events.events.has(own.id)).toBe(false);
      expect(stores.events.events.has(del.id)).toBe(false);
    }
    await tick(10);
    expect(sub.socket.of("EVENT")).toEqual([]);
  });
});

describe("ephemeral events (finding 8)", () => {
  test("a replay within EPHEMERAL_DEDUP_MS is a duplicate and isn't relayed again", async () => {
    const { connect } = await setup();
    const sub = connect("9.9.9.9");
    sub.send(["REQ", "s", { kinds: [20001] }]);
    await tick(10);
    const ev = sign(keypair(), { kind: 20001, content: "ping" });
    expect((await connect("1.1.1.1").publish(ev))[3]).toBe("");
    const b = connect("2.2.2.2");
    expect((await b.publish(ev))[3]).toMatch(/^duplicate:/);
    await tick(10);
    expect(sub.socket.of("EVENT").length).toBe(1);
    setSystemTime(new Date(Date.now() + EPHEMERAL_DEDUP_MS + 1000));
    try {
      expect((await b.publish(ev))[3]).toBe("");
      await tick(10);
      expect(sub.socket.of("EVENT").length).toBe(2);
    } finally {
      setSystemTime();
    }
  });
});

describe("relay HTTP (findings 9, 13 and 15)", () => {
  test("/invite/redeem charges the relay's (swept) rate limiter", async () => {
    const { deps } = await setup();
    const keys: string[] = [];
    const ctx = { ...deps, s: () => deps.settings.get(), rate: { take: (k: string) => (keys.push(k), true) } } as unknown as RelayContext;
    const app = createHttp(ctx);
    const res = await app.fetch(new Request(`${PUBLIC_URL}/invite/redeem`, { method: "POST", body: "{}" }), { ip: "203.0.113.9" });
    expect(res.status).toBe(401);
    expect(keys.some((k) => k.startsWith("redeem:"))).toBe(true);
  });

  test("NIP-11 only advertises NIPs whose feature is enabled", async () => {
    const nips = async (opts: Parameters<typeof setup>[0]) => {
      const { relay } = await setup(opts);
      const res = await relay.http.request("/", { headers: { Accept: "application/nostr+json" } });
      return ((await res.json()) as { supported_nips: number[] }).supported_nips;
    };
    expect(await nips({})).toEqual(expect.arrayContaining([5, 29, 86]));
    const off = await nips({ settings: { groups: { enabled: false }, nip05: { enabled: false } }, config: { admin: { enabled: false } } });
    for (const n of [5, 29, 86]) expect(off).not.toContain(n);
    expect(off).toContain(77);
  });

  test("with nip05.domain set, nostr.json answers for that host and the relay's own host only", async () => {
    const owner = hex(7);
    const { deps } = await setup({ settings: { nip05: { domain: "Example.COM" }, info: { pubkey: owner } } });
    const warns: unknown[][] = [];
    const logger = { ...deps.logger, warn: (...a: unknown[]) => void warns.push(a), child: () => logger };
    const relay = await createRelay({ ...deps, logger });
    const get = (url: string, headers: Record<string, string> = {}) => relay.http.fetch(new Request(url, { headers }), {});
    expect((await get("https://example.com/.well-known/nostr.json?name=_")).status).toBe(200);
    expect((await get("https://example.com:8443/.well-known/nostr.json?name=_")).status).toBe(200);
    // example.com proxying the path to the relay: nginx's default `Host: $proxy_host`, or a Worker's fetch
    expect((await get(`${PUBLIC_URL}/.well-known/nostr.json?name=_`)).status).toBe(200);
    expect((await get("http://127.0.0.1:3334/.well-known/nostr.json?name=_", { "X-Forwarded-Host": "example.com" })).status).toBe(200);
    expect((await get("https://evil.example.org/.well-known/nostr.json?name=_")).status).toBe(404);
    expect((await get("https://other.example.net/.well-known/nostr.json?name=_")).status).toBe(404);
    const refused = warns.filter((w) => String(w[0]).startsWith("NIP-05 request refused"));
    expect(refused.length).toBe(1); // once, naming the host it got
    expect((refused[0][1] as { host: string }).host).toBe("evil.example.org");
    const { relay: open } = await setup({ settings: { info: { pubkey: owner } } });
    expect((await open.http.fetch(new Request("https://anything.test/.well-known/nostr.json?name=_"), {})).status).toBe(200);
  });
});

describe("NIP-56 auto-ban (finding 10)", () => {
  test("disconnects the banned pubkey's sessions", async () => {
    const { connect, stores } = await setup({ settings: { moderation: { autoBanReportThreshold: 1 } } });
    const target = keypair();
    const member = keypair();
    await stores.users.upsert(member.pk, { allowed: true });
    const t = connect("6.6.6.6");
    await t.auth(target);
    await connect("7.7.7.7").publish(sign(member, { kind: 1984, tags: [["p", target.pk, "spam"]] }));
    await eventually(() => t.socket.closed !== null);
    expect(t.socket.of("NOTICE").some((m) => m[1] === "blocked: pubkey is banned")).toBe(true);
  });
});

describe("regex word filters (finding 11)", () => {
  const t = (p: string) => {
    const c = compileRegexFilter(p);
    if ("reason" in c) throw new Error(c.reason);
    return c.test;
  };
  const pad = (n: number) => "lorem ipsum ".repeat(Math.ceil(n / 12)).slice(0, n);

  test("cheap patterns scan the whole content without faking anchors or word boundaries at window edges", () => {
    expect(t("spamword")(`${pad(20_000)} spamword ${pad(20_000)}`)).toBe(true);
    expect(t("^spamword")(`${pad(20_000)} spamword ${pad(20_000)}`)).toBe(false);
    expect(t("^spamword")(`spamword ${pad(20_000)}`)).toBe(true);
    expect(t("spamword$")(`${pad(20_000)} spamword ${pad(20_000)}`)).toBe(false);
    expect(t("spamword$")(`${pad(20_000)} spamword`)).toBe(true);
    let faked = 0;
    for (let k = 0; k < 600; k += 7) if (t("\\bass\\b")(`${"x".repeat(k)} ${"class ".repeat(4000)}`)) faked++;
    expect(faked).toBe(0);
    expect(t("\\bass\\b")(`${"class ".repeat(4000)}ass`)).toBe(true);
    // no whitespace to cut at: a word split by a window edge still isn't a word
    expect(t("\\bass\\b")(`${"x".repeat(30_000)}class${"y".repeat(30_000)}`)).toBe(false);
  });

  test("a long match within the input limit is still found when the post is padded past it", () => {
    const f = t("spam.*viagra");
    const body = `spam ${"lorem ipsum ".repeat(50)}viagra`;
    expect(f(body)).toBe(true);
    expect(f(body + " tail".repeat(200))).toBe(true);
    expect(f(body + " tail".repeat(12_000))).toBe(true);
  });

  test("greedy matches running into a window edge count (no anchors to fake)", () => {
    const max = regexFilterInputLimit("spam.*");
    // the match runs into the cut after the first run, and into every window edge after it
    expect(t("spam.*")(`${pad(max - 100)} spam ${pad(REGEX_FILTER_MAX_INPUT * 3)}`)).toBe(true);
    expect(t("spam.*")(`${pad(max + 300)} spam ${pad(REGEX_FILTER_MAX_INPUT * 3)}`)).toBe(true);
  });

  test("backtracking-prone patterns stop after one extra step budget, so hostile content stays cheap", () => {
    const f = t("\\w+x");
    const t0 = performance.now();
    expect(f("a".repeat(65_536))).toBe(false);
    expect(performance.now() - t0).toBeLessThan(100);
    // within the input limit plus what the extra budget covers, a match past the first run is found
    expect(f(`${" ".repeat(regexFilterInputLimit("\\w+x"))}ax`)).toBe(true);
  });
});

describe("word filter reports (finding 12)", () => {
  test("a 'report' match files a relay-signed report for the moderators, which never counts towards an auto-ban", async () => {
    const { connect, stores, bus, relay } = await setup({
      settings: { moderation: { autoBanReportThreshold: 1, wordFilters: [{ id: "w1", pattern: "flagme", isRegex: false, kinds: [], action: "report", enabled: true }] } },
    });
    const created: NostrEvent[] = [];
    const alerts: string[] = [];
    bus.on("report.created", ({ event }) => void created.push(event));
    bus.on("alert", (a) => void alerts.push(a.title));
    const sub = connect("9.9.9.9");
    sub.send(["REQ", "r", { kinds: [1984] }]);
    await tick(10);
    const author = keypair();
    const ev = sign(author, { content: "please flagme" });
    expect((await connect().publish(ev))[2]).toBe(true);
    await eventually(() => created.length === 1);
    const report = created[0];
    expect(report.pubkey).toBe(relay.pubkey);
    expect(report.tags).toContainEqual(["e", ev.id, "other"]);
    expect(report.tags).toContainEqual(["p", author.pk, "other"]);
    expect(await stores.events.getById(report.id)).toBeDefined();
    expect(alerts).toContain("Content flagged by word filter");
    await tick(30);
    expect(sub.socket.of("EVENT")).toEqual([]);
    expect((await stores.users.get(author.pk))?.status ?? "active").toBe("active");
  });
});

describe("word filter reports don't leak restricted events (finding 12 follow-up)", () => {
  test("no relay report for DMs or private / hidden group content; a group report carries the group's h tag", async () => {
    const { connect, stores, bus, relay } = await setup({
      settings: { moderation: { wordFilters: [{ id: "w1", pattern: "flagme", isRegex: false, kinds: [], action: "report", enabled: true }] } },
    });
    const alerts: string[] = [];
    bus.on("alert", (a) => void (a.title === "Content flagged by word filter" && alerts.push(a.message)));
    const admin = keypair();
    const c = connect();
    await c.publish(sign(admin, { kind: 9007, tags: h("pub") }));
    await c.publish(sign(admin, { kind: 9007, tags: h("priv", [["private"]]) }));
    await c.publish(sign(admin, { kind: 9007, tags: h("hid", [["hidden"]]) }));
    const flagged = [
      sign(admin, { kind: 4, content: "flagme", tags: [["p", keypair().pk]] }),
      sign(admin, { kind: 9, content: "flagme", tags: h("priv") }),
      sign(admin, { kind: 9, content: "flagme", tags: h("hid") }),
      sign(admin, { kind: 9, content: "flagme", tags: h("pub") }),
    ];
    for (const ev of flagged) expect((await c.publish(ev))[2]).toBe(true);
    const relayReports = async () => stores.events.query([{ kinds: [1984], authors: [relay.pubkey] }]); // what admin-api lists
    await eventually(async () => (await relayReports()).length === 1);
    await tick(30);
    expect(alerts.length).toBe(4); // the alert still fires for every match
    const [report] = await relayReports();
    expect(report.tags).toContainEqual(["e", flagged[3].id, "other"]);
    expect(report.tags).toContainEqual(["h", "pub"]);
    // the report follows the group: once it turns private, outsiders no longer see it
    const outsider = connect("6.6.6.6");
    expect((await outsider.req("a", { kinds: [1984], authors: [relay.pubkey] })).events.map((e) => e.id)).toEqual([report.id]);
    expect((await c.publish(sign(admin, { kind: 9002, tags: h("pub", [["private"]]) })))[2]).toBe(true);
    expect((await outsider.req("b", { kinds: [1984], authors: [relay.pubkey] })).events).toEqual([]);
    expect((await relayReports()).map((e) => e.id)).toEqual([report.id]);
  });
});

describe("tag value cap in live matching (finding 14)", () => {
  test("values the store doesn't index never match live either", () => {
    const pk = keypair();
    for (const [value, ok] of [["x".repeat(1024), true], ["x".repeat(1025), false], ["€".repeat(400), false]] as const) {
      const ev = sign(pk, { tags: [["t", value]] });
      const f = { "#t": [value] };
      expect(matchCompiled(compileFilter(f), ev)).toBe(ok);
      expect(matchFilter(f, ev)).toBe(ok);
    }
  });
});

describe("package surface (finding 16)", () => {
  test("validateEventShape is exported and createRelay needs a configured relay key", async () => {
    expect("event" in validateEventShape(sign(keypair()))).toBe(true);
    const { deps } = await setup();
    const config = ConfigSchema.parse({ server: { publicUrl: PUBLIC_URL } });
    await expect(createRelay({ ...deps, config })).rejects.toThrow(/relaySecretKey/);
  });

  test("plugin hooks still see the connection's origin and user agent (ConnectionInfo contract)", async () => {
    const { relay, hooks } = await setup();
    const seen: { origin?: string; userAgent?: string }[] = [];
    hooks.onWrite((_e, wctx) => void seen.push({ origin: wctx.conn?.origin, userAgent: wctx.conn?.userAgent }), "test");
    const socket = new FakeSocket();
    const handle = relay.handleConnection(socket, { ip: "1.2.3.4", userAgent: "ua/1", origin: "https://client.example" });
    const ev = sign(keypair());
    handle.onMessage(JSON.stringify(["EVENT", ev]));
    await socket.waitFor((m) => m[0] === "OK" && m[1] === ev.id);
    expect(seen).toEqual([{ origin: "https://client.example", userAgent: "ua/1" }]);
  });
});
