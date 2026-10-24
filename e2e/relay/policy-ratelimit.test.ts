/**
 * Event / REQ rate limits configured at runtime. trustProxy lets every test use its own client address, so the
 * per-address buckets of different tests never interact.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient, newUser } from "../harness/client";
import { connectAs, connectAuthed, nextSub, note, ownerApi, patchSettings, uniqueIp } from "./policy-helpers";

let relay: Relay;
/** eventsPerMinute used by this file: refills one token per second per author, 4/s per address */
const EPM = 60;
beforeAll(async () => {
  relay = await startRelay({ overrides: { server: { trustProxy: true } } });
  await patchSettings(relay, { limits: { eventsPerMinute: EPM } });
});
afterAll(() => relay?.stop());

/** Publishes `n` notes as fast as possible and returns their OK messages. */
async function burst(c: RelayClient, sk: Uint8Array, n: number): Promise<{ ok: boolean; message: string }[]> {
  const evs = Array.from({ length: n }, () => note(sk));
  for (const ev of evs) c.send(["EVENT", ev]);
  const out: { ok: boolean; message: string }[] = [];
  for (const ev of evs) {
    const m = await c.waitFor((f) => f[0] === "OK" && f[1] === ev.id);
    out.push({ ok: m[2] as boolean, message: m[3] as string });
  }
  return out;
}

describe("event rate limits", () => {
  test("per-author bucket: eventsPerMinute events pass, the next is rate-limited, and it recovers after the refill", async () => {
    const u = newUser();
    const c = await connectAs(relay, uniqueIp());
    // (+5: the bucket refills 1/s, so one extra may slip through on a slow run)
    const res = await burst(c, u.sk, EPM + 5);
    expect(res.slice(0, EPM).every((r) => r.ok)).toBe(true);
    expect(res.at(-1)).toEqual({ ok: false, message: "rate-limited: slow down, too many events" });
    await Bun.sleep(1100);
    expect((await c.publish(note(u.sk))).ok).toBe(true);
    c.close();
  });

  test("rate limits are separate per author (another author on the same address is unaffected)", async () => {
    const ip = uniqueIp();
    const a = newUser();
    const b = newUser();
    const c = await connectAs(relay, ip);
    const res = await burst(c, a.sk, EPM + 5);
    expect(res.at(-1)!.ok).toBe(false);
    expect((await c.publish(note(b.sk))).ok).toBe(true);
    c.close();
  });

  test("per-address bucket: many authors from one address hit 4x eventsPerMinute; another address is unaffected", async () => {
    const ip = uniqueIp();
    const c = await connectAs(relay, ip);
    // 5 authors x 50 events (each under its own per-author limit) = 250 > 4 x EPM; the address bucket refills at
    // 4/s, so a few extra may pass while the burst is processed, but not all of them
    const users = Array.from({ length: 5 }, newUser);
    const results = (await Promise.all(users.map((u) => burst(c, u.sk, 50)))).flat();
    const accepted = results.filter((r) => r.ok).length;
    expect(accepted).toBeGreaterThanOrEqual(4 * EPM);
    expect(accepted).toBeLessThan(250);
    expect(results.filter((r) => !r.ok).every((r) => r.message === "rate-limited: slow down, too many events")).toBe(true);
    const other = await connectAs(relay, uniqueIp());
    expect((await other.publish(note(newUser().sk))).ok).toBe(true);
    c.close();
    other.close();
  });

  test("authenticated author shares one bucket across addresses; unauthenticated replays elsewhere don't drain it", async () => {
    const u = newUser();
    const c1 = await connectAuthed(relay, u.sk, uniqueIp());
    const c2 = await connectAuthed(relay, u.sk, uniqueIp());
    const res = await burst(c1, u.sk, EPM);
    expect(res.every((r) => r.ok)).toBe(true);
    const r = (await burst(c2, u.sk, 3)).at(-1)!;
    expect(r.message).toStartWith("rate-limited:");
    // the same author's events sent by an anonymous connection elsewhere use a per-address bucket
    const anon = await connectAs(relay, uniqueIp());
    expect((await anon.publish(note(u.sk))).ok).toBe(true);
    for (const c of [c1, c2, anon]) c.close();
  });

  test("duplicates are answered without charging the bucket", async () => {
    const u = newUser();
    const c = await connectAs(relay, uniqueIp());
    const ev = note(u.sk);
    expect((await c.publish(ev)).ok).toBe(true);
    for (let i = 0; i < EPM + 5; i++) {
      c.send(["EVENT", ev]);
    }
    for (let i = 0; i < EPM + 5; i++) {
      const m = await c.waitFor((f) => f[0] === "OK" && f[1] === ev.id);
      expect(m[2]).toBe(true);
      expect(String(m[3])).toStartWith("duplicate:");
    }
    const res = await burst(c, u.sk, EPM - 1);
    expect(res.every((r) => r.ok)).toBe(true);
    c.close();
  });

  test("relay staff are exempt from event rate limits", async () => {
    const c = await connectAs(relay, uniqueIp());
    const res = await burst(c, relay.owner.sk, EPM + 10);
    expect(res.every((r) => r.ok)).toBe(true);
    c.close();
  });

  test("a per-user rateLimit override raises that user's limit", async () => {
    const u = newUser();
    await ownerApi(relay, "PATCH", `/users/${u.pubkey}`, { rateLimit: { eventsPerMinute: EPM * 2 } });
    const c = await connectAs(relay, uniqueIp());
    const res = await burst(c, u.sk, EPM * 2 + 5);
    expect(res.slice(0, EPM * 2).every((r) => r.ok)).toBe(true);
    expect(res.at(-1)!.message).toStartWith("rate-limited:");
    c.close();
  });

  test("lowering eventsPerMinute at runtime takes effect on a live connection", async () => {
    const u = newUser();
    const c = await connectAs(relay, uniqueIp());
    await patchSettings(relay, { limits: { eventsPerMinute: 3 } });
    try {
      const res = await burst(c, u.sk, 4);
      expect(res.map((r) => r.ok)).toEqual([true, true, true, false]);
    } finally {
      await patchSettings(relay, { limits: { eventsPerMinute: EPM } });
    }
    c.close();
  });
});

