import { describe, expect, test } from "bun:test";
import type { NostrEvent } from "@beamhop/sdk";
import { Negentropy, NegentropyStorage, createRelay, matchFilter } from "../src";
import { Verifier } from "../src/pipeline/verify";
import { ipKey } from "../src/util/cidr";
import { keypair, now, setup, sign, tick } from "./fakes";

const RELAY = "wss://relay.example.com";
const h = (id: string, extra: string[][] = []) => [["h", id], ...extra];

describe("signature verification cache", () => {
  test("a cached (id, sig) pair cannot be reused with another pubkey or body", () => {
    const v = new Verifier();
    const ev = sign(keypair());
    expect(v.verify(ev)).toBe(true);
    expect(v.verify(ev)).toBe(true); // cached
    expect(v.verify({ ...ev, pubkey: keypair().pk })).toBe(false);
    expect(v.verify({ ...ev, content: "forged" })).toBe(false);
    expect(v.verify({ ...ev, kind: 5 })).toBe(false);
  });

  test("EVENT: an event rejected after verification can't be re-sent as the victim", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    const attacker = keypair();
    const victim = keypair();
    // passes verification (and is cached), then fails the created_at check
    const bait = sign(attacker, { content: "bait", created_at: now() + 10_000 });
    expect((await c.publish(bait))[3]).toMatch(/too far in the future/);
    const forged = { ...bait, pubkey: victim.pk, created_at: now(), content: "i am the victim" } as NostrEvent;
    const res = await c.publish(forged);
    expect(res[2]).toBe(false);
    expect(res[3]).toMatch(/^invalid: bad event id or signature/);
    expect(await stores.events.getById(bait.id)).toBeUndefined();
  });

  test("AUTH: a cached AUTH event can't authenticate as another pubkey", async () => {
    const { connect } = await setup();
    const c = connect();
    const attacker = keypair();
    const victim = keypair();
    const original = sign(attacker, { kind: 22242, content: "", tags: [["relay", RELAY], ["challenge", c.challenge]] });
    c.send(["AUTH", original]);
    expect((await c.socket.waitFor((m) => m[0] === "OK" && m[1] === original.id))[2]).toBe(true);
    c.send(["AUTH", { ...original, pubkey: victim.pk }]);
    const res = await c.socket.waitFor((m) => m[0] === "OK" && m[1] === original.id && m[2] === false);
    expect(res[3]).toMatch(/^invalid:/);
  });
});

describe("NIP-62 request to vanish", () => {
  test("only deletes events up to the request's created_at; replays are no-ops", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    const kp = keypair();
    const t = now();
    const old = sign(kp, { content: "old", created_at: t - 100 });
    await c.publish(old);
    const vanish = sign(kp, { kind: 62, content: "", tags: [["relay", RELAY]], created_at: t - 50 });
    expect((await c.publish(vanish))[2]).toBe(true);
    expect(await stores.events.getById(old.id)).toBeUndefined();

    const later = sign(kp, { content: "after vanishing", created_at: t });
    expect((await c.publish(later))[2]).toBe(true);
    // anyone can fetch the stored kind 62 and send it again
    const replay = await c.publish(vanish);
    expect(replay[2]).toBe(true);
    expect(replay[3]).toMatch(/^duplicate:/);
    expect(await stores.events.getById(later.id)).toBeDefined();
  });

  test("events newer than the request (e.g. imported) survive it", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    const kp = keypair();
    const t = now();
    const newer = sign(kp, { content: "newer", created_at: t });
    await c.publish(newer);
    await c.publish(sign(kp, { kind: 62, content: "", tags: [["relay", RELAY]], created_at: t - 10 }));
    expect(await stores.events.getById(newer.id)).toBeDefined();
  });
});

