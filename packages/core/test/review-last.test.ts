import { describe, expect, test } from "bun:test";
import type { Filter } from "@beamhop/sdk";
import { Negentropy, NegentropyStorage } from "../src";
import { REPORTERS_KV_NAMESPACE } from "../src/pipeline/special-kinds";
import { eventually, keypair, now, setup, sign, tick } from "./fakes";

const initNeg = () => {
  const s = new NegentropyStorage();
  s.seal();
  return new Negentropy(s, 0).initiate();
};

describe("NIP-56 auto-ban counts distinct members", () => {
  test("one member filing many reports doesn't hide the others", async () => {
    const { connect, stores } = await setup({ settings: { moderation: { autoBanReportThreshold: 3 }, limits: { eventsPerMinute: 0 } } });
    const target = keypair();
    const [m1, m2, m3] = [keypair(), keypair(), keypair()];
    for (const m of [m1, m2, m3]) await stores.users.upsert(m.pk, { allowed: true });
    const t0 = now() - 100;
    await connect("10.0.0.2").publish(sign(m2, { kind: 1984, created_at: t0, tags: [["p", target.pk, "spam"]] }));
    await tick(20);
    const c1 = connect("10.0.0.1");
    for (let i = 0; i < 25; i++) {
      await c1.publish(sign(m1, { kind: 1984, created_at: t0 + 1 + i, tags: [["p", target.pk, "spam"], ["e", "a".repeat(63) + (i % 10)]], content: `n${i}` }));
    }
    await tick(50);
    const tracked = await stores.kv.get<string[]>(REPORTERS_KV_NAMESPACE, target.pk);
    expect(new Set(tracked)).toEqual(new Set([m1.pk, m2.pk]));
    await connect("10.0.0.3").publish(sign(m3, { kind: 1984, created_at: t0 + 50, tags: [["p", target.pk, "spam"]] }));
    await eventually(async () => (await stores.users.get(target.pk))?.status === "banned");
    // tracking is dropped once the target is banned
    expect(await stores.kv.get(REPORTERS_KV_NAMESPACE, target.pk)).toBeUndefined();
  });

  test("a p tag that isn't a pubkey is never tracked", async () => {
    const { connect, stores } = await setup({ settings: { moderation: { autoBanReportThreshold: 2 } } });
    const m = keypair();
    await stores.users.upsert(m.pk, { allowed: true });
    await connect().publish(sign(m, { kind: 1984, tags: [["p", "not-a-pubkey", "spam"]] }));
    await tick(20);
    expect(await stores.kv.list(REPORTERS_KV_NAMESPACE)).toEqual({});
  });
});

describe("NEG-OPEN preparation per address", () => {
  const slowSync = (stores: Awaited<ReturnType<typeof setup>>["stores"]) => {
    const orig = stores.events.queryIdsForSync.bind(stores.events);
    stores.events.queryIdsForSync = async (f: Filter) => {
      await tick(10);
      return orig(f);
    };
  };

  test("a client's two back-to-back syncs both open", async () => {
    const { connect, stores } = await setup();
    slowSync(stores);
    const c = connect();
    c.send(["NEG-OPEN", "a", { kinds: [1] }, initNeg()]);
    c.send(["NEG-OPEN", "b", { kinds: [7] }, initNeg()]);
    await tick(100);
    expect(c.socket.sent.filter((m) => m[0] === "NEG-ERR")).toEqual([]);
    expect(c.socket.sent.filter((m) => m[0] === "NEG-MSG").map((m) => m[1]).sort()).toEqual(["a", "b"]);
  });

  test("a third sync from the same address waits for a slot instead of being refused", async () => {
    const { connect, stores } = await setup();
    slowSync(stores);
    const a = connect("5.5.5.5");
    const b = connect("5.5.5.5");
    a.send(["NEG-OPEN", "a", { kinds: [1] }, initNeg()]);
    a.send(["NEG-OPEN", "b", { kinds: [1] }, initNeg()]);
    b.send(["NEG-OPEN", "a", { kinds: [1] }, initNeg()]);
    await tick(150);
    expect([...a.socket.sent, ...b.socket.sent].filter((m) => m[0] === "NEG-ERR")).toEqual([]);
    expect(b.socket.sent.some((m) => m[0] === "NEG-MSG")).toBe(true);
  });
});

describe("COUNT is bounded per connection", () => {
  test("one connection's COUNT burst doesn't hold every relay-wide query slot", async () => {
    const { connect, stores } = await setup();
    const origCount = stores.events.count.bind(stores.events);
    let running = 0;
    let peak = 0;
    stores.events.count = async (f: Filter[]) => {
      running++;
      peak = Math.max(peak, running);
      await tick(30);
      running--;
      return origCount(f);
    };
    const attacker = connect("6.6.6.6");
    for (let i = 0; i < 40; i++) attacker.send(["COUNT", `c${i}`, { kinds: [1] }]);
    await tick(1);
    const victim = connect("7.7.7.7");
    const t0 = Date.now();
    await victim.req("v", { kinds: [1], limit: 1 });
    expect(Date.now() - t0).toBeLessThan(150);
    expect(peak).toBeLessThanOrEqual(3);
    await eventually(() => attacker.socket.sent.filter((m) => m[0] === "COUNT").length === 40, 5000);
  }, 20_000);
});

describe("NIP-29 hardening", () => {
  test("a hidden closed group still answers 'not found' once the address is rate-limited", async () => {
    const { connect } = await setup({ settings: { groups: { creation: "anyone" } } });
    const admin = keypair();
    const ca = connect("8.8.8.8");
    await ca.publish(sign(admin, { kind: 9007, tags: [["h", "known1"]] }));
    await ca.publish(sign(admin, { kind: 9002, tags: [["h", "known1"], ["closed"]] }));
    await ca.publish(sign(admin, { kind: 9007, tags: [["h", "secret1"]] }));
    await ca.publish(sign(admin, { kind: 9002, tags: [["h", "secret1"], ["closed"], ["hidden"]] }));
    const probe = connect("9.9.9.9");
    for (let i = 0; i < 12; i++) await probe.publish(sign(keypair(), { kind: 9021, tags: [["h", "known1"], ["code", `wrong-${i}-xx`]] }));
    const hidden = await probe.publish(sign(keypair(), { kind: 9021, tags: [["h", "secret1"], ["code", "whatever123"]] }));
    const missing = await probe.publish(sign(keypair(), { kind: 9021, tags: [["h", "nosuch1"], ["code", "whatever123"]] }));
    expect(hidden[3]).toBe(missing[3]);
  });

  test("two joins racing for one code in an open group both succeed", async () => {
    const { connect } = await setup({ settings: { groups: { creation: "anyone" } } });
    const admin = keypair();
    const ca = connect("8.8.8.8");
    await ca.publish(sign(admin, { kind: 9007, tags: [["h", "open1"]] }));
    let r = await ca.publish(sign(admin, { kind: 9009, tags: [["h", "open1"], ["code", "shared-code-1"]] }));
    expect(r[2]).toBe(true);
    const [u1, u2] = [keypair(), keypair()];
    const [r1, r2] = await Promise.all([
      connect("1.1.1.1").publish(sign(u1, { kind: 9021, tags: [["h", "open1"], ["code", "shared-code-1"]] })),
      connect("2.2.2.2").publish(sign(u2, { kind: 9021, tags: [["h", "open1"], ["code", "shared-code-1"]] })),
    ]);
    expect([r1[2], r2[2]]).toEqual([true, true]);
  });
});
