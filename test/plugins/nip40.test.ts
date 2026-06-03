import { describe, expect, test } from "bun:test";
import { Relay } from "../../src/relay.ts";
import { nip01 } from "../../src/plugins/nip01.ts";
import {
  expirationOf,
  isExpired,
  nip40,
  sweepExpired,
} from "../../src/plugins/nip40.ts";
import { FakeConnection } from "../helpers.ts";
import { signEvent } from "../signer.ts";
import { PRIV } from "../fixtures.ts";

function newRelay(nowSeconds: number, sweepIntervalMs = 0) {
  let clock = nowSeconds;
  const relay = new Relay({ name: "t", now: () => clock });
  relay.use(nip01(relay)).use(nip40({ sweepIntervalMs }));
  relay.install();
  return { relay, setNow: (t: number) => (clock = t) };
}

function expiring(at: number, created = 1000) {
  return signEvent(
    { kind: 1, created_at: created, tags: [["expiration", String(at)]], content: "x" },
    PRIV,
  );
}

describe("NIP-40 helpers", () => {
  test("expirationOf reads the tag, ignores invalid", () => {
    expect(expirationOf(expiring(5000))).toBe(5000);
    const bad = signEvent(
      { kind: 1, created_at: 1, tags: [["expiration", "soon"]], content: "" },
      PRIV,
    );
    expect(expirationOf(bad)).toBeUndefined();
  });

  test("isExpired is exclusive at the boundary", () => {
    const e = expiring(5000);
    expect(isExpired(e, 4999)).toBe(false);
    expect(isExpired(e, 5000)).toBe(false); // still valid at exactly exp
    expect(isExpired(e, 5001)).toBe(true);
  });
});

describe("NIP-40 acceptance", () => {
  test("rejects an already-expired event with OK false", async () => {
    const { relay } = newRelay(10000);
    const conn = new FakeConnection();
    relay.addConnection(conn);
    await relay.handleMessage(conn, JSON.stringify(["EVENT", expiring(5000)]));
    const ok = conn.ofType("OK")[0]!;
    expect(ok[2]).toBe(false);
    expect(ok[3]).toContain("expired");
    expect(relay.store.size()).toBe(0);
  });

  test("accepts a not-yet-expired event", async () => {
    const { relay } = newRelay(1000);
    const conn = new FakeConnection();
    relay.addConnection(conn);
    const e = expiring(5000);
    await relay.handleMessage(conn, JSON.stringify(["EVENT", e]));
    expect(conn.ofType("OK")[0]![2]).toBe(true);
    expect(relay.store.getById(e.id)).toBeDefined();
  });
});

describe("NIP-40 visibility", () => {
  test("a stored event that later expires is hidden from REQ", async () => {
    const { relay, setNow } = newRelay(1000);
    const author = new FakeConnection();
    relay.addConnection(author);
    const e = expiring(5000);
    await relay.handleMessage(author, JSON.stringify(["EVENT", e]));

    // Before expiry: visible.
    const a = new FakeConnection();
    relay.addConnection(a);
    await relay.handleMessage(a, JSON.stringify(["REQ", "s", { kinds: [1] }]));
    expect(a.ofType("EVENT")).toHaveLength(1);

    // After expiry: hidden, but still in the store until swept.
    setNow(6000);
    const b = new FakeConnection();
    relay.addConnection(b);
    await relay.handleMessage(b, JSON.stringify(["REQ", "s2", { kinds: [1] }]));
    expect(b.ofType("EVENT")).toHaveLength(0);
    expect(b.ofType("EOSE")).toHaveLength(1);
    expect(relay.store.getById(e.id)).toBeDefined();
  });

  test("an expired event is not broadcast live", async () => {
    const { relay, setNow } = newRelay(1000);
    const sub = new FakeConnection();
    relay.addConnection(sub);
    await relay.handleMessage(sub, JSON.stringify(["REQ", "s", { kinds: [1] }]));

    setNow(6000);
    const author = new FakeConnection();
    relay.addConnection(author);
    // Already expired on arrival -> rejected, definitely not broadcast.
    await relay.handleMessage(author, JSON.stringify(["EVENT", expiring(5000)]));
    expect(sub.ofType("EVENT")).toHaveLength(0);
  });
});

describe("NIP-40 sweep", () => {
  test("sweepExpired removes only expired events", async () => {
    const { relay } = newRelay(1000);
    const conn = new FakeConnection();
    relay.addConnection(conn);
    await relay.handleMessage(conn, JSON.stringify(["EVENT", expiring(5000)]));
    await relay.handleMessage(conn, JSON.stringify(["EVENT", expiring(9000)]));
    expect(relay.store.size()).toBe(2);

    const ctx = {
      store: relay.store,
      broadcast: () => {},
      connections: () => relay.connections(),
      isVisible: (e: import("../../src/types.ts").NostrEvent) => relay.isVisible(e),
      config: relay.config,
    };
    expect(sweepExpired(ctx, 6000)).toBe(1); // only the 5000 one
    expect(relay.store.size()).toBe(1);
  });

  test("background sweep timer fires and removes expired events", async () => {
    // now() reports 6000, an event expiring at 5000 is already expired but we
    // insert it directly into the store (bypassing the acceptance validator)
    // to verify the *timer* sweeps it.
    let clock = 6000;
    const relay = new Relay({ name: "t", now: () => clock });
    relay.use(nip01(relay)).use(nip40({ sweepIntervalMs: 5 }));
    relay.install();
    relay.store.add(
      signEvent(
        { kind: 1, created_at: 1000, tags: [["expiration", "5000"]], content: "x" },
        PRIV,
      ),
    );
    expect(relay.store.size()).toBe(1);
    await new Promise((r) => setTimeout(r, 25));
    expect(relay.store.size()).toBe(0);
  });
});
