import { describe, expect, test } from "bun:test";
import { Relay } from "../../src/relay.ts";
import { nip01 } from "../../src/plugins/nip01.ts";
import {
  committedTarget,
  countLeadingZeroBits,
  nip13,
} from "../../src/plugins/nip13.ts";
import { FakeConnection } from "../helpers.ts";
import { signEvent } from "../signer.ts";
import { PRIV } from "../fixtures.ts";

/** Sign events with increasing nonce until the id has >= `bits` leading zeros. */
function mineEvent(bits: number, extraTags: string[][] = []) {
  for (let nonce = 0; nonce < 1_000_000; nonce++) {
    const tags = [["nonce", String(nonce), String(bits)], ...extraTags];
    const e = signEvent({ kind: 1, created_at: 1000, tags, content: "pow" }, PRIV);
    if (countLeadingZeroBits(e.id) >= bits) return e;
  }
  throw new Error("could not mine in budget");
}

describe("NIP-13 helpers", () => {
  test("countLeadingZeroBits", () => {
    expect(countLeadingZeroBits("0".repeat(64))).toBe(256);
    expect(countLeadingZeroBits("f" + "0".repeat(63))).toBe(0);
    expect(countLeadingZeroBits("1" + "0".repeat(63))).toBe(3); // 0001
    expect(countLeadingZeroBits("00ff")).toBe(8);
    expect(countLeadingZeroBits("08")).toBe(4); // 0000 1000
    expect(countLeadingZeroBits("2")).toBe(2); // 0010
  });

  test("committedTarget reads the nonce tag's third element", () => {
    const e = signEvent(
      { kind: 1, created_at: 1, tags: [["nonce", "42", "16"]], content: "" },
      PRIV,
    );
    expect(committedTarget(e)).toBe(16);
    const none = signEvent({ kind: 1, created_at: 1, content: "" }, PRIV);
    expect(committedTarget(none)).toBeUndefined();
  });
});

describe("NIP-13 acceptance", () => {
  function relayWith(minPow: number) {
    const relay = new Relay({ name: "t" });
    relay.use(nip01(relay)).use(nip13({ minPow }));
    relay.install();
    return relay;
  }

  test("with PoW disabled, any event passes", async () => {
    const relay = relayWith(0);
    const conn = new FakeConnection();
    relay.addConnection(conn);
    const e = signEvent({ kind: 1, created_at: 1000, content: "x" }, PRIV);
    await relay.handleMessage(conn, JSON.stringify(["EVENT", e]));
    expect(conn.ofType("OK")[0]![2]).toBe(true);
  });

  test("rejects an event below the required difficulty", async () => {
    const relay = relayWith(8);
    const conn = new FakeConnection();
    relay.addConnection(conn);
    // A plain event almost certainly has < 8 leading zero bits.
    const e = signEvent({ kind: 1, created_at: 1000, content: "no-pow" }, PRIV);
    if (countLeadingZeroBits(e.id) >= 8) return; // astronomically unlikely; skip
    await relay.handleMessage(conn, JSON.stringify(["EVENT", e]));
    const ok = conn.ofType("OK")[0]!;
    expect(ok[2]).toBe(false);
    expect(ok[3]).toContain("pow");
  });

  test("accepts an event meeting the difficulty", async () => {
    const relay = relayWith(8);
    const conn = new FakeConnection();
    relay.addConnection(conn);
    const e = mineEvent(8);
    await relay.handleMessage(conn, JSON.stringify(["EVENT", e]));
    expect(conn.ofType("OK")[0]![2]).toBe(true);
  });

  test("rejects when the committed target is below the minimum", async () => {
    const relay = relayWith(8);
    const conn = new FakeConnection();
    relay.addConnection(conn);
    // Mine enough actual work for 8 bits but commit a target of 4.
    let mined;
    for (let nonce = 0; nonce < 1_000_000; nonce++) {
      const e = signEvent(
        { kind: 1, created_at: 1000, tags: [["nonce", String(nonce), "4"]], content: "x" },
        PRIV,
      );
      if (countLeadingZeroBits(e.id) >= 8) {
        mined = e;
        break;
      }
    }
    await relay.handleMessage(conn, JSON.stringify(["EVENT", mined!]));
    const ok = conn.ofType("OK")[0]!;
    expect(ok[2]).toBe(false);
    expect(ok[3]).toContain("committed target");
  });
});
