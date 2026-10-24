/**
 * Many clients at once: fan-out exactness (every event to every matching subscription exactly once), concurrent
 * duplicate submissions, replaceable-event races and REQs racing live publishes. Rate limits and the per-IP
 * connection cap are off (all clients share 127.0.0.1).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Event } from "nostr-tools";
import type { Relay } from "../harness/relay";
import { RelayClient, newUser, sign } from "../harness/client";
import { clients, now, rand, startCoreRelay } from "./core-helpers";
import { api } from "./admin-helpers";

let relay: Relay;
const pool = clients();
beforeAll(async () => {
  relay = await startCoreRelay();
});
afterAll(async () => {
  pool.closeAll();
  await relay?.stop();
});

/** ids of EVENT frames for `sub` in the inbox (with repeats), without consuming them */
const received = (c: RelayClient, sub: string) => c.inbox.filter((m) => m[0] === "EVENT" && m[1] === sub).map((m) => (m[2] as Event).id);

async function until(pred: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(10);
  }
}

describe("fan-out", () => {
  test("50 clients subscribe and each publishes once: every client receives all 50 events exactly once", async () => {
    const N = 50;
    const tag = `fan-${rand()}`;
    const cs = await Promise.all(Array.from({ length: N }, () => pool.connect(relay.ws)));
    for (const c of cs) c.send(["REQ", "all", { "#t": [tag] }]);
    await Promise.all(cs.map((c) => c.waitFor((m) => m[0] === "EOSE" && m[1] === "all", 10_000)));
    const events = cs.map((_, i) => sign(newUser().sk, { kind: 1, content: `fan ${i}`, tags: [["t", tag]] }));
    const oks = await Promise.all(cs.map((c, i) => c.publish(events[i])));
    expect(oks.every((o) => o.ok && o.message === "")).toBe(true);
    const want = events.map((e) => e.id).sort();
    await until(() => cs.every((c) => received(c, "all").length >= N));
    await Bun.sleep(100); // let any duplicate arrive
    for (const c of cs) expect(received(c, "all").sort()).toEqual(want);
    for (const c of cs) c.send(["CLOSE", "all"]);
  }, 30_000);

  test("several overlapping subscriptions per connection each get a matching event once, non-matching never", async () => {
    const tag = `ov-${rand()}`;
    const author = newUser();
    const cs = await Promise.all(Array.from({ length: 20 }, () => pool.connect(relay.ws)));
    const subs: [string, Record<string, unknown>][] = [
      ["by-tag", { "#t": [tag] }],
      ["by-author", { authors: [author.pubkey] }],
      ["by-kind-tag", { kinds: [1], "#t": [tag] }],
      ["two-filters", { "#t": [tag] }],
      ["miss", { "#t": [`${tag}-other`] }],
    ];
    for (const c of cs) {
      for (const [id, f] of subs) c.send(id === "two-filters" ? ["REQ", id, f, { authors: [author.pubkey] }] : ["REQ", id, f]);
    }
    await Promise.all(cs.flatMap((c) => subs.map(([id]) => c.waitFor((m) => m[0] === "EOSE" && m[1] === id, 10_000))));
    const evs = Array.from({ length: 5 }, (_, i) => sign(author.sk, { kind: 1, content: `ov ${i}`, tags: [["t", tag]] }));
    const pub = await pool.connect(relay.ws);
    await Promise.all(evs.map((e) => pub.publish(e)));
    const want = evs.map((e) => e.id).sort();
    await until(() => cs.every((c) => subs.slice(0, 4).every(([id]) => received(c, id).length >= evs.length)));
    await Bun.sleep(100);
    for (const c of cs) {
      for (const [id] of subs.slice(0, 4)) expect(received(c, id).sort()).toEqual(want);
      expect(received(c, "miss")).toEqual([]);
    }
  }, 30_000);

  test("a REQ racing a stream of publishes sees each event at most once and every event published after its EOSE", async () => {
    const tag = `race-${rand()}`;
    const u = newUser();
    const pub = await pool.connect(relay.ws);
    const sub = await pool.connect(relay.ws);
    const all: Event[] = [];
    let stop = false;
    let eoseAt = -1;
    const pumping = (async () => {
      for (let i = 0; !stop && i < 400; i++) {
        const ev = sign(u.sk, { kind: 1, content: `race ${i}`, tags: [["t", tag]] });
        all.push(ev);
        await pub.publish(ev);
        if (eoseAt >= 0 && all.length - eoseAt > 40) stop = true;
      }
    })();
    await until(() => all.length >= 20);
    sub.send(["REQ", "r", { "#t": [tag], limit: 1000 }]);
    await sub.waitFor((m) => m[0] === "EOSE" && m[1] === "r", 10_000);
    eoseAt = all.length;
    await pumping;
    const afterEose = all.slice(eoseAt + 1).map((e) => e.id); // +1: the event in flight at EOSE may land either side
    await until(() => afterEose.every((id) => received(sub, "r").includes(id)));
    const got = received(sub, "r");
    expect(new Set(got).size).toBe(got.length);
  }, 30_000);
});

