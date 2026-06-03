import { describe, expect, test } from "bun:test";
import { Relay } from "../../src/relay.ts";
import { nip01 } from "../../src/plugins/nip01.ts";
import { conventions, CONVENTION_NIPS } from "../../src/plugins/conventions.ts";
import { storageClass } from "../../src/store/store.ts";
import { FakeConnection } from "../helpers.ts";
import { signEvent, getPublicKey } from "../signer.ts";
import { PRIV } from "../fixtures.ts";

const PUB = getPublicKey(PRIV);

function newRelay() {
  const relay = new Relay({ name: "t" });
  relay.use(nip01(relay)).use(conventions());
  relay.install();
  return relay;
}

async function publish(relay: Relay, event: object) {
  const conn = new FakeConnection();
  relay.addConnection(conn);
  await relay.handleMessage(conn, JSON.stringify(["EVENT", event]));
  return conn;
}

describe("convention NIP advertisement", () => {
  test("advertises every convention NIP in supported_nips", () => {
    const relay = newRelay();
    const nips = relay.info.supported_nips as number[];
    for (const nip of CONVENTION_NIPS) expect(nips).toContain(nip);
  });
});

describe("storage-class handling for convention kinds", () => {
  test("NIP-02 follow list (kind 3) and NIP-65 relay list (kind 10002) are replaceable", () => {
    expect(storageClass(3)).toBe("replaceable"); // NIP-02
    expect(storageClass(10002)).toBe("replaceable"); // NIP-65
  });

  test("NIP-16 ranges: replaceable / ephemeral", () => {
    expect(storageClass(10000)).toBe("replaceable");
    expect(storageClass(19999)).toBe("replaceable");
    expect(storageClass(20000)).toBe("ephemeral");
    expect(storageClass(29999)).toBe("ephemeral");
  });

  test("NIP-33 parameterized replaceable (30000-39999) is addressable", () => {
    expect(storageClass(30000)).toBe("addressable");
    expect(storageClass(39999)).toBe("addressable");
  });

  test("NIP-03/04/25/28 kinds are stored as regular events", () => {
    for (const kind of [1040, 4, 7, 40, 41, 42, 43, 44]) {
      expect(storageClass(kind)).toBe("regular");
    }
  });
});

describe("end-to-end storage & querying of convention kinds", () => {
  test("NIP-65 relay list is replaced by a newer one", async () => {
    const relay = newRelay();
    const old = signEvent(
      { kind: 10002, created_at: 1000, tags: [["r", "wss://a"]], content: "" },
      PRIV,
    );
    const fresh = signEvent(
      { kind: 10002, created_at: 2000, tags: [["r", "wss://b"]], content: "" },
      PRIV,
    );
    await publish(relay, old);
    await publish(relay, fresh);
    const stored = relay.store.query([{ kinds: [10002], authors: [PUB] }]);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.id).toBe(fresh.id);
  });

  test("NIP-12 generic tag query matches a NIP-14 subject tag", async () => {
    const relay = newRelay();
    const note = signEvent(
      { kind: 1, created_at: 1000, tags: [["subject", "hello"], ["t", "topic"]], content: "hi" },
      PRIV,
    );
    await publish(relay, note);
    // Query by a single-letter generic tag (NIP-12).
    const byTag = relay.store.query([{ "#t": ["topic"] }]);
    expect(byTag.map((e) => e.id)).toEqual([note.id]);
    // The multi-letter `subject` tag is not a queryable filter key (NIP-12 is
    // single-letter only) but the event is still stored and served.
    expect(relay.store.getById(note.id)?.tags).toContainEqual(["subject", "hello"]);
  });

  test("NIP-04 encrypted DM (kind 4) is stored and queryable by #p", async () => {
    const relay = newRelay();
    const recipient = "c".repeat(64);
    const dm = signEvent(
      { kind: 4, created_at: 1000, tags: [["p", recipient]], content: "base64ciphertext?iv=..." },
      PRIV,
    );
    await publish(relay, dm);
    const got = relay.store.query([{ kinds: [4], "#p": [recipient] }]);
    expect(got.map((e) => e.id)).toEqual([dm.id]);
  });

  test("NIP-25 reaction (kind 7) round-trips with e/p tags", async () => {
    const relay = newRelay();
    const reaction = signEvent(
      {
        kind: 7,
        created_at: 1000,
        tags: [["e", "a".repeat(64)], ["p", "b".repeat(64)]],
        content: "+",
      },
      PRIV,
    );
    const conn = await publish(relay, reaction);
    expect(conn.ofType("OK")[0]![2]).toBe(true);
    expect(relay.store.query([{ kinds: [7], "#e": ["a".repeat(64)] }])).toHaveLength(1);
  });
});
