import { describe, expect, test } from "bun:test";
import type { Filter, NostrEvent } from "@beamhop/sdk";
import { BACKPRESSURE } from "../src/protocol/handlers";
import { Gate, MAX_QUERIES_PER_CONN, ReadLimits, REQ_BURST, RESULT_BYTES, SEARCH_MAX_LIMIT, SEARCH_PER_MINUTE } from "../src/protocol/read-limits";
import { RateLimiter } from "../src/util/rate-limit";
import { keypair, setup, sign, tick } from "./fakes";

describe("RateLimiter burst and charge", () => {
  test("burst caps the bucket below a minute's allowance and refills at the per-minute rate", () => {
    let t = 0;
    const r = new RateLimiter(() => t);
    let ok = 0;
    for (let i = 0; i < 500; i++) if (r.take("k", 240, 1, 60)) ok++;
    expect(ok).toBe(60);
    t += 15_000; // a quarter minute → 60 tokens, capped at the burst
    ok = 0;
    for (let i = 0; i < 500; i++) if (r.take("k", 240, 1, 60)) ok++;
    expect(ok).toBe(60);
  });

  test("charge() puts a bucket in debt so cost-0 checks fail until it refills", () => {
    let t = 0;
    const r = new RateLimiter(() => t);
    expect(r.take("ms", 3000, 0, 1500)).toBe(true);
    r.charge("ms", 3000, 2500, 1500); // 1500 - 2500 = -1000
    expect(r.take("ms", 3000, 0, 1500)).toBe(false);
    t += 20_000; // +1000
    expect(r.take("ms", 3000, 0, 1500)).toBe(true);
    r.charge("ms", 3000, 1e9, 1500); // debt is bounded at one minute
    t += 60_000;
    expect(r.take("ms", 3000, 0, 1500)).toBe(true);
  });
});

describe("Gate", () => {
  test("limits concurrency, hands slots over in order, honours abort and the wait-queue bound", async () => {
    const g = new Gate(2, 2);
    expect(await g.acquire()).toBe("ok");
    expect(await g.acquire()).toBe("ok");
    const order: string[] = [];
    const ac = new AbortController();
    const a = g.acquire().then((r) => order.push(`a:${r}`));
    const b = g.acquire(ac.signal).then((r) => order.push(`b:${r}`));
    expect(await g.acquire()).toBe("busy");
    ac.abort();
    await b;
    const c = g.acquire().then((r) => order.push(`c:${r}`));
    g.release();
    await a;
    g.release();
    await c;
    expect(order).toEqual(["b:aborted", "a:ok", "c:ok"]);
    expect(g.inUse).toBe(2);
    g.release();
    g.release();
    expect(g.inUse).toBe(0);
  });
});

describe("ReadLimits result budget", () => {
  test("a lone result always fits; more is refused beyond the connection / address budgets", () => {
    const r = new ReadLimits();
    const big = RESULT_BYTES.conn + 1;
    expect(r.reserve("ip1", 0, big)).toBe(true); // nothing else held
    expect(r.reserve("ip1", big, 10)).toBe(false); // same connection over budget
    expect(r.reserve("ip1", 0, RESULT_BYTES.ip)).toBe(false); // address over budget
    expect(r.reserve("ip2", 0, 1000)).toBe(true);
    r.release("ip1", big);
    expect(r.reserve("ip1", 0, RESULT_BYTES.ip)).toBe(true);
    r.release("ip1", RESULT_BYTES.ip);
    r.release("ip2", 1000);
    expect(r.resultBytes).toBe(0);
    expect(r.resultBytesByIp.size).toBe(0);
  });
});

