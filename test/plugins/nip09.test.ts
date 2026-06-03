import { describe, expect, test } from "bun:test";
import { Relay } from "../../src/relay.ts";
import { nip01 } from "../../src/plugins/nip01.ts";
import { nip09 } from "../../src/plugins/nip09.ts";
import { FakeConnection } from "../helpers.ts";
import { signEvent, getPublicKey, PRIV_B } from "../signer.ts";
import { PRIV } from "../fixtures.ts";

const PUB = getPublicKey(PRIV);

function newRelay(url?: string) {
  const relay = new Relay({ name: "t", url });
  relay.use(nip01(relay)).use(nip09());
  relay.install();
  return relay;
}

async function publish(relay: Relay, event: object) {
  const conn = new FakeConnection();
  relay.addConnection(conn);
  await relay.handleMessage(conn, JSON.stringify(["EVENT", event]));
  return conn;
}

describe("NIP-09 deletion", () => {
  test("kind-5 deletes an author's own event by e tag, stores the deletion", async () => {
    const relay = newRelay();
    const note = signEvent({ kind: 1, created_at: 1000, content: "x" }, PRIV);
    await publish(relay, note);
    expect(relay.store.getById(note.id)).toBeDefined();

    const del = signEvent({ kind: 5, created_at: 1001, tags: [["e", note.id]] }, PRIV);
    const conn = await publish(relay, del);

    expect(conn.ofType("OK")[0]![2]).toBe(true);
    expect(relay.store.getById(note.id)).toBeUndefined();
    expect(relay.store.getById(del.id)).toBeDefined(); // deletion itself persists
  });

  test("does not delete another author's event", async () => {
    const relay = newRelay();
    const note = signEvent({ kind: 1, created_at: 1000, content: "x" }, PRIV);
    await publish(relay, note);
    // PRIV_B tries to delete PRIV's note
    const del = signEvent({ kind: 5, created_at: 1001, tags: [["e", note.id]] }, PRIV_B);
    await publish(relay, del);
    expect(relay.store.getById(note.id)).toBeDefined();
  });

  test("kind-5 deletes an addressable event by a tag", async () => {
    const relay = newRelay();
    const addr = signEvent(
      { kind: 30000, created_at: 1000, tags: [["d", "slot"]], content: "v1" },
      PRIV,
    );
    await publish(relay, addr);
    const del = signEvent(
      { kind: 5, created_at: 1001, tags: [["a", `30000:${PUB}:slot`]] },
      PRIV,
    );
    await publish(relay, del);
    expect(relay.store.getById(addr.id)).toBeUndefined();
  });

  test("a-tag deletion does not erase a newer replacement", async () => {
    const relay = newRelay();
    const del = signEvent(
      { kind: 5, created_at: 1000, tags: [["a", `30000:${PUB}:slot`]] },
      PRIV,
    );
    await publish(relay, del);
    // A replacement published *after* the deletion survives.
    const newer = signEvent(
      { kind: 30000, created_at: 2000, tags: [["d", "slot"]], content: "v2" },
      PRIV,
    );
    await publish(relay, newer);
    expect(relay.store.getById(newer.id)).toBeDefined();
  });

  test("a-tag with another author's pubkey is ignored", async () => {
    const relay = newRelay();
    const addr = signEvent(
      { kind: 30000, created_at: 1000, tags: [["d", "slot"]], content: "v1" },
      PRIV,
    );
    await publish(relay, addr);
    const del = signEvent(
      { kind: 5, created_at: 1001, tags: [["a", `30000:${getPublicKey(PRIV_B)}:slot`]] },
      PRIV,
    );
    await publish(relay, del);
    expect(relay.store.getById(addr.id)).toBeDefined();
  });

  test("malformed a tag is ignored", async () => {
    const relay = newRelay();
    const del = signEvent({ kind: 5, created_at: 1001, tags: [["a", "garbage"]] }, PRIV);
    const conn = await publish(relay, del);
    expect(conn.ofType("OK")[0]![2]).toBe(true);
  });

  test("e tag for an unknown event is a no-op", async () => {
    const relay = newRelay();
    const del = signEvent({ kind: 5, created_at: 1001, tags: [["e", "f".repeat(64)]] }, PRIV);
    const conn = await publish(relay, del);
    expect(conn.ofType("OK")[0]![2]).toBe(true);
  });
});

describe("NIP-62 request to vanish", () => {
  test("untagged vanish erases all of the author's prior events", async () => {
    const relay = newRelay();
    await publish(relay, signEvent({ kind: 1, created_at: 1000, content: "a" }, PRIV));
    await publish(relay, signEvent({ kind: 1, created_at: 1001, content: "b" }, PRIV));
    expect(relay.store.size()).toBe(2);

    const vanish = signEvent({ kind: 62, created_at: 2000, content: "bye" }, PRIV);
    await publish(relay, vanish);
    // The two notes are gone; the vanish request itself remains.
    expect(relay.store.count([{ authors: [PUB], kinds: [1] }])).toBe(0);
    expect(relay.store.getById(vanish.id)).toBeDefined();
  });

  test("vanish targeting this relay url applies", async () => {
    const relay = newRelay("wss://relay.example.com");
    await publish(relay, signEvent({ kind: 1, created_at: 1000, content: "a" }, PRIV));
    const vanish = signEvent(
      { kind: 62, created_at: 2000, tags: [["relay", "wss://relay.example.com/"]] },
      PRIV,
    );
    await publish(relay, vanish);
    expect(relay.store.count([{ authors: [PUB], kinds: [1] }])).toBe(0);
  });

  test("vanish targeting a different relay does not apply", async () => {
    const relay = newRelay("wss://relay.example.com");
    const note = signEvent({ kind: 1, created_at: 1000, content: "a" }, PRIV);
    await publish(relay, note);
    const vanish = signEvent(
      { kind: 62, created_at: 2000, tags: [["relay", "wss://other.example.com"]] },
      PRIV,
    );
    await publish(relay, vanish);
    expect(relay.store.getById(note.id)).toBeDefined();
  });

  test("ALL_RELAYS sentinel applies anywhere", async () => {
    const relay = newRelay("wss://relay.example.com");
    await publish(relay, signEvent({ kind: 1, created_at: 1000, content: "a" }, PRIV));
    const vanish = signEvent(
      { kind: 62, created_at: 2000, tags: [["relay", "ALL_RELAYS"]] },
      PRIV,
    );
    await publish(relay, vanish);
    expect(relay.store.count([{ authors: [PUB], kinds: [1] }])).toBe(0);
  });

  test("does not erase events newer than the request", async () => {
    const relay = newRelay();
    const vanish = signEvent({ kind: 62, created_at: 2000, content: "bye" }, PRIV);
    await publish(relay, vanish);
    const later = signEvent({ kind: 1, created_at: 3000, content: "after" }, PRIV);
    await publish(relay, later);
    expect(relay.store.getById(later.id)).toBeDefined();
  });
});
