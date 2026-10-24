import { describe, expect, test } from "bun:test";
import { ConfigSchema, EventBus, type Filter, HookRegistry, type NostrEvent, type QueryOptions } from "@beamhop/sdk";
import { createTestStores } from "@beamhop/storage";
import { createRelay, Negentropy, NegentropyStorage } from "../src";
import { MAX_PRIVATE_SCAN, MAX_REFILL_SCAN, MAX_SEARCH_COUNT_SCAN } from "../src/protocol/handlers";
import { FakeSettings, FakeSocket, keypair, now, PUBLIC_URL, setup, sign, silentLogger } from "./fakes";

const hex = (n: number) => n.toString(16).padStart(64, "0");
/** An unsigned event (stores don't verify signatures): cheap to store by the thousand. */
const fake = (n: number, t: Partial<NostrEvent> = {}): NostrEvent => ({
  id: hex(n),
  pubkey: hex(1_000_000 + n),
  created_at: now() - 1000,
  kind: 1,
  tags: [],
  content: "",
  sig: "0".repeat(128),
  ...t,
});
const order = (a: NostrEvent, b: NostrEvent) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1);
/** Most events a visibility check loads at once with the default maxEventBytes (64 KB): 4 MB worth. */
const VISIBILITY_BATCH_ROWS = 64;

type QueryFn = (filters: Filter[], opts?: QueryOptions) => Promise<NostrEvent[]>;
/** Records how many rows each stored-event query (events loaded with content) returned. */
function spyLoads(store: { query: QueryFn }) {
  const rows: number[] = [];
  const query = store.query.bind(store);
  store.query = async (filters, opts) => {
    const r = await query(filters, opts);
    rows.push(r.length);
    return r;
  };
  return rows;
}

/** A relay on the real SQL storage (sqlite in memory). */
async function sqlRelay() {
  const stores = await createTestStores();
  const config = ConfigSchema.parse({ server: { publicUrl: PUBLIC_URL } });
  const relay = await createRelay({ config, stores, settings: new FakeSettings(), hooks: new HookRegistry(), bus: new EventBus(), logger: silentLogger });
  const connect = (ip = "1.2.3.4") => {
    const socket = new FakeSocket();
    const handle = relay.handleConnection(socket, { ip });
    const send = (msg: unknown[]) => handle.onMessage(JSON.stringify(msg));
    const reply = (subId: string, types: string[], from = socket.sent.length) => socket.waitFor((m) => types.includes(m[0] as string) && m[1] === subId, 20_000, from);
    const req = async (subId: string, ...filters: Filter[]) => {
      const from = socket.sent.length;
      send(["REQ", subId, ...filters]);
      const end = await reply(subId, ["EOSE", "CLOSED"], from);
      return { end, events: socket.sent.slice(from).filter((m) => m[0] === "EVENT" && m[1] === subId).map((m) => m[2] as NostrEvent) };
    };
    return { socket, send, reply, req };
  };
  return { relay, stores, connect };
}

