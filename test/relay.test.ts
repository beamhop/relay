import { describe, expect, test } from "bun:test";
import { Relay, type RelayServer } from "../src/relay.ts";
import { createRelay } from "../src/server.ts";
import { FakeConnection } from "./helpers.ts";
import { events } from "./fixtures.ts";

describe("Relay composition & broadcast", () => {
  test("uses a custom store when provided", () => {
    const relay = createRelay();
    relay.install();
    relay.store.add(events.note);
    expect(relay.store.getById(events.note.id)).toBeDefined();
  });

  test("broadcast reaches only matching subscriptions", () => {
    const relay = createRelay();
    relay.install();
    const a = new FakeConnection();
    const b = new FakeConnection();
    relay.addConnection(a);
    relay.addConnection(b);
    a.addSub("s", [{ kinds: [1] }]); // matches note
    b.addSub("s", [{ kinds: [7] }]); // does not match note
    relay.broadcast(events.note);
    expect(a.ofType("EVENT")).toHaveLength(1);
    expect(b.ofType("EVENT")).toHaveLength(0);
  });

  test("disconnect clears the connection's subscriptions", () => {
    const relay = createRelay();
    relay.install();
    const conn = new FakeConnection();
    relay.addConnection(conn);
    conn.addSub("s", [{}]);
    relay.removeConnection(conn);
    expect(conn.subCount).toBe(0);
    // broadcast no longer reaches it
    relay.broadcast(events.note);
    expect(conn.ofType("EVENT")).toHaveLength(0);
  });

  test("connections() exposes registered connections", () => {
    const relay = new Relay();
    relay.install();
    const conn = new FakeConnection();
    relay.addConnection(conn);
    expect([...relay.connections()]).toContain(conn);
  });

  test("fetch upgrades to WebSocket when no route claims the request", async () => {
    const relay = createRelay();
    relay.install();
    let upgraded = false;
    const server = {
      upgrade: () => {
        upgraded = true;
        return true;
      },
    } as unknown as RelayServer;
    const res = await relay.fetch(new Request("http://localhost/"), server);
    expect(upgraded).toBe(true);
    expect(res).toBeUndefined();
  });

  test("fetch routes NIP-11 before attempting upgrade", async () => {
    const relay = createRelay({ name: "r" });
    relay.install();
    const server = { upgrade: () => false } as unknown as RelayServer;
    const res = await relay.fetch(
      new Request("http://localhost/", { headers: { Accept: "application/nostr+json" } }),
      server,
    );
    expect(res!.status).toBe(200);
  });
});
