import { describe, expect, test } from "bun:test";
import { MESSAGES_PER_MINUTE } from "../src/relay";
import { keypair, setup, sign } from "./fakes";

/** Drains a connection's message bucket with cheap live-only REQs (a few extra for the refill meanwhile). */
const drain = (send: (m: unknown[]) => void) => {
  for (let i = 0; i < MESSAGES_PER_MINUTE + 50; i++) send(["REQ", "d", { kinds: [1], limit: 0 }]);
};
const LIMITED = "rate-limited: too many messages, slow down";

describe("inbound message limit", () => {
  test("messages over the limit are refused before they are parsed, with their peeked ids", async () => {
    const { connect } = await setup();
    const c = connect();
    drain(c.send);
    const ev = sign(keypair(), { content: "x".repeat(50_000) });
    c.socket.clear();
    c.send(["EVENT", ev]);
    // malformed: parsing it would answer "invalid:"
    c.send(["REQ", "r", { kinds: "1" }]);
    c.send(["NEG-OPEN", "n", { kinds: [1] }, "61"]);
    c.handle.onMessage("garbage that can't be matched to anything");
    expect(c.socket.sent).toEqual([
      ["OK", ev.id, false, LIMITED],
      ["CLOSED", "r", LIMITED],
      ["NEG-ERR", "n", LIMITED],
    ]);
    // small CLOSEs still get through
    c.send(["CLOSE", "d"]);
    expect(c.socket.sent.length).toBe(3);
  });

  test("a large CLOSE isn't exempt", async () => {
    const { connect, relay } = await setup();
    const c = connect();
    await c.req("keep", { kinds: [1], limit: 0 });
    drain(c.send);
    const subs = relay.connections()[0].subscriptions;
    c.handle.onMessage(JSON.stringify(["CLOSE", "keep", "y".repeat(5000)]));
    expect(relay.connections()[0].subscriptions).toBe(subs);
    c.send(["CLOSE", "keep"]);
    expect(relay.connections()[0].subscriptions).toBe(subs - 1);
  });

  test("a connection that keeps exceeding the limit is closed", async () => {
    const { connect, relay } = await setup();
    const c = connect();
    drain(c.send);
    for (let i = 0; i < 4 * MESSAGES_PER_MINUTE && !c.socket.closed; i++) c.send(["REQ", "r", { kinds: [1] }]);
    expect(c.socket.closed?.code).toBe(1008);
    expect(relay.connections().length).toBe(0);
  });
});