describe("REQ throttling", () => {
  test("a connection can't have more than REQ_BURST requests admitted at once", async () => {
    const { connect } = await setup({ settings: { limits: { maxSubscriptions: 500 } } });
    const c = connect();
    for (let i = 0; i < REQ_BURST + 5; i++) c.send(["REQ", `b${i}`, { kinds: [1], limit: 0 }]);
    await c.socket.waitFor((m) => m[1] === `b${REQ_BURST + 4}` && (m[0] === "EOSE" || m[0] === "CLOSED"));
    await tick(20);
    expect(c.socket.of("EOSE").length).toBe(REQ_BURST);
    expect(c.socket.of("CLOSED").filter((m) => String(m[2]).startsWith("rate-limited: too many requests")).length).toBe(5);
  });

  test("search has its own small burst and its limit is clamped", async () => {
    const { connect, stores } = await setup();
    const kp = keypair();
    const t = Math.floor(Date.now() / 1000);
    for (let i = 0; i < SEARCH_MAX_LIMIT + 20; i++) await stores.events.save(sign(kp, { content: `hello world ${i}`, created_at: t - i }));
    const c = connect();
    const first = await c.req("s0", { search: "hello", limit: 500 });
    expect(first.end[0]).toBe("EOSE");
    expect(first.events.length).toBe(SEARCH_MAX_LIMIT);
    for (let i = 1; i <= SEARCH_PER_MINUTE.connBurst; i++) c.send(["REQ", `s${i}`, { search: "hello", limit: 1 }]);
    const last = await c.socket.waitFor((m) => m[1] === `s${SEARCH_PER_MINUTE.connBurst}` && (m[0] === "EOSE" || m[0] === "CLOSED"));
    expect(last[0]).toBe("CLOSED");
    expect(String(last[2])).toMatch(/^rate-limited: too many searches/);
    // plain REQs are unaffected
    expect((await c.req("p", { kinds: [1], limit: 1 })).end[0]).toBe("EOSE");
  });

  test("stored queries run at most MAX_QUERIES_PER_CONN at a time per connection; the rest wait", async () => {
    const { connect, stores } = await setup();
    const orig = stores.events.query.bind(stores.events);
    let running = 0;
    let peak = 0;
    let gate!: () => void;
    const open = new Promise<void>((r) => (gate = r));
    stores.events.query = async (filters: Filter[], opts?: { maxLimit?: number }) => {
      running++;
      peak = Math.max(peak, running);
      await open;
      running--;
      return orig(filters, opts);
    };
    const c = connect();
    for (let i = 0; i < 6; i++) c.send(["REQ", `q${i}`, { kinds: [1] }]);
    await tick(30);
    expect(peak).toBe(MAX_QUERIES_PER_CONN);
    gate();
    for (let i = 0; i < 6; i++) await c.socket.waitFor((m) => m[0] === "EOSE" && m[1] === `q${i}`);
    expect(peak).toBe(MAX_QUERIES_PER_CONN);
  });

  test("materialized results are budgeted per address: a second big result is refused while the first streams", async () => {
    const { connect, stores } = await setup();
    const kp = keypair();
    const huge: NostrEvent = { ...sign(kp, { content: "x" }), content: "x".repeat(RESULT_BYTES.ip - (1 << 20)) };
    stores.events.query = async () => [huge];
    const saved = BACKPRESSURE.drainTimeoutMs;
    BACKPRESSURE.drainTimeoutMs = 5_000;
    try {
      const a = connect("9.9.9.9");
      a.socket.buffered = 64 << 20; // slow reader: its result stays materialized
      a.send(["REQ", "big", { kinds: [1] }]);
      await tick(30);
      const b = connect("9.9.9.9");
      const res = await b.req("big2", { kinds: [1] });
      expect(res.end[0]).toBe("CLOSED");
      expect(String(res.end[2])).toMatch(/^rate-limited: too many results in flight/);
      // another address is unaffected
      const other = connect("8.8.8.8");
      expect((await other.req("ok", { kinds: [1] })).end[0]).toBe("EOSE");
      a.socket.buffered = 0;
      await a.socket.waitFor((m) => m[0] === "EOSE" && m[1] === "big", 3000);
      // budget released after streaming
      expect((await b.req("big3", { kinds: [1] })).end[0]).toBe("EOSE");
    } finally {
      BACKPRESSURE.drainTimeoutMs = saved;
    }
  });
});
