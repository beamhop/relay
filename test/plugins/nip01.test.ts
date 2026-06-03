import { describe, expect, test } from "bun:test";
import { createRelay } from "../../src/server.ts";
import { storageClass } from "../../src/plugins/nip01.ts";
import { FakeConnection } from "../helpers.ts";
import { clone, events } from "../fixtures.ts";

function newRelay(limitation?: Record<string, number>) {
  const relay = createRelay({ name: "t", limitation });
  relay.install();
  return relay;
}

describe("nip01 re-exports", () => {
  test("exposes storageClass", () => {
    expect(storageClass(1)).toBe("regular");
  });
});

describe("EVENT handling", () => {
  test("accepts and stores a valid event, replies OK true, broadcasts", async () => {
    const relay = newRelay();
    const subscriber = new FakeConnection();
    relay.addConnection(subscriber);
    subscriber.addSub("sub", [{ kinds: [1] }]);

    const author = new FakeConnection();
    relay.addConnection(author);
    await relay.handleMessage(author, JSON.stringify(["EVENT", events.note]));

    expect(author.ofType("OK")[0]).toEqual(["OK", events.note.id, true, ""]);
    expect(relay.store.getById(events.note.id)).toBeDefined();
    // subscriber received the live event
    const evs = subscriber.ofType("EVENT");
    expect(evs).toHaveLength(1);
    expect(evs[0]![2].id).toBe(events.note.id);
  });

  test("rejects a tampered event with OK false", async () => {
    const relay = newRelay();
    const conn = new FakeConnection();
    relay.addConnection(conn);
    const bad = clone(events.note);
    bad.content = "tampered";
    await relay.handleMessage(conn, JSON.stringify(["EVENT", bad]));
    const ok = conn.ofType("OK")[0]!;
    expect(ok[2]).toBe(false);
    expect(ok[3]).toContain("invalid");
    expect(relay.store.size()).toBe(0);
  });

  test("duplicate event replies OK true with a duplicate reason", async () => {
    const relay = newRelay();
    relay.store.add(events.note);
    const conn = new FakeConnection();
    relay.addConnection(conn);
    await relay.handleMessage(conn, JSON.stringify(["EVENT", events.note]));
    const ok = conn.ofType("OK")[0]!;
    expect(ok[2]).toBe(true);
    expect(ok[3]).toContain("duplicate");
  });

  test("EVENT without an event object yields a NOTICE", async () => {
    const relay = newRelay();
    const conn = new FakeConnection();
    relay.addConnection(conn);
    await relay.handleMessage(conn, JSON.stringify(["EVENT", "nope"]));
    expect(conn.ofType("NOTICE")[0]![1]).toContain("invalid");
  });

  test("ephemeral events are broadcast but not stored", async () => {
    const relay = newRelay();
    const subscriber = new FakeConnection();
    relay.addConnection(subscriber);
    subscriber.addSub("s", [{ kinds: [20000] }]);
    const author = new FakeConnection();
    relay.addConnection(author);
    await relay.handleMessage(author, JSON.stringify(["EVENT", events.ephemeral]));
    expect(relay.store.size()).toBe(0);
    expect(subscriber.ofType("EVENT")).toHaveLength(1);
  });
});

describe("REQ handling", () => {
  test("returns stored events newest-first then EOSE", async () => {
    const relay = newRelay();
    relay.store.add(events.note); // older
    relay.store.add(events.reaction); // newer
    const conn = new FakeConnection();
    relay.addConnection(conn);
    await relay.handleMessage(conn, JSON.stringify(["REQ", "sub", { kinds: [1, 7] }]));

    // Ignore the NIP-42 AUTH challenge sent on connect; assert on the REQ reply.
    const order = conn.messages.filter((m) => m[0] !== "AUTH");
    expect(order[0]).toEqual(["EVENT", "sub", events.reaction]);
    expect(order[1]).toEqual(["EVENT", "sub", events.note]);
    expect(order[2]).toEqual(["EOSE", "sub"]);
  });

  test("honors limit", async () => {
    const relay = newRelay();
    relay.store.add(events.note);
    relay.store.add(events.reaction);
    const conn = new FakeConnection();
    relay.addConnection(conn);
    await relay.handleMessage(conn, JSON.stringify(["REQ", "sub", { limit: 1 }]));
    expect(conn.ofType("EVENT")).toHaveLength(1);
  });

  test("subsequent matching events are delivered live", async () => {
    const relay = newRelay();
    const conn = new FakeConnection();
    relay.addConnection(conn);
    await relay.handleMessage(conn, JSON.stringify(["REQ", "sub", { kinds: [1] }]));
    // publish from another connection
    const author = new FakeConnection();
    relay.addConnection(author);
    await relay.handleMessage(author, JSON.stringify(["EVENT", events.note]));
    expect(conn.ofType("EVENT").some((m) => m[2].id === events.note.id)).toBe(true);
  });

  test("rejects an invalid subscription id with a NOTICE", async () => {
    const relay = newRelay();
    const conn = new FakeConnection();
    relay.addConnection(conn);
    await relay.handleMessage(conn, JSON.stringify(["REQ", ""]));
    expect(conn.ofType("NOTICE")[0]![1]).toContain("subscription id");
  });

  test("enforces max_subscriptions with CLOSED", async () => {
    const relay = newRelay({ max_subscriptions: 1 });
    const conn = new FakeConnection();
    relay.addConnection(conn);
    await relay.handleMessage(conn, JSON.stringify(["REQ", "a", {}]));
    await relay.handleMessage(conn, JSON.stringify(["REQ", "b", {}]));
    const closed = conn.ofType("CLOSED")[0]!;
    expect(closed[1]).toBe("b");
    expect(closed[2]).toContain("rate-limited");
  });

  test("re-using an existing sub id does not trip max_subscriptions", async () => {
    const relay = newRelay({ max_subscriptions: 1 });
    const conn = new FakeConnection();
    relay.addConnection(conn);
    await relay.handleMessage(conn, JSON.stringify(["REQ", "a", {}]));
    await relay.handleMessage(conn, JSON.stringify(["REQ", "a", { kinds: [1] }]));
    expect(conn.ofType("CLOSED")).toHaveLength(0);
  });
});

describe("CLOSE handling", () => {
  test("removes a subscription so later events are not delivered", async () => {
    const relay = newRelay();
    const conn = new FakeConnection();
    relay.addConnection(conn);
    await relay.handleMessage(conn, JSON.stringify(["REQ", "sub", { kinds: [1] }]));
    await relay.handleMessage(conn, JSON.stringify(["CLOSE", "sub"]));
    expect(conn.subscriptions.has("sub")).toBe(false);

    const author = new FakeConnection();
    relay.addConnection(author);
    await relay.handleMessage(author, JSON.stringify(["EVENT", events.note]));
    expect(conn.ofType("EVENT")).toHaveLength(0);
  });

  test("ignores CLOSE with a non-string id", async () => {
    const relay = newRelay();
    const conn = new FakeConnection();
    relay.addConnection(conn);
    await relay.handleMessage(conn, JSON.stringify(["CLOSE", 5]));
    // No reply to the bad CLOSE (the connect-time AUTH challenge aside).
    expect(conn.messages.filter((m) => m[0] !== "AUTH")).toHaveLength(0);
  });
});
