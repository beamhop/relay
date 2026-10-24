/** NIP-77 negentropy sync: NEG-OPEN / NEG-MSG / NEG-CLOSE round trips and the read policies applied to sync. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Event } from "nostr-tools";
// nostr-tools ships a negentropy client but doesn't export the subpath
// @ts-ignore
import { Negentropy, NegentropyStorageVector } from "../node_modules/nostr-tools/lib/esm/nip77.js";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient, newUser, now, sign } from "../harness/client";
import { connectAuthed, nextSub, nip11, note, withSettings } from "./policy-helpers";

let relay: Relay;
let c: RelayClient;
beforeAll(async () => {
  relay = await startRelay();
  c = await RelayClient.connect(relay.ws);
});
afterAll(async () => {
  c?.close();
  await relay?.stop();
});

const negFrame = (sub: string) => (m: unknown[]) => (m[0] === "NEG-MSG" || m[0] === "NEG-ERR") && m[1] === sub;

/** Full client-side reconciliation: returns ids the relay has that we lack (need) and ids we have that it lacks (have). */
async function sync(conn: RelayClient, filter: Record<string, unknown>, local: Event[] = []): Promise<{ need: string[]; have: string[]; rounds: number }> {
  const storage = new NegentropyStorageVector();
  for (const e of local) storage.insert(e.created_at, e.id);
  storage.seal();
  const neg = new Negentropy(storage, 4096);
  const sub = nextSub("neg");
  const need: string[] = [];
  const have: string[] = [];
  conn.send(["NEG-OPEN", sub, filter, neg.initiate()]);
  let rounds = 0;
  for (;;) {
    const m = await conn.waitFor(negFrame(sub));
    if (m[0] === "NEG-ERR") throw new Error(`NEG-ERR: ${m[2]}`);
    rounds++;
    const next = neg.reconcile(m[2] as string, (id: string) => have.push(id), (id: string) => need.push(id));
    if (!next) break;
    conn.send(["NEG-MSG", sub, next]);
  }
  conn.send(["NEG-CLOSE", sub]);
  return { need: need.sort(), have: have.sort(), rounds };
}

async function seed(n: number, kind = 1): Promise<{ author: ReturnType<typeof newUser>; events: Event[] }> {
  const author = newUser();
  const events: Event[] = [];
  for (let i = 0; i < n; i++) {
    const ev = sign(author.sk, { kind, content: `neg ${i} ${Math.random()}`, created_at: now() - i });
    expect((await c.publish(ev)).ok).toBe(true);
    events.push(ev);
  }
  return { author, events };
}
const ids = (evs: Event[]) => evs.map((e) => e.id).sort();

