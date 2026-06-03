import { describe, expect, test } from "bun:test";
import { Relay } from "../../src/relay.ts";
import { nip42, validateAuth } from "../../src/plugins/nip42.ts";
import type { Connection } from "../../src/connection.ts";
import { FakeConnection } from "../helpers.ts";
import { signEvent } from "../signer.ts";
import { PRIV } from "../fixtures.ts";

const URL = "wss://relay.example.com";

function newRelay(now = 1000, url: string = URL) {
  const relay = new Relay({ name: "t", url, now: () => now });
  relay.use(nip42());
  relay.install();
  return relay;
}

/** Build a relay with no configured URL (AUTH skips the relay-tag check). */
function newRelayNoUrl(now = 1000) {
  const relay = new Relay({ name: "t", url: undefined, now: () => now });
  relay.use(nip42());
  relay.install();
  return relay;
}

/** Connect a fake client and return [conn, the challenge it was issued]. */
function connect(relay: Relay): [FakeConnection, string] {
  const conn = new FakeConnection();
  relay.addConnection(conn);
  const auth = conn.ofType("AUTH")[0]!;
  return [conn, auth[1] as string];
}

/** Build a signed kind-22242 AUTH event. */
function authEvent(
  challenge: string,
  opts: { relay?: string; createdAt?: number; kind?: number } = {},
) {
  const tags: string[][] = [];
  if (opts.relay !== undefined) tags.push(["relay", opts.relay]);
  tags.push(["challenge", challenge]);
  return signEvent(
    { kind: opts.kind ?? 22242, created_at: opts.createdAt ?? 1000, tags, content: "" },
    PRIV,
  );
}

describe("NIP-42 AUTH handshake", () => {
  test("sends an AUTH challenge on connect", () => {
    const [, challenge] = connect(newRelay());
    expect(typeof challenge).toBe("string");
    expect(challenge.length).toBeGreaterThan(0);
  });

  test("valid AUTH authenticates the connection and replies OK true", async () => {
    const relay = newRelay();
    const [conn, challenge] = connect(relay);
    const ev = authEvent(challenge, { relay: URL });
    await relay.handleMessage(conn, JSON.stringify(["AUTH", ev]));
    expect(conn.ofType("OK")[0]).toEqual(["OK", ev.id, true, ""]);
    expect((conn as Connection).authedPubkey).toBe(ev.pubkey);
  });

  test("rejects a wrong challenge", async () => {
    const relay = newRelay();
    const [conn] = connect(relay);
    const ev = authEvent("not-the-challenge", { relay: URL });
    await relay.handleMessage(conn, JSON.stringify(["AUTH", ev]));
    const ok = conn.ofType("OK")[0]!;
    expect(ok[2]).toBe(false);
    expect(ok[3]).toContain("challenge");
    expect((conn as Connection).authedPubkey).toBeUndefined();
  });

  test("rejects a wrong relay tag", async () => {
    const relay = newRelay();
    const [conn, challenge] = connect(relay);
    const ev = authEvent(challenge, { relay: "wss://evil.example.com" });
    await relay.handleMessage(conn, JSON.stringify(["AUTH", ev]));
    const ok = conn.ofType("OK")[0]!;
    expect(ok[2]).toBe(false);
    expect(ok[3]).toContain("relay tag");
  });

  test("rejects a missing relay tag when a url is configured", async () => {
    const relay = newRelay();
    const [conn, challenge] = connect(relay);
    const ev = authEvent(challenge); // no relay tag
    await relay.handleMessage(conn, JSON.stringify(["AUTH", ev]));
    expect(conn.ofType("OK")[0]![2]).toBe(false);
  });

  test("skips the relay-tag check when no url is configured", async () => {
    const relay = newRelayNoUrl();
    const [conn, challenge] = connect(relay);
    const ev = authEvent(challenge); // no relay tag, but url unset -> fine
    await relay.handleMessage(conn, JSON.stringify(["AUTH", ev]));
    expect(conn.ofType("OK")[0]![2]).toBe(true);
  });

  test("rejects a stale AUTH event", async () => {
    const relay = newRelay(10_000);
    const [conn, challenge] = connect(relay);
    const ev = authEvent(challenge, { relay: URL, createdAt: 1000 }); // ~9000s old
    await relay.handleMessage(conn, JSON.stringify(["AUTH", ev]));
    const ok = conn.ofType("OK")[0]!;
    expect(ok[2]).toBe(false);
    expect(ok[3]).toContain("too old");
  });

  test("rejects a wrong kind", async () => {
    const relay = newRelay();
    const [conn, challenge] = connect(relay);
    const ev = authEvent(challenge, { relay: URL, kind: 1 });
    await relay.handleMessage(conn, JSON.stringify(["AUTH", ev]));
    expect(conn.ofType("OK")[0]![3]).toContain("kind 22242");
  });

  test("rejects a tampered (bad-signature) AUTH event", async () => {
    const relay = newRelay();
    const [conn, challenge] = connect(relay);
    const ev = authEvent(challenge, { relay: URL });
    const bad = { ...ev, content: "tampered" }; // id/sig no longer match
    await relay.handleMessage(conn, JSON.stringify(["AUTH", bad]));
    expect(conn.ofType("OK")[0]![3]).toContain("signature");
  });

  test("AUTH without an event object yields a NOTICE", async () => {
    const relay = newRelay();
    const [conn] = connect(relay);
    await relay.handleMessage(conn, JSON.stringify(["AUTH", "nope"]));
    expect(conn.ofType("NOTICE")[0]![1]).toContain("invalid");
  });

  test("validateAuth is usable directly", () => {
    const relay = newRelay();
    const [conn, challenge] = connect(relay);
    const ev = authEvent(challenge, { relay: URL });
    const res = validateAuth(ev, conn, {
      store: relay.store,
      broadcast: () => {},
      connections: () => relay.connections(),
      isVisible: () => true,
      config: relay.config,
    });
    expect(res.ok).toBe(true);
  });

  test("validateAuth falls back to the wall clock when config.now is unset", () => {
    // No injected clock: created_at uses the real wall clock.
    const relay = new Relay({ name: "t", url: URL });
    relay.use(nip42());
    relay.install();
    const [conn, challenge] = connect(relay);
    const nowSec = Math.floor(Date.now() / 1000);
    const ev = authEvent(challenge, { relay: URL, createdAt: nowSec });
    const res = validateAuth(ev, conn, {
      store: relay.store,
      broadcast: () => {},
      connections: () => relay.connections(),
      isVisible: () => true,
      config: relay.config,
    });
    expect(res.ok).toBe(true);
  });
});
