import { describe, expect, test } from "bun:test";
import { Relay } from "../src/relay.ts";
import type { NostrPlugin } from "../src/plugin.ts";
import { FakeConnection } from "./helpers.ts";

describe("plugin registration & dispatch", () => {
  test("onInstall runs once per plugin", () => {
    let installs = 0;
    const plugin: NostrPlugin = { name: "x", onInstall: () => void installs++ };
    const relay = new Relay().use(plugin);
    relay.install();
    relay.install(); // idempotent
    expect(installs).toBe(1);
  });

  test("cannot add plugins after install", () => {
    const relay = new Relay();
    relay.install();
    expect(() => relay.use({ name: "late" })).toThrow("after the relay");
  });

  test("dispatch stops at the first handler that returns true", async () => {
    const order: string[] = [];
    const a: NostrPlugin = {
      name: "a",
      messageHandlers: {
        PING: () => {
          order.push("a");
          return true;
        },
      },
    };
    const b: NostrPlugin = {
      name: "b",
      messageHandlers: {
        PING: () => {
          order.push("b");
          return true;
        },
      },
    };
    const relay = new Relay().use(a).use(b);
    relay.install();
    const conn = new FakeConnection();
    await relay.handleMessage(conn, JSON.stringify(["PING"]));
    expect(order).toEqual(["a"]);
  });

  test("dispatch falls through when a handler does not claim the message", async () => {
    const order: string[] = [];
    const a: NostrPlugin = {
      name: "a",
      messageHandlers: { PING: () => void order.push("a") },
    };
    const b: NostrPlugin = {
      name: "b",
      messageHandlers: {
        PING: () => {
          order.push("b");
          return true;
        },
      },
    };
    const relay = new Relay().use(a).use(b);
    relay.install();
    await relay.handleMessage(new FakeConnection(), JSON.stringify(["PING"]));
    expect(order).toEqual(["a", "b"]);
  });

  test("unknown verb yields a NOTICE", async () => {
    const relay = new Relay();
    relay.install();
    const conn = new FakeConnection();
    await relay.handleMessage(conn, JSON.stringify(["WAT"]));
    expect(conn.messages[0]).toEqual(["NOTICE", expect.stringContaining("unsupported")]);
  });

  test("malformed JSON yields a NOTICE", async () => {
    const relay = new Relay();
    relay.install();
    const conn = new FakeConnection();
    await relay.handleMessage(conn, "{not json");
    expect(conn.messages[0]).toEqual(["NOTICE", expect.stringContaining("malformed")]);
  });

  test("non-array message yields a NOTICE", async () => {
    const relay = new Relay();
    relay.install();
    const conn = new FakeConnection();
    await relay.handleMessage(conn, JSON.stringify({ hello: 1 }));
    expect(conn.messages[0]).toEqual(["NOTICE", expect.stringContaining("invalid")]);
  });

  test("validators short-circuit on the first failure", async () => {
    const calls: string[] = [];
    const relay = new Relay()
      .use({
        name: "v1",
        eventValidators: [
          () => {
            calls.push("v1");
            return { ok: false, reason: "blocked: nope" };
          },
        ],
      })
      .use({
        name: "v2",
        eventValidators: [
          () => {
            calls.push("v2");
            return { ok: true };
          },
        ],
      });
    relay.install();
    const verdict = await relay.validateEvent({} as never);
    expect(verdict).toEqual({ ok: false, reason: "blocked: nope" });
    expect(calls).toEqual(["v1"]);
  });

  test("info merges supported_nips and plugin relayInfo", () => {
    const relay = new Relay({ name: "test-relay" })
      .use({ name: "p1", supportedNips: [1], relayInfo: () => ({ foo: "bar" }) })
      .use({ name: "p2", supportedNips: [11, 1] });
    relay.install();
    const info = relay.info;
    expect(info.name).toBe("test-relay");
    expect(info.supported_nips).toEqual([1, 11]);
    expect(info.foo).toBe("bar");
  });

  test("PluginContext exposes the store, config, and connections()", async () => {
    let captured: import("../src/plugin.ts").PluginContext | undefined;
    const relay = new Relay({ name: "ctx" }).use({
      name: "cap",
      messageHandlers: {
        PROBE: (_conn, _msg, ctx) => {
          captured = ctx;
          return true;
        },
      },
    });
    relay.install();
    const conn = new FakeConnection();
    relay.addConnection(conn);
    await relay.handleMessage(conn, JSON.stringify(["PROBE"]));
    expect(captured!.config.name).toBe("ctx");
    expect(captured!.store).toBe(relay.store);
    expect([...captured!.connections()]).toContain(conn);
  });

  test("lifecycle hooks fire on connect/disconnect", () => {
    const log: string[] = [];
    const relay = new Relay().use({
      name: "life",
      onConnect: () => log.push("connect"),
      onDisconnect: () => log.push("disconnect"),
    });
    relay.install();
    const conn = new FakeConnection();
    relay.addConnection(conn);
    relay.removeConnection(conn);
    expect(log).toEqual(["connect", "disconnect"]);
  });
});