describe("concurrent writes", () => {
  test("the same event sent by 20 connections at once is stored once and delivered live once", async () => {
    const tag = `dup-${rand()}`;
    const watcher = await pool.connect(relay.ws);
    watcher.send(["REQ", "w", { "#t": [tag] }]);
    await watcher.waitFor((m) => m[0] === "EOSE" && m[1] === "w");
    const ev = sign(newUser().sk, { kind: 1, content: "same everywhere", tags: [["t", tag]] });
    const cs = await Promise.all(Array.from({ length: 20 }, () => pool.connect(relay.ws)));
    const oks = await Promise.all(cs.map((c) => c.publish(ev)));
    expect(oks.every((o) => o.ok)).toBe(true);
    // at least one fresh accept; any others are flagged as duplicates
    expect(oks.filter((o) => o.message === "").length).toBeGreaterThanOrEqual(1);
    for (const o of oks) expect(o.message === "" || o.message.startsWith("duplicate:")).toBe(true);
    await Bun.sleep(200);
    expect(received(watcher, "w")).toEqual([ev.id]);
    const { events } = await watcher.query("q", [{ "#t": [tag] }]);
    expect(events.map((e) => e.id)).toEqual([ev.id]);
  }, 20_000);

  test("20 concurrent versions of a replaceable event from different connections leave only the newest", async () => {
    const u = newUser();
    const base = now() - 100;
    const versions = Array.from({ length: 20 }, (_, i) => sign(u.sk, { kind: 0, content: JSON.stringify({ name: `v${i}` }), created_at: base + i }));
    const cs = await Promise.all(versions.map(() => pool.connect(relay.ws)));
    // newest first, so the race actually has to discard late older ones
    await Promise.all([...versions].reverse().map((v, i) => cs[i].publish(v)));
    const { events } = await cs[0].query("k0", [{ kinds: [0], authors: [u.pubkey] }]);
    expect(events.map((e) => e.id)).toEqual([versions[19].id]);
  }, 20_000);

  test("20 concurrent versions of an addressable event (same d tag) leave only the newest", async () => {
    const u = newUser();
    const d = `addr-${rand()}`;
    const base = now() - 100;
    const versions = Array.from({ length: 20 }, (_, i) => sign(u.sk, { kind: 30078, tags: [["d", d]], content: `v${i}`, created_at: base + i }));
    const cs = await Promise.all(versions.map(() => pool.connect(relay.ws)));
    await Promise.all(versions.map((v, i) => cs[i].publish(v)));
    const { events } = await cs[0].query("a", [{ kinds: [30078], authors: [u.pubkey], "#d": [d] }]);
    expect(events.map((e) => e.content)).toEqual(["v19"]);
  }, 20_000);

  test("connections opened and closed in bulk leave no live subscriptions behind", async () => {
    const tag = `churn-${rand()}`;
    const churner = newUser();
    const cs = await Promise.all(Array.from({ length: 40 }, () => RelayClient.connect(relay.ws)));
    await Promise.all(cs.map((c) => c.auth(churner.sk, relay.ws)));
    const open = await api(relay.http, relay.owner.sk, "GET", "/connections");
    expect(open.body.items.filter((c: any) => c.authedPubkeys.includes(churner.pubkey)).length).toBe(40);
    for (const c of cs) c.send(["REQ", "x", { "#t": [tag] }]);
    await Promise.all(cs.map((c) => c.waitFor((m) => m[0] === "EOSE")));
    for (const c of cs) c.close();
    await until(() => cs.every((c) => c.closed));
    const watcher = await pool.connect(relay.ws);
    watcher.send(["REQ", "w", { "#t": [tag] }]);
    await watcher.waitFor((m) => m[0] === "EOSE");
    const ev = sign(newUser().sk, { kind: 1, content: "after churn", tags: [["t", tag]] });
    await watcher.publish(ev);
    await watcher.waitFor((m) => m[0] === "EVENT" && m[1] === "w");
    await Bun.sleep(100);
    expect(cs.every((c) => !c.inbox.some((m) => m[0] === "EVENT"))).toBe(true);
    // the admin connection list agrees: none of the churned connections is still registered
    const list = await api(relay.http, relay.owner.sk, "GET", "/connections");
    expect(list.body.items.filter((c: any) => c.authedPubkeys.includes(churner.pubkey))).toEqual([]);
  }, 20_000);
});
