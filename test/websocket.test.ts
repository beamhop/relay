import { describe, expect, test } from "bun:test";
import { createRelay, startFromEnv } from "../src/server.ts";
import { events } from "./fixtures.ts";

/** A stand-in for Bun's ServerWebSocket exposing only what the handler uses. */
class FakeWS {
  data: unknown;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
}

describe("relay.websocket handler", () => {
  test("open registers a connection, message dispatches, close cleans up", async () => {
    const relay = createRelay();
    relay.install();
    const ws = new FakeWS();
    // Drive the handler directly with a fake socket; the handler only touches
    // ws.data and ws.send, so a structural cast is sufficient here.
    const handler = relay.websocket as unknown as {
      open(ws: FakeWS): void;
      message(ws: FakeWS, message: string | Buffer): void;
      close(ws: FakeWS): void;
    };

    handler.open(ws);
    expect([...relay.connections()]).toHaveLength(1);

    // string frame
    handler.message(ws, JSON.stringify(["REQ", "s", { kinds: [1] }]));
    // binary frame (Buffer) -> toString()
    handler.message(ws, Buffer.from(JSON.stringify(["EVENT", events.note])));

    // allow the async EVENT handler to settle
    await Bun.sleep(10);
    expect(ws.sent.some((s) => s.includes("EOSE"))).toBe(true);
    expect(ws.sent.some((s) => s.includes('"OK"'))).toBe(true);

    handler.close(ws);
    expect([...relay.connections()]).toHaveLength(0);
  });
});

describe("startFromEnv", () => {
  test("starts an in-memory relay on an ephemeral port by default", () => {
    const server = startFromEnv({ PORT: "0" } as NodeJS.ProcessEnv);
    expect(server.port).toBeGreaterThan(0);
    server.stop(true);
  });

  test("uses SQLite when RELAY_DB is set", () => {
    const server = startFromEnv({ PORT: "0", RELAY_DB: ":memory:" } as NodeJS.ProcessEnv);
    expect(server.port).toBeGreaterThan(0);
    server.stop(true);
  });
});
