import { describe, expect, test } from "bun:test";
import { createTestStores } from "@beamhop/storage";
import { MAX_PUSH_FAILURES, PUSH_CONCURRENCY, PushService, type PushSender } from "../src/services/push";
import { RoleService } from "../src/services/roles";
import { migrateAdmin } from "../src/db";
import { createHarness } from "./fakes";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const endpoint = (i: number) => `https://updates.push.services.mozilla.com/wpush/v2/dev${i}`;

async function subscribeDevices(h: Harness, n: number, topics = ["alerts", "reports"]) {
  for (let i = 0; i < n; i++) {
    const sub = { endpoint: endpoint(i), keys: { p256dh: "k", auth: "a" } };
    expect((await h.asKey(h.owner, "/push/subscribe", { method: "POST", body: { subscription: sub, topics } })).status).toBe(200);
  }
}

/** A PushService on the harness's stores, for the delivery mechanics the API doesn't expose. */
async function service(h: Harness, sender: PushSender) {
  const push = new PushService(h.deps, new RoleService(h.stores.users, [h.owner.pk]), () => Math.floor(h.clock.now / 1000));
  push.sender = sender;
  await push.init();
  return push;
}

describe("alert pushes", () => {
  test("a burst of one alert becomes one push per device plus one digest", async () => {
    const sent: { title: string }[] = [];
    let inflight = 0;
    let maxInflight = 0;
    const h = await createHarness({
      apiOptions: { alertPushIntervalMs: 80 },
      pushSender: async (_sub, payload) => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await Bun.sleep(5);
        inflight--;
        sent.push(JSON.parse(payload));
      },
    });
    await subscribeDevices(h, 3);
    for (let i = 0; i < 200; i++) h.bus.emit("alert", { level: "warning", title: "Content flagged by word filter", message: `m${i}` });
    await Bun.sleep(40);
    expect(sent.map((p) => p.title)).toEqual(Array(3).fill("Content flagged by word filter"));
    await Bun.sleep(120);
    expect(sent.slice(3).map((p) => p.title)).toEqual(Array(3).fill("199 more: Content flagged by word filter"));
    expect(maxInflight).toBeLessThanOrEqual(PUSH_CONCURRENCY);
  });

  test("a different alert still goes out right away", async () => {
    const titles: string[] = [];
    const h = await createHarness({ apiOptions: { alertPushIntervalMs: 10_000 }, pushSender: async (_s, p) => void titles.push(JSON.parse(p).title) });
    await subscribeDevices(h, 1);
    h.bus.emit("alert", { level: "warning", title: "A", message: "1" });
    h.bus.emit("alert", { level: "warning", title: "A", message: "2" });
    h.bus.emit("alert", { level: "critical", title: "A", message: "3" });
    h.bus.emit("alert", { level: "warning", title: "B", message: "4" });
    await Bun.sleep(30);
    expect(titles.sort()).toEqual(["A", "A", "B"]);
  });
});

describe("push delivery", () => {
  test("at most PUSH_CONCURRENCY deliveries run at once", async () => {
    const h = await createHarness();
    await subscribeDevices(h, 20);
    let inflight = 0;
    let max = 0;
    const push = await service(h, async () => {
      inflight++;
      max = Math.max(max, inflight);
      await Bun.sleep(5);
      inflight--;
    });
    const counts = await Promise.all([push.notify("alerts", { title: "t", body: "b" }), push.notify("alerts", { title: "t", body: "b" })]);
    expect(counts).toEqual([20, 20]);
    expect(max).toBe(PUSH_CONCURRENCY);
  });

  test("a delivery that hangs is given up after the timeout", async () => {
    const h = await createHarness();
    await subscribeDevices(h, 2);
    const push = await service(h, (sub) => (sub.endpoint === endpoint(0) ? new Promise(() => {}) : Promise.resolve()));
    push.timeoutMs = 30;
    const started = performance.now();
    expect(await push.notify("alerts", { title: "t", body: "b" })).toBe(1);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test("notifications started together share one subscription read", async () => {
    const h = await createHarness();
    await subscribeDevices(h, 2);
    const push = await service(h, async () => {});
    const db = h.stores.db;
    const all = db.all.bind(db);
    let reads = 0;
    db.all = ((sql: string, params?: unknown[]) => {
      if (/FROM admin_push_subscriptions p/.test(sql)) reads++;
      return all(sql, params);
    }) as typeof db.all;
    await Promise.all(Array.from({ length: 10 }, () => push.notify("alerts", { title: "t", body: "b" })));
    expect(reads).toBe(1);
    await push.notify("alerts", { title: "t", body: "b" });
    expect(reads).toBe(2);
  });

  test(`a device refused ${MAX_PUSH_FAILURES} times in a row with 400/401/403 is dropped; a success resets the count`, async () => {
    const h = await createHarness();
    await subscribeDevices(h, 2);
    let fail = true;
    const push = await service(h, async (sub) => {
      if (sub.endpoint === endpoint(0) && fail) throw Object.assign(new Error("forbidden"), { statusCode: 403 });
    });
    const devices = async () => (await h.stores.db.all<{ endpoint: string }>("SELECT endpoint FROM admin_push_subscriptions ORDER BY endpoint")).map((r) => r.endpoint);
    for (let i = 0; i < MAX_PUSH_FAILURES - 1; i++) await push.notify("alerts", { title: "t", body: "b" });
    fail = false;
    await push.notify("alerts", { title: "t", body: "b" });
    fail = true;
    for (let i = 0; i < MAX_PUSH_FAILURES - 1; i++) await push.notify("alerts", { title: "t", body: "b" });
    expect(await devices()).toEqual([endpoint(0), endpoint(1)]);
    await push.notify("alerts", { title: "t", body: "b" });
    expect(await devices()).toEqual([endpoint(1)]);
  });

  test("other failures (timeouts, 5xx) never drop a device", async () => {
    const h = await createHarness();
    await subscribeDevices(h, 1);
    const push = await service(h, async () => {
      throw Object.assign(new Error("unavailable"), { statusCode: 503 });
    });
    for (let i = 0; i < MAX_PUSH_FAILURES + 2; i++) await push.notify("alerts", { title: "t", body: "b" });
    expect((await h.stores.db.all("SELECT endpoint FROM admin_push_subscriptions")).length).toBe(1);
  });
});

describe("VAPID keys", () => {
  test("instances starting together on an empty database agree on one key pair", async () => {
    const stores = await createTestStores();
    await migrateAdmin(stores.db);
    const h = await createHarness({ db: stores.db });
    const deps = { ...h.deps, stores: { ...h.deps.stores, db: stores.db, kv: stores.kv } };
    const roles = new RoleService(h.stores.users, []);
    await stores.kv.delete("admin", "vapid");
    const services = Array.from({ length: 5 }, () => new PushService(deps, roles, () => 1));
    await Promise.all(services.map((s) => s.init()));
    const keys = new Set(services.map((s) => s.publicKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe((await stores.kv.get<{ publicKey: string }>("admin", "vapid"))!.publicKey);
    await stores.db.close();
  });
});