describe("COUNT / NEG-OPEN: private candidates are checked in small batches", () => {
  test("an unauthenticated COUNT over many large gift wraps loads them a batch at a time, and stays exact", async () => {
    const { relay, stores, connect } = await sqlRelay();
    try {
      const target = keypair();
      const big = "x".repeat(60_000);
      for (let i = 0; i < 400; i++) await stores.events.save(fake(i, { kind: 1059, tags: [["p", target.pk]], content: big + i, created_at: now() - i }));
      for (let i = 0; i < 3; i++) await stores.events.save(fake(10_000 + i, { content: `public ${i}` }));
      const rows = spyLoads(stores.events);
      const c = connect();
      c.send(["COUNT", "c", {}]);
      expect(await c.reply("c", ["COUNT", "CLOSED"])).toEqual(["COUNT", "c", { count: 3 }]);
      // before: all 400 (24 MB of content) in one query; per COUNT it reached 5001 events (~300 MB)
      expect(Math.max(...rows)).toBeLessThanOrEqual(VISIBILITY_BATCH_ROWS);
      expect(rows.reduce((a, b) => a + b, 0)).toBe(400);
    } finally {
      await relay.stop();
    }
  }, 30_000);

  test("too many private candidates: refused before any of them is loaded", async () => {
    const { relay, stores, connect } = await sqlRelay();
    try {
      const target = keypair();
      for (let i = 0; i <= MAX_PRIVATE_SCAN; i++) await stores.events.save(fake(i, { kind: 1059, tags: [["p", target.pk]], created_at: now() - i }));
      const rows = spyLoads(stores.events);
      const c = connect();
      c.send(["COUNT", "c", {}]);
      const res = await c.reply("c", ["COUNT", "CLOSED"]);
      expect(res[0]).toBe("CLOSED");
      expect(String(res[2])).toMatch(/^restricted: filter matches too many private events/);
      expect(rows).toEqual([]);
    } finally {
      await relay.stop();
    }
  }, 30_000);

  test("search COUNT: hidden matches are subtracted; too many are refused before loading them", async () => {
    const { relay, stores, connect } = await sqlRelay();
    try {
      const target = keypair();
      for (let i = 0; i < 3; i++) await stores.events.save(fake(i, { kind: 1059, tags: [["p", target.pk]], content: `needle ${i}`, created_at: now() - i }));
      for (let i = 0; i < 2; i++) await stores.events.save(fake(100 + i, { content: `public needle ${i}` }));
      const c = connect();
      c.send(["COUNT", "s1", { search: "needle" }]);
      expect(await c.reply("s1", ["COUNT", "CLOSED"])).toEqual(["COUNT", "s1", { count: 2 }]);

      for (let i = 0; i < MAX_SEARCH_COUNT_SCAN; i++) await stores.events.save(fake(1000 + i, { kind: 4, tags: [["p", target.pk]], content: `needle x${i}`, created_at: now() - i }));
      const rows = spyLoads(stores.events);
      c.send(["COUNT", "s2", { search: "needle" }]);
      const res = await c.reply("s2", ["COUNT", "CLOSED"]);
      expect(res[0]).toBe("CLOSED");
      expect(String(res[2])).toMatch(/^restricted:/);
      expect(rows).toEqual([]);
    } finally {
      await relay.stop();
    }
  }, 30_000);

  test("NEG-OPEN leaves hidden events out, checking them a batch at a time", async () => {
    const { relay, stores, connect } = await sqlRelay();
    try {
      const target = keypair();
      const big = "y".repeat(60_000);
      for (let i = 0; i < 300; i++) await stores.events.save(fake(i, { kind: 1059, tags: [["p", target.pk]], content: big + i, created_at: now() - i }));
      const notes = [0, 1, 2].map((i) => fake(10_000 + i, { content: `note ${i}`, created_at: now() - 5 - i }));
      for (const ev of notes) await stores.events.save(ev);
      const rows = spyLoads(stores.events);
      const c = connect();
      const s = new NegentropyStorage();
      s.seal();
      const client = new Negentropy(s, 0);
      const need = new Set<string>();
      let msg: string | null = client.initiate();
      let first = true;
      while (msg !== null) {
        const from = c.socket.sent.length;
        c.send(first ? ["NEG-OPEN", "n", {}, msg] : ["NEG-MSG", "n", msg]);
        first = false;
        const resp = await c.reply("n", ["NEG-MSG", "NEG-ERR"], from);
        expect(resp[0]).toBe("NEG-MSG");
        const r = client.reconcile(resp[2] as string);
        for (const id of r.need) need.add(id);
        msg = r.output;
      }
      expect([...need].sort()).toEqual(notes.map((e) => e.id).sort());
      expect(Math.max(...rows)).toBeLessThanOrEqual(VISIBILITY_BATCH_ROWS);
    } finally {
      await relay.stop();
    }
  }, 30_000);
});

