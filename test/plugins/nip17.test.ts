import { describe, expect, test } from "bun:test";
import { Relay } from "../../src/relay.ts";
import { nip01 } from "../../src/plugins/nip01.ts";
import { nip17, giftWrapRecipient } from "../../src/plugins/nip17.ts";
import { nip42 } from "../../src/plugins/nip42.ts";
import { FakeConnection } from "../helpers.ts";
import { signEvent, getPublicKey, PRIV_B } from "../signer.ts";
import { PRIV } from "../fixtures.ts";

const RECIPIENT = getPublicKey(PRIV); // "me"
const URL = "wss://relay.example.com";

function newRelay(now = 1000) {
  const relay = new Relay({ name: "t", url: URL, now: () => now });
  relay.use(nip01(relay)).use(nip42()).use(nip17());
  relay.install();
  return relay;
}

/** A kind-1059 gift wrap p-tagged to `recipient`, signed by a throwaway key. */
function giftWrap(recipient: string, createdAt = 900) {
  // NIP-59 back-dates created_at; sign with a different key than the recipient.
  return signEvent(
    { kind: 1059, created_at: createdAt, tags: [["p", recipient]], content: "sealed" },
    PRIV_B,
  );
}

/** Connect and AUTH a connection as `priv`'s pubkey. */
async function authedConn(relay: Relay, priv: string): Promise<FakeConnection> {
  const conn = new FakeConnection();
  relay.addConnection(conn);
  const challenge = conn.ofType("AUTH")[0]![1] as string;
  const auth = signEvent(
    { kind: 22242, created_at: 1000, tags: [["relay", URL], ["challenge", challenge]], content: "" },
    priv,
  );
  await relay.handleMessage(conn, JSON.stringify(["AUTH", auth]));
  return conn;
}

describe("NIP-17 helpers", () => {
  test("giftWrapRecipient reads the p tag", () => {
    expect(giftWrapRecipient(giftWrap(RECIPIENT))).toBe(RECIPIENT);
    const noP = signEvent({ kind: 1059, created_at: 900, content: "x" }, PRIV_B);
    expect(giftWrapRecipient(noP)).toBeUndefined();
  });
});

describe("NIP-17 gift-wrap gating over REQ (historical)", () => {
  async function reqGiftWraps(relay: Relay, conn: FakeConnection): Promise<number> {
    await relay.handleMessage(conn, JSON.stringify(["REQ", "dm", { kinds: [1059], "#p": [RECIPIENT] }]));
    return conn.ofType("EVENT").length;
  }

  test("hidden from an un-AUTH'd connection", async () => {
    const relay = newRelay();
    relay.store.add(giftWrap(RECIPIENT));
    const conn = new FakeConnection();
    relay.addConnection(conn);
    expect(await reqGiftWraps(relay, conn)).toBe(0);
  });

  test("hidden from an AUTH'd connection that does not subscribe by the wrap's #p", async () => {
    const relay = newRelay();
    relay.store.add(giftWrap(RECIPIENT));
    const conn = await authedConn(relay, PRIV_B); // AUTH'd as someone else
    // Subscribe by kind only (no #p naming RECIPIENT): neither gate condition holds.
    await relay.handleMessage(conn, JSON.stringify(["REQ", "dm", { kinds: [1059] }]));
    expect(conn.ofType("EVENT").length).toBe(0);
  });

  test("served to an AUTH'd connection that subscribes by the wrap's (ephemeral) #p", async () => {
    // Mirrors iris.to's double-ratchet: the wrap is p-tagged to a one-time key
    // that nobody AUTHs as; the recipient proves authorization by AUTH'ing (as
    // any identity) and subscribing to that exact #p.
    const relay = newRelay();
    const gw = giftWrap(RECIPIENT);
    relay.store.add(gw);
    const conn = await authedConn(relay, PRIV_B); // AUTH'd, but not as RECIPIENT
    await relay.handleMessage(conn, JSON.stringify(["REQ", "dm", { kinds: [1059], "#p": [RECIPIENT] }]));
    const events = conn.ofType("EVENT");
    expect(events).toHaveLength(1);
    expect(events[0]![2].id).toBe(gw.id);
  });

  test("served to the AUTH'd recipient", async () => {
    const relay = newRelay();
    const gw = giftWrap(RECIPIENT);
    relay.store.add(gw);
    const conn = await authedConn(relay, PRIV); // AUTH'd as recipient
    await relay.handleMessage(conn, JSON.stringify(["REQ", "dm", { kinds: [1059], "#p": [RECIPIENT] }]));
    const events = conn.ofType("EVENT");
    expect(events).toHaveLength(1);
    expect(events[0]![2].id).toBe(gw.id);
  });
});

describe("NIP-17 gift-wrap gating over live broadcast", () => {
  test("delivered only to the AUTH'd recipient's live subscription", async () => {
    const relay = newRelay();

    const me = await authedConn(relay, PRIV);
    await relay.handleMessage(me, JSON.stringify(["REQ", "dm", { kinds: [1059] }]));

    const other = await authedConn(relay, PRIV_B);
    await relay.handleMessage(other, JSON.stringify(["REQ", "dm", { kinds: [1059] }]));

    // A third party publishes a gift wrap addressed to me.
    const publisher = new FakeConnection();
    relay.addConnection(publisher);
    const gw = giftWrap(RECIPIENT);
    await relay.handleMessage(publisher, JSON.stringify(["EVENT", gw]));

    expect(me.ofType("EVENT").some((m) => m[2].id === gw.id)).toBe(true);
    expect(other.ofType("EVENT").some((m) => m[2].id === gw.id)).toBe(false);
  });
});

describe("NIP-17 leaves non-gift-wrap events alone", () => {
  test("a public note is visible without AUTH", async () => {
    const relay = newRelay();
    const note = signEvent({ kind: 1, created_at: 900, content: "hi" }, PRIV);
    relay.store.add(note);
    const conn = new FakeConnection();
    relay.addConnection(conn);
    await relay.handleMessage(conn, JSON.stringify(["REQ", "s", { kinds: [1] }]));
    expect(conn.ofType("EVENT")).toHaveLength(1);
  });
});
