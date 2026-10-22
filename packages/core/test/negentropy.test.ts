import { describe, expect, test } from "bun:test";
import { Negentropy, NegentropyStorage } from "../src/nips/nip77/negentropy";
import { randomHex } from "../src/util/hex";

type Item = { ts: number; id: string };

function build(items: Item[]) {
  const s = new NegentropyStorage();
  for (const it of items) s.insert(it.ts, it.id);
  s.seal();
  return s;
}

/** Runs a full client↔server reconciliation; returns ids client has / needs and number of round trips. */
function reconcile(clientItems: Item[], serverItems: Item[], frameSizeLimit = 0) {
  const client = new Negentropy(build(clientItems), frameSizeLimit);
  const server = new Negentropy(build(serverItems), frameSizeLimit);
  let msg: string | null = client.initiate();
  const have = new Set<string>();
  const need = new Set<string>();
  let rounds = 0;
  while (msg !== null) {
    if (++rounds > 100) throw new Error("too many rounds");
    if (frameSizeLimit) expect(msg.length / 2).toBeLessThanOrEqual(frameSizeLimit);
    const resp = server.reconcile(msg).output!;
    if (frameSizeLimit) expect(resp.length / 2).toBeLessThanOrEqual(frameSizeLimit);
    const r = client.reconcile(resp);
    r.have.forEach((x) => have.add(x));
    r.need.forEach((x) => need.add(x));
    msg = r.output;
  }
  return { have, need, rounds };
}

function makeSets(shared: number, clientOnly: number, serverOnly: number) {
  const mk = (n: number) => Array.from({ length: n }, () => ({ ts: 1_700_000_000 + Math.floor(Math.random() * 1000), id: randomHex(32) }));
  const s = mk(shared);
  const c = mk(clientOnly);
  const v = mk(serverOnly);
  return { client: [...s, ...c], server: [...s, ...v], c, v };
}

describe("negentropy", () => {
  test("identical sets reconcile in one round with no differences", () => {
    const { client, server } = makeSets(500, 0, 0);
    const r = reconcile(client, server);
    expect(r.have.size).toBe(0);
    expect(r.need.size).toBe(0);
    expect(r.rounds).toBe(1);
  });

  test("small sets use id lists", () => {
    const { client, server, c, v } = makeSets(5, 3, 4);
    const r = reconcile(client, server);
    expect([...r.have].sort()).toEqual(c.map((x) => x.id).sort());
    expect([...r.need].sort()).toEqual(v.map((x) => x.id).sort());
  });

  test("large sets with differences on both sides", () => {
    const { client, server, c, v } = makeSets(5000, 70, 130);
    const r = reconcile(client, server);
    expect([...r.have].sort()).toEqual(c.map((x) => x.id).sort());
    expect([...r.need].sort()).toEqual(v.map((x) => x.id).sort());
  });

  test("empty client against full server", () => {
    const { server, v } = makeSets(0, 0, 3000);
    const r = reconcile([], server);
    expect(r.need.size).toBe(v.length);
    expect(r.have.size).toBe(0);
  });

  test("respects frame size limit", () => {
    const { client, server, c, v } = makeSets(2000, 1500, 2500);
    const r = reconcile(client, server, 4096);
    expect(r.have.size).toBe(c.length);
    expect(r.need.size).toBe(v.length);
    expect(r.rounds).toBeGreaterThan(1);
  });

  test("items with equal timestamps", () => {
    const items = Array.from({ length: 300 }, () => ({ ts: 42, id: randomHex(32) }));
    const r = reconcile(items.slice(0, 250), items.slice(50));
    expect(r.have.size).toBe(50);
    expect(r.need.size).toBe(50);
  });

  test("responder answers unsupported versions with its own version", () => {
    const server = new Negentropy(build([]));
    expect(server.reconcile("62").output).toBe("61");
  });

  test("rejects garbage", () => {
    const server = new Negentropy(build([]));
    expect(() => server.reconcile("00")).toThrow();
    expect(() => server.reconcile("6101")).toThrow();
  });
});

// nostr-tools ships an initiator-only port of the reference implementation (not in its exports map)
describe("negentropy interop with nostr-tools reference port", async () => {
  const pure = import.meta.resolve("nostr-tools/pure");
  const ref = (await import(pure.replace(/\/lib\/esm\/pure\.js$/, "/lib/esm/nip77.js")).catch(() => undefined)) as
    | { Negentropy: new (s: unknown, limit?: number) => { initiate(): string; reconcile(m: string, onhave?: (id: string) => void, onneed?: (id: string) => void): string | null }; NegentropyStorageVector: new () => { insert(ts: number, id: string): void; seal(): void } }
    | undefined;

  test.skipIf(!ref)("reference client ↔ our server", () => {
    const { client, server, c, v } = makeSets(3000, 40, 60);
    const rs = new ref!.NegentropyStorageVector();
    for (const it of client) rs.insert(it.ts, it.id);
    rs.seal();
    const refClient = new ref!.Negentropy(rs, 60_000);
    const ours = new Negentropy(build(server), 60_000);
    const have: string[] = [];
    const need: string[] = [];
    let msg: string | null = refClient.initiate();
    for (let i = 0; msg !== null && i < 50; i++) {
      const resp = ours.reconcile(msg).output!;
      msg = refClient.reconcile(resp, (id) => have.push(id), (id) => need.push(id));
    }
    expect(have.sort()).toEqual(c.map((x) => x.id).sort());
    expect(need.sort()).toEqual(v.map((x) => x.id).sort());
  });
});
