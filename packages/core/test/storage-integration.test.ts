import { describe, expect, test } from "bun:test";
import { ConfigSchema, EventBus, HookRegistry, type NostrEvent } from "@beamhop/sdk";
import { createSettingsService, createTestStores, silentLogger } from "@beamhop/storage";
import { createRelay } from "../src";
import { FakeSocket, keypair, now, PUBLIC_URL, RELAY_SECRET_KEY, sign } from "./fakes";

/** Smoke test against the real SQL storage package to catch contract drift. */
describe("integration with @beamhop/storage", () => {
  test("publish, query, delete, groups, count", async () => {
    const stores = await createTestStores();
    const bus = new EventBus();
    const settings = await createSettingsService(stores, bus);
    const config = ConfigSchema.parse({ server: { publicUrl: PUBLIC_URL }, relaySecretKey: RELAY_SECRET_KEY });
    const relay = await createRelay({ config, stores, settings, bus, hooks: new HookRegistry(), logger: silentLogger });
    const socket = new FakeSocket();
    const conn = relay.handleConnection(socket, { ip: "1.1.1.1" });
    const send = (m: unknown[]) => conn.onMessage(JSON.stringify(m));
    const publish = async (e: NostrEvent) => {
      const from = socket.sent.length;
      send(["EVENT", e]);
      return socket.waitFor((m) => m[0] === "OK" && m[1] === e.id, 2000, from);
    };
    const kp = keypair();
    const a = sign(kp, { content: "hello world", created_at: now() - 5 });
    const b = sign(kp, { content: "second", tags: [["t", "x"]] });
    expect((await publish(a))[2]).toBe(true);
    expect((await publish(b))[2]).toBe(true);
    expect((await publish(a))[3]).toMatch(/^duplicate:/);

    send(["REQ", "s", { authors: [kp.pk] }]);
    await socket.waitFor((m) => m[0] === "EOSE" && m[1] === "s");
    expect(socket.of("EVENT").map((m) => (m[2] as NostrEvent).id)).toEqual([b.id, a.id]);

    expect((await publish(sign(kp, { kind: 5, tags: [["e", a.id]] })))[2]).toBe(true);
    expect(await stores.events.getById(a.id)).toBeUndefined();

    expect((await publish(sign(kp, { kind: 9007, tags: [["h", "grp"]] })))[2]).toBe(true);
    expect((await relay.groups.get("grp"))?.memberList[0]?.pubkey).toBe(kp.pk);

    send(["COUNT", "c", { authors: [kp.pk], kinds: [1] }]);
    expect(await socket.waitFor((m) => m[0] === "COUNT")).toEqual(["COUNT", "c", { count: 1 }]);
    await relay.stop();
  });
});
