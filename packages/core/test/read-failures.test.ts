import { describe, expect, test } from "bun:test";
import { SubscriptionIndex } from "../src/subscriptions/index";
import { keypair, setup } from "./fakes";

/** Reads that fail internally are still answered (NIP-01: CLOSED, NIP-77: NEG-ERR), never left hanging. */
describe("read failures", () => {
  const failingLookup = async () => {
    const env = await setup();
    const c = env.connect();
    const kp = keypair();
    expect((await c.auth(kp))[2]).toBe(true);
    env.stores.users.get = async () => {
      throw new Error("db down");
    };
    env.bus.emit("user.updated", { pubkey: kp.pk } as never); // drop the cached record
    return c;
  };

  test("REQ is CLOSED when the user lookup for read limits fails", async () => {
    const c = await failingLookup();
    const { end } = await c.req("s", { kinds: [1] });
    expect(end).toEqual(["CLOSED", "s", "error: internal error"]);
  });

  test("COUNT is CLOSED when the user lookup for read limits fails", async () => {
    const c = await failingLookup();
    const from = c.socket.sent.length;
    c.send(["COUNT", "q", { kinds: [1] }]);
    const r = await c.socket.waitFor((m) => (m[0] === "COUNT" || m[0] === "CLOSED") && m[1] === "q", 1000, from);
    expect(r).toEqual(["CLOSED", "q", "error: internal error"]);
  });

  test("NEG-OPEN gets NEG-ERR when the user lookup for read limits fails", async () => {
    const c = await failingLookup();
    const from = c.socket.sent.length;
    c.send(["NEG-OPEN", "n", { kinds: [1] }, "61"]);
    const r = await c.socket.waitFor((m) => (m[0] === "NEG-MSG" || m[0] === "NEG-ERR") && m[1] === "n", 1000, from);
    expect(r).toEqual(["NEG-ERR", "n", "error: internal error"]);
  });

  test("a REQ handler that throws answers CLOSED and leaves no subscription behind", async () => {
    const { connect, relay } = await setup();
    const c = connect();
    const orig = SubscriptionIndex.prototype.add;
    SubscriptionIndex.prototype.add = function (this: SubscriptionIndex, sub) {
      orig.call(this, sub);
      throw new Error("index broken");
    };
    try {
      const { end } = await c.req("s", { kinds: [1] });
      expect(end).toEqual(["CLOSED", "s", "error: internal error"]);
    } finally {
      SubscriptionIndex.prototype.add = orig;
    }
    expect(relay.connections()[0].subscriptions).toBe(0);
  });
});
