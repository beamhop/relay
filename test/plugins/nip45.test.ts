import { describe, expect, test } from "bun:test";
import { Relay } from "../../src/relay.ts";
import { nip01 } from "../../src/plugins/nip01.ts";
import { nip40 } from "../../src/plugins/nip40.ts";
import { nip45 } from "../../src/plugins/nip45.ts";
import { FakeConnection } from "../helpers.ts";
import { signEvent } from "../signer.ts";
import { PRIV } from "../fixtures.ts";

function newRelay(now = 1000) {
  const relay = new Relay({ name: "t", now: () => now });
  relay.use(nip01(relay)).use(nip40()).use(nip45());
  relay.install();
  return relay;
}

async function count(relay: Relay, ...filters: object[]): Promise<number> {
  const conn = new FakeConnection();
  relay.addConnection(conn);
  await relay.handleMessage(conn, JSON.stringify(["COUNT", "c", ...filters]));
  const msg = conn.ofType("COUNT")[0]!;
  return (msg[2] as { count: number }).count;
}

describe("NIP-45 COUNT", () => {
  test("counts matching events", async () => {
    const relay = newRelay();
    relay.store.add(signEvent({ kind: 1, created_at: 1, content: "a" }, PRIV));
    relay.store.add(signEvent({ kind: 1, created_at: 2, content: "b" }, PRIV));
    relay.store.add(signEvent({ kind: 7, created_at: 3, content: "+" }, PRIV));

    expect(await count(relay, {})).toBe(3);
    expect(await count(relay, { kinds: [1] })).toBe(2);
    expect(await count(relay, { kinds: [99] })).toBe(0);
  });

  test("ignores per-filter limit", async () => {
    const relay = newRelay();
    relay.store.add(signEvent({ kind: 1, created_at: 1, content: "a" }, PRIV));
    relay.store.add(signEvent({ kind: 1, created_at: 2, content: "b" }, PRIV));
    expect(await count(relay, { limit: 1 })).toBe(2);
  });

  test("does not count events hidden by visibility (NIP-40)", async () => {
    let now = 1000;
    const relay = new Relay({ name: "t", now: () => now });
    relay.use(nip01(relay)).use(nip40()).use(nip45());
    relay.install();
    relay.store.add(
      signEvent(
        { kind: 1, created_at: 1, tags: [["expiration", "5000"]], content: "x" },
        PRIV,
      ),
    );
    expect(await count(relay, {})).toBe(1);
    now = 6000; // event has expired
    expect(await count(relay, {})).toBe(0);
  });

  test("rejects a bad subscription id", async () => {
    const relay = newRelay();
    const conn = new FakeConnection();
    relay.addConnection(conn);
    await relay.handleMessage(conn, JSON.stringify(["COUNT", ""]));
    expect(conn.ofType("NOTICE")[0]![1]).toContain("subscription id");
  });
});
