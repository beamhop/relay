import { describe, expect, test } from "bun:test";
import { Relay } from "../../src/relay.ts";
import { nip01 } from "../../src/plugins/nip01.ts";
import { nip22 } from "../../src/plugins/nip22.ts";
import { FakeConnection } from "../helpers.ts";
import { signEvent } from "../signer.ts";
import { PRIV } from "../fixtures.ts";

function relayWith(opts: { lower?: number; upper?: number }, now = 10_000) {
  const relay = new Relay({ name: "t", now: () => now });
  relay.use(nip01(relay)).use(nip22(opts));
  relay.install();
  return relay;
}

async function send(relay: Relay, createdAt: number) {
  const conn = new FakeConnection();
  relay.addConnection(conn);
  const e = signEvent({ kind: 1, created_at: createdAt, content: "x" }, PRIV);
  await relay.handleMessage(conn, JSON.stringify(["EVENT", e]));
  return conn.ofType("OK")[0]!;
}

describe("NIP-22 created_at limits", () => {
  test("with no bounds, any timestamp is accepted", async () => {
    const relay = relayWith({});
    expect((await send(relay, 0))[2]).toBe(true);
    expect((await send(relay, 999_999))[2]).toBe(true);
  });

  test("rejects events too far in the past", async () => {
    const relay = relayWith({ lower: 100 }, 10_000);
    const ok = await send(relay, 9899); // 101s old
    expect(ok[2]).toBe(false);
    expect(ok[3]).toContain("past");
  });

  test("accepts events at the lower edge", async () => {
    const relay = relayWith({ lower: 100 }, 10_000);
    expect((await send(relay, 9900))[2]).toBe(true); // exactly 100s old
  });

  test("rejects events too far in the future", async () => {
    const relay = relayWith({ upper: 60 }, 10_000);
    const ok = await send(relay, 10_061);
    expect(ok[2]).toBe(false);
    expect(ok[3]).toContain("future");
  });

  test("accepts events at the upper edge", async () => {
    const relay = relayWith({ upper: 60 }, 10_000);
    expect((await send(relay, 10_060))[2]).toBe(true);
  });

  test("falls back to wall clock when config.now is unset", async () => {
    const relay = new Relay({ name: "t" });
    relay.use(nip01(relay)).use(nip22({ upper: 3600 }));
    relay.install();
    const conn = new FakeConnection();
    relay.addConnection(conn);
    const nowSec = Math.floor(Date.now() / 1000);
    const e = signEvent({ kind: 1, created_at: nowSec, content: "x" }, PRIV);
    await relay.handleMessage(conn, JSON.stringify(["EVENT", e]));
    expect(conn.ofType("OK")[0]![2]).toBe(true);
  });
});
