import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Negentropy, NegentropyStorage } from "../src/nips/nip77/negentropy";
import { QUERY_MS_PER_MINUTE } from "../src/protocol/read-limits";
import { keypair, setup } from "./fakes";

const now = performance.now;
let offset = 0;
beforeAll(() => {
  performance.now = () => now.call(performance) + offset;
});
afterEach(() => {
  offset = 0;
});
afterAll(() => {
  performance.now = now;
});

const initNeg = () => {
  const s = new NegentropyStorage();
  s.seal();
  return new Negentropy(s, 0).initiate();
};

/** A relay whose event store queries appear to take `ms` each (a moved clock, no actual waiting). */
async function slowStore(ms: number, opts: Parameters<typeof setup>[0] = {}) {
  const env = await setup(opts);
  const ev = env.stores.events;
  const query = ev.query.bind(ev);
  const count = ev.count.bind(ev);
  const ids = ev.queryIdsForSync.bind(ev);
  ev.query = async (...a) => ((offset += ms), query(...a));
  ev.count = async (...a) => ((offset += ms), count(...a));
  ev.queryIdsForSync = async (...a) => ((offset += ms), ids(...a));
  return env;
}

describe("query-time budgets for plain reads", () => {
  test("an address whose queries used up its budget is refused until it refills; others aren't", async () => {
    const { connect } = await slowStore(QUERY_MS_PER_MINUTE.ipBurst + 1_000);
    const heavy = connect("10.0.0.1");
    expect((await heavy.req("a", { kinds: [1] })).end[0]).toBe("EOSE");
    expect((await heavy.req("b", { kinds: [1] })).end).toEqual(["CLOSED", "b", "rate-limited: too many expensive queries, slow down"]);
    const from = heavy.socket.sent.length;
    heavy.send(["COUNT", "c", { kinds: [1] }]);
    expect(await heavy.socket.waitFor((m) => m[1] === "c", 1000, from)).toEqual(["CLOSED", "c", "rate-limited: too many expensive queries, slow down"]);
    heavy.send(["NEG-OPEN", "n", { kinds: [1] }, initNeg()]);
    expect(await heavy.socket.waitFor((m) => m[1] === "n", 1000, from)).toEqual(["NEG-ERR", "n", "rate-limited: too many expensive queries, slow down"]);
    // live-only subscriptions run no query and aren't refused
    expect((await heavy.req("live", { kinds: [1], limit: 0 })).end[0]).toBe("EOSE");
    expect((await connect("10.0.0.2").req("a", { kinds: [1] })).end[0]).toBe("EOSE");
  });

  test("the relay-wide budget refuses everyone once spent", async () => {
    const { connect } = await slowStore(QUERY_MS_PER_MINUTE.allBurst + 1_000);
    expect((await connect("10.0.0.1").req("a", { kinds: [1] })).end[0]).toBe("EOSE");
    expect((await connect("10.0.0.2").req("a", { kinds: [1] })).end).toEqual(["CLOSED", "a", "rate-limited: relay is busy, try again shortly"]);
  });

  test("staff are exempt", async () => {
    const owner = keypair();
    const { connect } = await slowStore(QUERY_MS_PER_MINUTE.allBurst + 1_000, { config: { admin: { owners: [owner.pk] } } });
    const c = connect("10.0.0.1");
    await c.auth(owner);
    expect((await c.req("a", { kinds: [1] })).end[0]).toBe("EOSE");
    expect((await c.req("b", { kinds: [1] })).end[0]).toBe("EOSE");
  });
});
