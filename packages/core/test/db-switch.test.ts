import { describe, expect, test } from "bun:test";
import { type BeamhopConfig, type BusEvents, ConfigSchema, type CoreDeps, EventBus, HookRegistry, type Logger } from "@beamhop/sdk";
import { createRelay } from "../src";
import { VANISH_KV_NAMESPACE } from "../src/pipeline/special-kinds";
import { DB_SWITCHING_REASON } from "../src/util/db-switching";
import { switchableTestStores } from "./db-switch-fake";
import { FakeSettings, FakeSocket, keypair, now, PUBLIC_URL, RELAY_SECRET_KEY, sign } from "./fakes";

function recordingLogger() {
  const lines: { level: string; msg: string }[] = [];
  const logger: Logger = {
    debug: (msg) => void lines.push({ level: "debug", msg }),
    info: (msg) => void lines.push({ level: "info", msg }),
    warn: (msg) => void lines.push({ level: "warn", msg }),
    error: (msg) => void lines.push({ level: "error", msg }),
    child: () => logger,
  };
  return { logger, lines };
}

async function relaySetup() {
  const { stores, sw } = await switchableTestStores();
  const config: BeamhopConfig = ConfigSchema.parse({ server: { publicUrl: PUBLIC_URL }, relaySecretKey: RELAY_SECRET_KEY });
  const bus = new EventBus();
  const { logger, lines } = recordingLogger();
  const deps: CoreDeps = { config, stores, settings: new FakeSettings(), hooks: new HookRegistry(), bus, logger };
  const relay = await createRelay(deps);
  const connect = () => {
    const socket = new FakeSocket();
    const handle = relay.handleConnection(socket, { ip: "1.2.3.4" });
    const publish = async (event: ReturnType<typeof sign>) => {
      const from = socket.sent.length;
      handle.onMessage(JSON.stringify(["EVENT", event]));
      return (await socket.waitFor((m) => m[0] === "OK" && m[1] === event.id, 4000, from)) as [string, string, boolean, string];
    };
    return { socket, publish };
  };
  return { relay, stores, sw, bus, lines, connect };
}

describe("database switch: writes paused", () => {
  test("EVENT is answered with a retryable OK false, counted as a rejection, without an error log or closing", async () => {
    const { connect, sw, bus, lines, stores } = await relaySetup();
    const rejected: BusEvents["event.rejected"][] = [];
    const alerts: BusEvents["alert"][] = [];
    bus.on("event.rejected", (e) => void rejected.push(e));
    bus.on("alert", (a) => void alerts.push(a));
    const c = connect();
    const ev = sign(keypair());

    sw.pause();
    expect(await c.publish(ev)).toEqual(["OK", ev.id, false, DB_SWITCHING_REASON]);
    expect(DB_SWITCHING_REASON).toBe("error: database switch in progress, try again shortly");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ code: "error", reason: DB_SWITCHING_REASON, source: "ws" });
    expect(alerts).toHaveLength(0);
    expect(lines.filter((l) => l.level === "error")).toEqual([]);
    expect(c.socket.closed).toBeNull();

    // a deletion (NIP-09) is a write too
    const del = sign(keypair(), { kind: 5, tags: [["e", ev.id]] });
    expect((await c.publish(del))[3]).toBe(DB_SWITCHING_REASON);

    sw.resume();
    expect(await c.publish(ev)).toEqual(["OK", ev.id, true, ""]);
    expect(await stores.events.getById(ev.id)).toBeDefined();
  });

  test("relay.publish (API imports, plugins) gets the same refusal", async () => {
    const { relay, sw } = await relaySetup();
    sw.pause();
    expect(await relay.publish(sign(keypair()), "import")).toEqual({ ok: false, message: DB_SWITCHING_REASON });
  });

  test("a request to vanish refused by the pause leaves no marker behind (its retry is not taken for a replay)", async () => {
    const { connect, sw, stores } = await relaySetup();
    const kp = keypair();
    const c = connect();
    const old = sign(kp, { created_at: now() - 100 });
    expect((await c.publish(old))[2]).toBe(true);
    const vanish = sign(kp, { kind: 62, tags: [["relay", "ALL_RELAYS"]] });
    sw.pause();
    expect((await c.publish(vanish))[3]).toBe(DB_SWITCHING_REASON);
    sw.resume();
    // not marked: an old event of the pubkey is still accepted (a replay of it is a duplicate)
    expect((await c.publish(old))[3]).toMatch(/^duplicate:/);
    expect(await stores.kv.get(VANISH_KV_NAMESPACE, kp.pk)).toBeUndefined();
    expect((await c.publish(vanish))[2]).toBe(true);
    expect(await stores.kv.get(VANISH_KV_NAMESPACE, kp.pk)).toBe(vanish.created_at);
  });
});

describe("database switch: rebind", () => {
  test("the relay registers an onSwapped hook that reloads vanish markers and group state; stop() removes it", async () => {
    const { relay, sw, stores, connect } = await relaySetup();
    expect(sw.swapped.map((h) => h.name)).toContain("core");
    // a marker present in the "new" database only shows up after the hook ran
    const kp = keypair();
    await stores.kv.set(VANISH_KV_NAMESPACE, kp.pk, now());
    await sw.runSwapped();
    const c = connect();
    expect((await c.publish(sign(kp, { created_at: now() - 10 })))[3]).toMatch(/requested to vanish/);
    await relay.stop();
    expect(sw.swapped.map((h) => h.name)).not.toContain("core");
  });
});