describe("NIP-29 replay protection", () => {
  test("replaying an old moderation event does not re-apply it", async () => {
    const { connect, relay } = await setup();
    const c = connect();
    const admin = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("g1") }));
    const makePublic = sign(admin, { kind: 9002, tags: h("g1", [["public"]]), created_at: now() - 5 });
    expect((await c.publish(makePublic))[2]).toBe(true);
    expect((await c.publish(sign(admin, { kind: 9002, tags: h("g1", [["private"]]) })))[2]).toBe(true);
    expect((await relay.groups.list()).find((g) => g.id === "g1")?.private).toBe(true);

    expect((await c.publish(makePublic))[3]).toMatch(/^duplicate:/);
    expect((await relay.groups.list()).find((g) => g.id === "g1")?.private).toBe(true);
  });

  test("old group control events are refused (late publication)", async () => {
    const { connect, relay } = await setup();
    const c = connect();
    const admin = keypair();
    const bob = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("g2") }));
    const res = await c.publish(sign(admin, { kind: 9000, tags: h("g2", [["p", bob.pk]]), created_at: now() - 3600 }));
    expect(res[3]).toMatch(/^invalid: group control events must be recent/);
    expect((await relay.groups.get("g2"))?.members).toBe(1);
  });

  test("events naming several groups are refused", async () => {
    const { connect } = await setup();
    const c = connect();
    const admin = keypair();
    const outsider = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("open") }));
    await c.publish(sign(admin, { kind: 9007, tags: h("closed", [["closed"]]) }));
    const res = await c.publish(sign(outsider, { kind: 9, tags: [["h", "open"], ["h", "closed"]] }));
    expect(res[2]).toBe(false);
    expect(res[3]).toMatch(/^invalid: an event may only reference one group/);
  });

  test("delete-group leaves no orphaned events behind", async () => {
    const { connect, stores } = await setup();
    const c = connect();
    const admin = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("gone") }));
    await c.publish(sign(admin, { kind: 9, tags: h("gone") }));
    expect((await c.publish(sign(admin, { kind: 9008, tags: h("gone") })))[2]).toBe(true);
    expect(await stores.events.query([{ "#h": ["gone"] }])).toEqual([]);
  });

  test("metadata stays monotonic across a restart", async () => {
    const env = await setup();
    const c = env.connect();
    const admin = keypair();
    await c.publish(sign(admin, { kind: 9007, tags: h("meta", [["name", "Before"]]) }));
    // a second engine over the same stores = restart (in-memory lastMetaAt is lost)
    const relay2 = await createRelay(env.deps);
    const sock = { sent: [] as unknown[][], send(d: string) { this.sent.push(JSON.parse(d)); }, close() {}, bufferedAmount: () => 0 };
    const handle = relay2.handleConnection(sock, { ip: "1.2.3.4" });
    const edit = sign(admin, { kind: 9002, tags: h("meta", [["name", "After"]]) });
    handle.onMessage(JSON.stringify(["EVENT", edit]));
    for (let i = 0; i < 50 && !sock.sent.some((m) => m[0] === "OK"); i++) await tick();
    const [meta] = await env.stores.events.query([{ kinds: [39000], "#d": ["meta"] }]);
    expect(meta.tags).toContainEqual(["name", "After"]);
  });
});