describe("REQ rate limits and subscription caps", () => {
  test("reqPerMinute: REQs beyond the limit are CLOSED rate-limited; recovers after refill", async () => {
    await patchSettings(relay, { limits: { reqPerMinute: 60 } });
    try {
      const c = await connectAs(relay, uniqueIp());
      // one-minute burst of 60 (each REQ closed after EOSE so maxSubscriptions isn't the limit), then 1/s refill
      const filter = { ids: ["0".repeat(64)] };
      for (let i = 0; i < 60; i++) expect((await c.query(nextSub("r"), [filter])).closed).toBeUndefined();
      // (a token may refill while the 60 run on a slow machine)
      let refused: string | undefined;
      for (let i = 0; i < 5 && !refused; i++) refused = (await c.query(nextSub("r"), [filter])).closed;
      expect(refused).toBe("rate-limited: too many requests");
      await Bun.sleep(1100);
      expect((await c.query(nextSub("r"), [filter])).closed).toBeUndefined();
      c.close();
    } finally {
      await patchSettings(relay, { limits: { reqPerMinute: 240 } });
    }
  });

  test("maxSubscriptions: an extra open subscription is CLOSED; closing one frees a slot", async () => {
    await patchSettings(relay, { limits: { maxSubscriptions: 2 } });
    try {
      const c = await connectAs(relay, uniqueIp());
      const a = nextSub();
      await c.query(a, [{ kinds: [1], limit: 0 }], false);
      await c.query(nextSub(), [{ kinds: [1], limit: 0 }], false);
      const third = await c.query(nextSub(), [{ kinds: [1], limit: 0 }], false);
      expect(third.closed).toBe("rate-limited: too many subscriptions (max 2)");
      c.send(["CLOSE", a]);
      const fourth = await c.query(nextSub(), [{ kinds: [1], limit: 0 }], false);
      expect(fourth.closed).toBeUndefined();
      c.close();
    } finally {
      await patchSettings(relay, { limits: { maxSubscriptions: 30 } });
    }
  });
});