describe("negentropy round trips", () => {
  test("NIP-11 advertises NIP-77", async () => {
    expect((await nip11(relay)).supported_nips).toContain(77);
  });

  test("empty client storage learns every stored id matching the filter", async () => {
    const { author, events } = await seed(5);
    const r = await sync(c, { authors: [author.pubkey] });
    expect(r.need).toEqual(ids(events));
    expect(r.have).toEqual([]);
  });

  test("partial overlap: client needs what it lacks and reports what the relay lacks", async () => {
    const { author, events } = await seed(6);
    const localOnly = note(author.sk, "only on the client");
    const r = await sync(c, { authors: [author.pubkey] }, [...events.slice(0, 3), localOnly]);
    expect(r.need).toEqual(ids(events.slice(3)));
    expect(r.have).toEqual([localOnly.id]);
  });

  test("identical sets reconcile with nothing to transfer", async () => {
    const { author, events } = await seed(4);
    const r = await sync(c, { authors: [author.pubkey] }, events);
    expect(r.need).toEqual([]);
    expect(r.have).toEqual([]);
  });

  test("a larger set (300 ids, bucketed fingerprints) reconciles exactly", async () => {
    // staff are exempt from event rate limits, so all 300 are stored; a dedicated kind keeps the set to this test
    const author = { sk: relay.owner.sk, pubkey: relay.owner.pubkey };
    const events: Event[] = [];
    for (let i = 0; i < 300; i++) events.push(sign(author.sk, { kind: 1, content: `bulk ${i}`, created_at: now() - 1000 + i }));
    for (const e of events) c.send(["EVENT", e]);
    for (const e of events) expect((await c.waitFor((m) => m[0] === "OK" && m[1] === e.id))[2]).toBe(true);
    const local = events.filter((_, i) => i % 3 === 0);
    const r = await sync(c, { authors: [author.pubkey], kinds: [1] }, local);
    expect(r.need).toEqual(ids(events.filter((_, i) => i % 3 !== 0)));
    expect(r.have).toEqual([]);
  });

  test("NEG-MSG after NEG-CLOSE is answered with NEG-ERR closed:", async () => {
    const { author } = await seed(1);
    const storage = new NegentropyStorageVector();
    storage.seal();
    const neg = new Negentropy(storage, 4096);
    const sub = nextSub("neg");
    c.send(["NEG-OPEN", sub, { authors: [author.pubkey] }, neg.initiate()]);
    expect((await c.waitFor(negFrame(sub)))[0]).toBe("NEG-MSG");
    c.send(["NEG-CLOSE", sub]);
    c.send(["NEG-MSG", sub, neg.initiate()]);
    const m = await c.waitFor(negFrame(sub));
    expect(m).toEqual(["NEG-ERR", sub, "closed: no such negentropy session"]);
  });

  test("malformed messages are rejected", async () => {
    const sub = nextSub("neg");
    c.send(["NEG-OPEN", sub, { kinds: [1] }, "zz"]);
    expect(await c.waitFor(negFrame(sub))).toEqual(["NEG-ERR", sub, "invalid: negentropy message must be hex"]);
    const sub2 = nextSub("neg");
    c.send(["NEG-OPEN", sub2, { kinds: [1] }, "ff00"]); // bad protocol version
    const m = await c.waitFor(negFrame(sub2));
    expect(m[0]).toBe("NEG-ERR");
    expect(String(m[2])).toStartWith("invalid:");
  });

  test("search filters cannot be synced", async () => {
    const sub = nextSub("neg");
    const s = new NegentropyStorageVector();
    s.seal();
    c.send(["NEG-OPEN", sub, { search: "hello" }, new Negentropy(s, 4096).initiate()]);
    const m = await c.waitFor(negFrame(sub));
    expect(m).toEqual(["NEG-ERR", sub, "unsupported: search filters cannot be used for sync"]);
  });

  test("at most two sessions per connection", async () => {
    const conn = await RelayClient.connect(relay.ws);
    const s = new NegentropyStorageVector();
    s.seal();
    const init = new Negentropy(s, 4096).initiate();
    const subs = [nextSub("neg"), nextSub("neg"), nextSub("neg")];
    for (const sub of subs.slice(0, 2)) {
      conn.send(["NEG-OPEN", sub, { kinds: [1], limit: 1 }, init]);
      expect((await conn.waitFor(negFrame(sub)))[0]).toBe("NEG-MSG");
    }
    conn.send(["NEG-OPEN", subs[2], { kinds: [1] }, init]);
    expect(await conn.waitFor(negFrame(subs[2]))).toEqual(["NEG-ERR", subs[2], "blocked: too many negentropy sessions (max 2)"]);
    // closing one frees a slot
    conn.send(["NEG-CLOSE", subs[0]]);
    conn.send(["NEG-OPEN", subs[2], { kinds: [1] }, init]);
    expect((await conn.waitFor(negFrame(subs[2])))[0]).toBe("NEG-MSG");
    conn.close();
  });
});

describe("read policies apply to sync", () => {
  test("authForRead: NEG-OPEN without AUTH is refused", async () => {
    await withSettings(relay, { access: { authForRead: true } }, async () => {
      const conn = await RelayClient.connect(relay.ws);
      const sub = nextSub("neg");
      const s = new NegentropyStorageVector();
      s.seal();
      conn.send(["NEG-OPEN", sub, { kinds: [1] }, new Negentropy(s, 4096).initiate()]);
      const m = await conn.waitFor(negFrame(sub));
      expect(m[0]).toBe("NEG-ERR");
      expect(String(m[2])).toStartWith("auth-required:");
      conn.close();
    });
  });

  test("DM ids are not disclosed to unauthenticated or unrelated syncers, but are to the recipient", async () => {
    const alice = newUser();
    const bob = newUser();
    const pub = sign(alice.sk, { kind: 1, content: "public" });
    const dm = sign(alice.sk, { kind: 4, content: "secret?iv=x", tags: [["p", bob.pubkey]] });
    expect((await c.publish(pub)).ok).toBe(true);
    expect((await c.publish(dm)).ok).toBe(true);
    const anon = await sync(c, { authors: [alice.pubkey] });
    expect(anon.need).toEqual([pub.id]);
    const strangerConn = await connectAuthed(relay, newUser().sk);
    expect((await sync(strangerConn, { authors: [alice.pubkey] })).need).toEqual([pub.id]);
    const bobConn = await connectAuthed(relay, bob.sk);
    expect((await sync(bobConn, { authors: [alice.pubkey] })).need).toEqual([pub.id, dm.id].sort());
    strangerConn.close();
    bobConn.close();
  });

  test("events removed by moderation disappear from sync", async () => {
    const { author, events } = await seed(3);
    const { ownerApi } = await import("./policy-helpers");
    await ownerApi(relay, "POST", `/users/${author.pubkey}/ban`, { deleteEvents: true });
    const r = await sync(c, { authors: [author.pubkey] }, events.slice(0, 1));
    expect(r.need).toEqual([]);
    expect(r.have).toEqual([events[0].id]);
  });
});
