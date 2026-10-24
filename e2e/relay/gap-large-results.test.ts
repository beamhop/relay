/**
 * Large stored result sets: limit capping at the default max_limit (500) / default_limit (100), paging through
 * thousands of events with `until`, COUNT on big sets, per-filter caps across several filters and big payloads
 * streamed byte-exact. Uses the default limits (only rate limits relaxed).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Event } from "nostr-tools";
import type { Relay } from "../harness/relay";
import { RelayClient, newUser, sha256, sign } from "../harness/client";
import { now, startCoreRelay } from "./core-helpers";

const TOTAL = 1200;
let relay: Relay;
let c: RelayClient;
const author = newUser();
const evs: Event[] = []; // newest first
const base = now() - 10_000;

beforeAll(async () => {
  relay = await startCoreRelay();
  c = await RelayClient.connect(relay.ws);
  // distinct timestamps so the expected newest-first order is unambiguous
  for (let i = 0; i < TOTAL; i++) evs.push(sign(author.sk, { kind: i % 2 ? 1 : 7, content: `bulk ${i}`, created_at: base + i }));
  // seed over 4 extra connections: one connection may send 1200 messages a minute (not configurable)
  const seeders = await Promise.all(Array.from({ length: 4 }, () => RelayClient.connect(relay.ws)));
  for (let i = 0; i < TOTAL; i += 100) {
    const oks = await Promise.all(evs.slice(i, i + 100).map((e, j) => seeders[j % 4].publish(e)));
    if (!oks.every((o) => o.ok)) throw new Error(`seed failed: ${JSON.stringify(oks.find((o) => !o.ok))}`);
  }
  for (const s of seeders) s.close();
  evs.reverse();
}, 60_000);
afterAll(async () => {
  c?.close();
  await relay?.stop();
});

const idsOf = (e: Event[]) => e.map((x) => x.id);

describe("limit capping", () => {
  test("NIP-11 advertises the defaults this file relies on", async () => {
    const doc = await (await fetch(relay.http, { headers: { Accept: "application/nostr+json" } })).json();
    expect(doc.limitation.max_limit).toBe(500);
    expect(doc.limitation.default_limit).toBe(100);
  });

  test("limit far above max_limit returns exactly the newest 500, in order, then EOSE", async () => {
    const { events, closed } = await c.query("big", [{ authors: [author.pubkey], limit: 100_000 }]);
    expect(closed).toBeUndefined();
    expect(idsOf(events)).toEqual(idsOf(evs.slice(0, 500)));
  });

  test("no limit applies default_limit (100)", async () => {
    const { events } = await c.query("dflt", [{ authors: [author.pubkey] }]);
    expect(idsOf(events)).toEqual(idsOf(evs.slice(0, 100)));
  });

  test("each filter is capped separately; results of several filters are merged without duplicates", async () => {
    const { events } = await c.query("multi", [
      { authors: [author.pubkey], kinds: [1], limit: 5000 },
      { authors: [author.pubkey], kinds: [7], limit: 5000 },
      { authors: [author.pubkey], limit: 5000 }, // overlaps both
    ]);
    const ids = idsOf(events);
    expect(new Set(ids).size).toBe(ids.length);
    const k1 = evs.filter((e) => e.kind === 1).slice(0, 500);
    const k7 = evs.filter((e) => e.kind === 7).slice(0, 500);
    for (const e of [...k1, ...k7, ...evs.slice(0, 500)]) expect(ids).toContain(e.id);
    expect(ids.length).toBe(new Set([...idsOf(k1), ...idsOf(k7), ...idsOf(evs.slice(0, 500))]).size);
  });

  test("COUNT is not capped by max_limit", async () => {
    c.send(["COUNT", "cnt", { authors: [author.pubkey] }]);
    const m = await c.waitFor((f) => f[0] === "COUNT" && f[1] === "cnt");
    expect((m[2] as { count: number }).count).toBe(TOTAL);
    c.send(["COUNT", "cnt7", { authors: [author.pubkey], kinds: [7] }]);
    const m7 = await c.waitFor((f) => f[0] === "COUNT" && f[1] === "cnt7");
    expect((m7[2] as { count: number }).count).toBe(TOTAL / 2);
  });

  test("paging with until walks the whole set exactly once", async () => {
    const seen: string[] = [];
    let until: number | undefined;
    for (let page = 0; page < 10; page++) {
      const f: Record<string, unknown> = { authors: [author.pubkey], limit: 500 };
      if (until !== undefined) f.until = until;
      const { events } = await c.query(`page-${page}`, [f]);
      if (!events.length) break;
      seen.push(...idsOf(events));
      until = events[events.length - 1].created_at - 1;
    }
    expect(seen).toEqual(idsOf(evs));
  });

  test("ids filter with 1000 ids: capped at max_limit with an explicit limit, default_limit without one", async () => {
    const { events } = await c.query("ids", [{ ids: idsOf(evs.slice(0, 1000)), limit: 1000 }]);
    expect(idsOf(events)).toEqual(idsOf(evs.slice(0, 500)));
    // NIP-11 default_limit applies to ids filters too: clients fetching many ids at once must pass a limit
    const dflt = await c.query("ids-dflt", [{ ids: idsOf(evs.slice(0, 1000)) }]);
    expect(dflt.closed).toBeUndefined();
    expect(idsOf(dflt.events)).toEqual(idsOf(evs.slice(0, 100)));
  });
});

describe("big payloads", () => {
  test("400 events of ~60 KB each stream byte-exact in one REQ", async () => {
    const u = newUser();
    const t0 = now() - 5000;
    const big: Event[] = [];
    for (let i = 0; i < 400; i++) {
      const filler = sha256(`${i}`).repeat(930); // 59,520 chars, distinct per event
      big.push(sign(u.sk, { kind: 1, content: `${i}:${filler}`, created_at: t0 + i }));
    }
    const pub = await RelayClient.connect(relay.ws);
    for (let i = 0; i < big.length; i += 50) {
      const oks = await Promise.all(big.slice(i, i + 50).map((e) => pub.publish(e)));
      expect(oks.every((o) => o.ok)).toBe(true);
    }
    const { events, closed } = await pub.query("big-payload", [{ authors: [u.pubkey], limit: 500 }], true);
    expect(closed).toBeUndefined();
    expect(events.length).toBe(400);
    const byId = new Map(big.map((e) => [e.id, e]));
    for (const e of events) expect(e.content).toBe(byId.get(e.id)!.content);
    expect(idsOf(events)).toEqual(idsOf([...big].reverse()));
    pub.close();
  }, 60_000);
});