describe("read-side limits and visibility", () => {
  test("maxSubscriptions holds under a burst of concurrent REQs", async () => {
    const { connect } = await setup({ settings: { limits: { maxSubscriptions: 2 } } });
    const c = connect();
    for (let i = 0; i < 6; i++) c.send(["REQ", `s${i}`, { kinds: [1] }]);
    for (let i = 0; i < 100 && c.socket.sent.filter((m) => m[0] === "EOSE" || m[0] === "CLOSED").length < 6; i++) await tick();
    expect(c.socket.of("EOSE").length).toBe(2);
    expect(c.socket.of("CLOSED").length).toBe(4);
  });

  test("COUNT respects plugin visibility hooks", async () => {
    const { connect, hooks } = await setup();
    hooks.onVisibility((e) => e.content !== "secret", "test");
    const c = connect();
    const kp = keypair();
    await c.publish(sign(kp, { content: "secret" }));
    await c.publish(sign(kp, { content: "public" }));
    c.send(["COUNT", "c", { kinds: [1], authors: [kp.pk] }]);
    expect(await c.socket.waitFor((m) => m[0] === "COUNT")).toEqual(["COUNT", "c", { count: 1 }]);
  });

  async function negNeed(c: ReturnType<Awaited<ReturnType<typeof setup>>["connect"]>, filter: object): Promise<string[] | string> {
    const s = new NegentropyStorage();
    s.seal();
    const client = new Negentropy(s, 0);
    const need = new Set<string>();
    let msg: string | null = client.initiate();
    let first = true;
    while (msg !== null) {
      const from = c.socket.sent.length;
      c.send(first ? ["NEG-OPEN", "n", filter, msg] : ["NEG-MSG", "n", msg]);
      first = false;
      const resp = await c.socket.waitFor((m) => (m[0] === "NEG-MSG" || m[0] === "NEG-ERR") && m[1] === "n", 2000, from);
      if (resp[0] === "NEG-ERR") return resp[2] as string;
      const r = client.reconcile(resp[2] as string);
      r.need.forEach((x) => need.add(x));
      msg = r.output;
    }
    return [...need];
  }

  test("NEG-OPEN honours query hooks that match nothing or rewrite into several filters", async () => {
    const { connect, hooks } = await setup();
    const c = connect();
    const kp = keypair();
    const a = sign(kp, { kind: 1 });
    const b = sign(kp, { kind: 7 });
    await c.publish(a);
    await c.publish(b);
    const off = hooks.onQuery(() => [], "test");
    expect(await negNeed(c, { authors: [kp.pk] })).toEqual([]);
    off();
    hooks.onQuery(() => [{ kinds: [1], authors: [kp.pk] }, { kinds: [7], authors: [kp.pk] }], "test");
    expect(((await negNeed(c, { authors: [kp.pk] })) as string[]).sort()).toEqual([a.id, b.id].sort());
  });

  test("NEG-OPEN hides events filtered by plugin visibility hooks", async () => {
    const { connect, hooks } = await setup();
    hooks.onVisibility((e) => e.content !== "secret", "test");
    const c = connect();
    const kp = keypair();
    const visible = sign(kp, { content: "public" });
    await c.publish(sign(kp, { content: "secret" }));
    await c.publish(visible);
    expect(await negNeed(c, { authors: [kp.pk] })).toEqual([visible.id]);
  });
});

describe("misc", () => {
  test("ipKey collapses IPv4-mapped forms and IPv6 /64s", () => {
    expect(ipKey("::ffff:1.2.3.4")).toBe(ipKey("1.2.3.4"));
    expect(ipKey("2001:db8:1:2::1")).toBe(ipKey("2001:db8:1:2:ffff::9"));
    expect(ipKey("2001:db8:1:2::1")).not.toBe(ipKey("2001:db8:1:3::1"));
  });

  test("live NIP-50 matching handles quoted phrases and extensions like storage", () => {
    const ev = sign(keypair(), { content: "Say hello world, https://x.example" });
    expect(matchFilter({ search: '"hello world"' }, ev)).toBe(true);
    expect(matchFilter({ search: '"world hello"' }, ev)).toBe(false);
    expect(matchFilter({ search: "hello language:en" }, ev)).toBe(true);
  });

  test("NIP-11 omits created_at_lower_limit when disabled", async () => {
    const { relay } = await setup({ settings: { limits: { createdAtLowerSec: 0 } } });
    const doc = (await (await relay.http.request("/", { headers: { Accept: "application/nostr+json" } })).json()) as { limitation: Record<string, unknown> };
    expect("created_at_lower_limit" in doc.limitation).toBe(false);
  });

  test("/invite/redeem refuses oversized bodies before buffering them", async () => {
    const { relay } = await setup({ settings: { access: { mode: "invite" } } });
    const big = "x".repeat(10_000);
    expect((await relay.http.request("/invite/redeem", { method: "POST", body: big })).status).toBe(413);
    const stream = new ReadableStream({
      start(ctrl) {
        for (let i = 0; i < 10; i++) ctrl.enqueue(new TextEncoder().encode("y".repeat(1000)));
        ctrl.close();
      },
    });
    const res = await relay.http.request("/invite/redeem", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
  });
});