describe("REQ limit counts visible events only (no oracle over hidden ones)", () => {
  test("someone's DMs don't take slots of a filter mixing them with public kinds", async () => {
    const { connect } = await setup();
    const alice = keypair();
    const bob = keypair();
    const w = connect("10.0.0.1");
    const t = now();
    const k3 = sign(alice, { kind: 3, tags: [["p", bob.pk]], created_at: t - 1000, content: "" });
    await w.publish(k3);
    for (let i = 0; i < 5; i++) expect((await w.publish(sign(alice, { kind: 4, tags: [["p", bob.pk]], created_at: t - 500 + i, content: `c${i}?iv=x` })))[2]).toBe(true);
    const r = connect("10.0.0.2");
    const filter = { authors: [alice.pk], kinds: [3, 4], "#p": [bob.pk] };
    // before: limit n returned k3 only once n exceeded the DMs in the window, which leaked their timestamps
    for (const limit of [1, 2, 5, 6]) expect((await r.req(`l${limit}`, { ...filter, limit })).events.map((e) => e.id)).toEqual([k3.id]);
    for (const until of [t - 499, t - 497, t]) expect((await r.req(`u${until}`, { ...filter, since: k3.created_at, until, limit: 1 })).events.map((e) => e.id)).toEqual([k3.id]);
    // the recipient still gets the newest DMs within the limit
    const b = connect("10.0.0.3");
    await b.auth(bob);
    expect((await b.req("bob", { ...filter, limit: 3 })).events.map((e) => e.content)).toEqual(["c4?iv=x", "c3?iv=x", "c2?iv=x"]);
  });

  test("gift wraps to a target don't take slots of a mixed-kind filter", async () => {
    const { connect } = await setup();
    const target = keypair();
    const w = connect("10.0.0.1");
    const t = now();
    const notes: NostrEvent[] = [];
    for (let i = 0; i < 3; i++) {
      const ev = sign(keypair(), { tags: [["p", target.pk]], created_at: t - 100 - i, content: `note ${i}` });
      notes.push(ev);
      await w.publish(ev);
    }
    for (let i = 0; i < 6; i++) await w.publish(sign(keypair(), { kind: 1059, tags: [["p", target.pk]], created_at: t - 10 + i, content: "wrapped" }));
    const r = connect("10.0.0.2");
    expect((await r.req("g", { kinds: [1, 1059], "#p": [target.pk], limit: 3 })).events.map((e) => e.id)).toEqual(notes.map((e) => e.id));
  });

  test("events hidden by a plugin visibility hook don't take slots either", async () => {
    const { connect, hooks } = await setup();
    hooks.onVisibility((ev) => ev.content !== "secret", "test");
    const kp = keypair();
    const w = connect("10.0.0.1");
    const t = now();
    const shown = [sign(kp, { content: "a", created_at: t - 20 }), sign(kp, { content: "b", created_at: t - 21 })];
    for (const ev of shown) await w.publish(ev);
    for (let i = 0; i < 4; i++) await w.publish(sign(kp, { content: "secret", created_at: t - i }));
    expect((await connect("10.0.0.2").req("p", { kinds: [1], authors: [kp.pk], limit: 2 })).events.map((e) => e.id)).toEqual(shown.map((e) => e.id));
  });

  test("search: the top `limit` visible matches are returned even when hidden ones rank above them", async () => {
    const { connect } = await setup();
    const target = keypair();
    const w = connect("10.0.0.1");
    const t = now();
    const notes = [sign(keypair(), { content: "needle one", created_at: t - 50 }), sign(keypair(), { content: "needle two", created_at: t - 51 })];
    for (const ev of notes) await w.publish(ev);
    await w.publish(sign(keypair(), { content: "haystack", created_at: t - 40 }));
    for (let i = 0; i < 3; i++) await w.publish(sign(keypair(), { kind: 1059, tags: [["p", target.pk]], content: `needle ${i}`, created_at: t - i }));
    expect((await connect("10.0.0.2").req("s", { search: "needle", limit: 2 })).events.map((e) => e.id)).toEqual(notes.map((e) => e.id));
  });

  test("several filters: each gets its own visible limit, results merged newest first, each event once", async () => {
    const { connect } = await setup();
    const a = keypair();
    const w = connect("10.0.0.1");
    const t = now();
    const n = [50, 40, 30].map((ago, i) => sign(a, { content: `n${i}`, created_at: t - ago }));
    for (const ev of n) await w.publish(ev);
    const reaction = sign(keypair(), { kind: 7, content: "+", created_at: t - 35 });
    await w.publish(reaction);
    await w.publish(sign(a, { kind: 4, tags: [["p", keypair().pk]], content: "dm?iv=x", created_at: t - 20 }));
    const { events } = await connect("10.0.0.2").req("m", { authors: [a.pk], limit: 2 }, { kinds: [1, 7], limit: 2 });
    expect(events.map((e) => e.id)).toEqual([n[2].id, reaction.id, n[1].id]);
  });

  test("filters that can't match hidden events, or whose first page has none, still take a single query", async () => {
    const { connect, stores } = await setup();
    const kp = keypair();
    for (let i = 0; i < 10; i++) await stores.events.save(sign(kp, { content: `n${i}`, created_at: now() - i }));
    const rows = spyLoads(stores.events);
    const c = connect();
    expect((await c.req("k", { kinds: [1], limit: 5 })).events.length).toBe(5);
    expect((await c.req("a", { authors: [kp.pk], limit: 5 })).events.length).toBe(5);
    expect((await c.req("all", { authors: [kp.pk], limit: 50 })).events.length).toBe(10);
    expect(rows).toEqual([5, 5, 10]);
  });

  test("refill stops at the scan budget: the REQ completes, with a bounded number of rows loaded", async () => {
    const { connect, stores } = await setup();
    const target = keypair();
    const t = now();
    for (let i = 0; i < 3; i++) stores.events.events.set(hex(900_000 + i), fake(900_000 + i, { content: `old ${i}`, created_at: t - 100_000 - i }));
    for (let i = 0; i < MAX_REFILL_SCAN + 500; i++) stores.events.events.set(hex(i), fake(i, { kind: 1059, tags: [["p", target.pk]], created_at: t - i }));
    const rows = spyLoads(stores.events);
    const { end, events } = await connect().req("cap", { limit: 3 });
    expect(end[0]).toBe("EOSE");
    expect(events).toEqual([]);
    expect(rows.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3 + MAX_REFILL_SCAN);
    expect(rows.length).toBeLessThan(20); // pages grow while hidden events keep taking their slots
  }, 30_000);
});

describe("REQ refill pages handle many events in the same second", () => {
  // hidden and visible events interleaved by id within one second, across several page boundaries
  const seed = async (save: (ev: NostrEvent) => Promise<unknown>) => {
    const target = keypair();
    const T = now() - 100;
    const visible: NostrEvent[] = [];
    for (let i = 0; i < 120; i++) {
      const hidden = i % 3 !== 0;
      const ev = fake(i, hidden ? { kind: 1059, tags: [["p", target.pk]], created_at: T } : { content: `v${i}`, created_at: T });
      if (!hidden) visible.push(ev);
      await save(ev);
    }
    for (let i = 0; i < 10; i++) {
      const ev = fake(1000 + i, { content: `older ${i}`, created_at: T - 1 - (i % 2) });
      visible.push(ev);
      await save(ev);
    }
    return visible.sort(order);
  };

  test("fake store", async () => {
    const { connect, stores } = await setup();
    const visible = await seed(async (ev) => stores.events.events.set(ev.id, ev));
    const c = connect();
    for (const limit of [1, 10, 40, 45, 50]) {
      expect((await c.req(`t${limit}`, { limit })).events.map((e) => e.id)).toEqual(visible.slice(0, limit).map((e) => e.id));
    }
  });

  test("sql store", async () => {
    const { relay, stores, connect } = await sqlRelay();
    try {
      const visible = await seed((ev) => stores.events.save(ev));
      const c = connect();
      for (const limit of [1, 10, 40, 45, 50]) {
        expect((await c.req(`t${limit}`, { limit })).events.map((e) => e.id)).toEqual(visible.slice(0, limit).map((e) => e.id));
      }
    } finally {
      await relay.stop();
    }
  });
});

describe("write rate limits can't be drained by replaying someone's events", () => {
  test("replays of an author's stored events cost the author nothing", async () => {
    const { connect } = await setup({ settings: { limits: { eventsPerMinute: 3 } } });
    const victim = keypair();
    const v = connect("10.0.0.5");
    const old = sign(victim, { content: "old public note", created_at: now() - 86_400 });
    expect((await v.publish(old))[2]).toBe(true);
    const attacker = connect("10.0.0.6");
    for (let i = 0; i < 20; i++) expect((await attacker.publish(old))[3]).toMatch(/^duplicate:/);
    for (let i = 0; i < 2; i++) expect((await v.publish(sign(victim, { content: `fresh ${i}` })))[2]).toBe(true);
  });

  test("replays that can't be stored (an outdated profile) are charged to the submitter's address only", async () => {
    const { connect } = await setup({ settings: { limits: { eventsPerMinute: 3 } } });
    const victim = keypair();
    const v = connect("10.0.0.5");
    const v1 = sign(victim, { kind: 0, content: "{}", created_at: now() - 100 });
    expect((await v.publish(v1))[2]).toBe(true);
    expect((await v.publish(sign(victim, { kind: 0, content: '{"name":"v"}' })))[2]).toBe(true);
    const attacker = connect("10.0.0.6");
    const replies: string[] = [];
    for (let i = 0; i < 10; i++) replies.push((await attacker.publish(v1))[3]);
    expect(replies.slice(0, 3).every((m) => m.startsWith("duplicate:"))).toBe(true);
    expect(replies.slice(3).every((m) => m.startsWith("rate-limited:"))).toBe(true);
    expect((await v.publish(sign(victim, { content: "still here" })))[2]).toBe(true);
  });

  test("an author authenticated with NIP-42 isn't limited by others submitting their events, even from the same address", async () => {
    const { connect } = await setup({ settings: { limits: { eventsPerMinute: 3 } } });
    const victim = keypair();
    const elsewhere = connect("10.0.0.9");
    const v1 = sign(victim, { kind: 0, content: "{}", created_at: now() - 100 });
    await elsewhere.publish(v1);
    await elsewhere.publish(sign(victim, { kind: 0, content: '{"name":"v"}' }));
    const attacker = connect("10.0.0.5");
    for (let i = 0; i < 6; i++) await attacker.publish(v1);
    expect((await attacker.publish(v1))[3]).toMatch(/^rate-limited:/);
    const v = connect("10.0.0.5");
    expect((await v.auth(victim))[2]).toBe(true);
    for (let i = 0; i < 3; i++) expect((await v.publish(sign(victim, { content: `fresh ${i}` })))[2]).toBe(true);
    // the author's own bucket still limits the author
    expect((await v.publish(sign(victim, { content: "one too many" })))[3]).toMatch(/^rate-limited:/);
  });

  test("per-address limits still apply across keys; duplicates are answered without a token", async () => {
    const { connect } = await setup({ settings: { limits: { eventsPerMinute: 2 } } });
    const c = connect("10.0.0.7");
    const first = sign(keypair(), { content: "first" });
    expect((await c.publish(first))[2]).toBe(true);
    for (let i = 0; i < 7; i++) expect((await c.publish(sign(keypair(), { content: `k${i}` })))[2]).toBe(true);
    expect((await c.publish(sign(keypair(), { content: "over" })))[3]).toMatch(/^rate-limited:/);
    expect((await c.publish(first))[3]).toMatch(/^duplicate:/);
  });
});
