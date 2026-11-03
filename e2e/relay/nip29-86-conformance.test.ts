/**
 * NIP-29 / NIP-86 conformance probes against the current spec text (nostr-protocol/nips master).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { finalizeEvent, type Event } from "nostr-tools";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient, newUser, now, sha256, sign } from "../harness/client";
import { connectAs, connectAuthed, nextSub, nip11, nip86, nip86ok, nip98, note, uniqueIp } from "./policy-helpers";

let relay: Relay;
let self: string;
let reader: RelayClient;
beforeAll(async () => {
  relay = await startRelay({ overrides: { server: { trustProxy: true } } });
  self = (await nip11(relay)).self;
  reader = await connectAs(relay, uniqueIp());
});
afterAll(async () => {
  reader?.close();
  await relay?.stop();
});

let gseq = 0;
const gid = () => `c${Date.now().toString(36)}${++gseq}`;
type User = ReturnType<typeof newUser>;

async function createGroup(c: RelayClient, admin: User, flags: string[] = [], extra: string[][] = []) {
  const id = gid();
  const r = await c.publish(sign(admin.sk, { kind: 9007, tags: [["h", id], ["name", `G ${id}`], ...flags.map((f) => [f]), ...extra] }));
  expect(r).toEqual({ ok: true, message: "" });
  return id;
}
const ctl = (u: User, kind: number, id: string, tags: string[][] = [], created_at?: number) =>
  sign(u.sk, { kind, content: Math.random().toString(36).slice(2), tags: [["h", id], ...tags], ...(created_at ? { created_at } : {}) });
async function meta(kind: number, id: string, via: RelayClient = reader): Promise<Event | undefined> {
  return (await via.query(nextSub("m"), [{ kinds: [kind], authors: [self], "#d": [id] }])).events[0];
}
async function count(c: RelayClient, filter: Record<string, unknown>): Promise<unknown[]> {
  const s = nextSub("cnt");
  c.send(["COUNT", s, filter]);
  return c.waitFor((f) => f[1] === s && (f[0] === "COUNT" || f[0] === "CLOSED"));
}

// ------------------------------------------------------------------ NIP-29

describe("NIP-29 relay-generated events", () => {
  test("39000-39003 are signed by the NIP-11 `self` key with d = group id", async () => {
    const c = await connectAs(relay, uniqueIp());
    const id = await createGroup(c, newUser());
    for (const k of [39000, 39001, 39002, 39003]) {
      const ev = await meta(k, id);
      expect(ev?.pubkey).toBe(self);
      expect(ev?.tags.find((t) => t[0] === "d")?.[1]).toBe(id);
    }
    c.close();
  });

  test("9022 leave: the relay issues a kind 9001 removing the user", async () => {
    const admin = newUser();
    const m = newUser();
    const c = await connectAs(relay, uniqueIp());
    const id = await createGroup(c, admin);
    expect((await c.publish(ctl(m, 9021, id))).ok).toBe(true);
    expect((await c.publish(ctl(m, 9022, id))).ok).toBe(true);
    const { events } = await reader.query(nextSub(), [{ kinds: [9001], authors: [self], "#h": [id] }]);
    expect(events.some((e) => e.tags.some((t) => t[0] === "p" && t[1] === m.pubkey))).toBe(true);
    c.close();
  });

  test("9000 on an existing member updates its roles in 39001 (promote, then demote)", async () => {
    const admin = newUser();
    const m = newUser();
    const c = await connectAs(relay, uniqueIp());
    const id = await createGroup(c, admin);
    await c.publish(ctl(m, 9021, id));
    expect((await c.publish(ctl(admin, 9000, id, [["p", m.pubkey, "moderator"]]))).ok).toBe(true);
    expect((await meta(39001, id))?.tags).toContainEqual(["p", m.pubkey, "moderator"]);
    expect((await c.publish(ctl(admin, 9000, id, [["p", m.pubkey]]))).ok).toBe(true);
    expect((await meta(39001, id))?.tags.some((t) => t[1] === m.pubkey)).toBe(false);
    expect((await meta(39002, id))?.tags).toContainEqual(["p", m.pubkey]);
    c.close();
  });

  test("9001 removing an admin drops it from 39001 and 39002", async () => {
    const owner = newUser();
    const a2 = newUser();
    const c = await connectAs(relay, uniqueIp());
    const id = await createGroup(c, owner);
    await c.publish(ctl(owner, 9000, id, [["p", a2.pubkey, "admin"]]));
    expect((await c.publish(ctl(owner, 9001, id, [["p", a2.pubkey]]))).ok).toBe(true);
    expect((await meta(39001, id))?.tags.some((t) => t[1] === a2.pubkey)).toBe(false);
    expect((await meta(39002, id))?.tags.some((t) => t[1] === a2.pubkey)).toBe(false);
    c.close();
  });

  test("9002 carries the full metadata set: an omitted flag is cleared in 39000", async () => {
    const admin = newUser();
    const c = await connectAs(relay, uniqueIp());
    const id = await createGroup(c, admin, ["closed", "restricted"]);
    expect((await c.publish(ctl(admin, 9002, id, [["name", "x"], ["restricted"]]))).ok).toBe(true);
    const tags = (await meta(39000, id))?.tags ?? [];
    expect(tags).toContainEqual(["restricted"]);
    expect(tags).not.toContainEqual(["closed"]);
    c.close();
  });
});

describe("NIP-29 writes", () => {
  test("late publication: group content dated hours ago is rejected", async () => {
    const admin = newUser();
    const c = await connectAs(relay, uniqueIp());
    const id = await createGroup(c, admin);
    const r = await c.publish(sign(admin.sk, { kind: 9, content: "old", tags: [["h", id]], created_at: now() - 3 * 3600 }));
    expect(r.ok).toBe(false);
    c.close();
  });

  test("previous: unknown reference rejected, known reference accepted", async () => {
    const admin = newUser();
    const c = await connectAs(relay, uniqueIp());
    const id = await createGroup(c, admin);
    const first = sign(admin.sk, { kind: 9, content: "first", tags: [["h", id]] });
    expect((await c.publish(first)).ok).toBe(true);
    const bad = await c.publish(sign(newUser().sk, { kind: 9, content: "b", tags: [["h", id], ["previous", "deadbeef"]] }));
    expect(bad.ok).toBe(false);
    const good = await c.publish(sign(newUser().sk, { kind: 9, content: "g", tags: [["h", id], ["previous", first.id.slice(0, 8)]] }));
    expect(good.ok).toBe(true);
    c.close();
  });

  test("closed group: a join request with a wrong code is not honored", async () => {
    const admin = newUser();
    const c = await connectAs(relay, uniqueIp());
    const id = await createGroup(c, admin, ["closed"]);
    await c.publish(ctl(admin, 9009, id, [["code", "right-code-123"]]));
    const r = await c.publish(ctl(newUser(), 9021, id, [["code", "wrong-code-123"]]));
    expect(r.ok).toBe(false);
    c.close();
  });

  test("after 9008 delete-group the id can be created again with fresh state", async () => {
    const a = newUser();
    const b = newUser();
    const c = await connectAs(relay, uniqueIp());
    const id = await createGroup(c, a);
    expect((await c.publish(ctl(a, 9008, id))).ok).toBe(true);
    expect((await c.publish(sign(b.sk, { kind: 9007, tags: [["h", id]] }))).ok).toBe(true);
    expect((await meta(39001, id))?.tags.filter((t) => t[0] === "p").map((t) => t[1])).toEqual([b.pubkey]);
    c.close();
  });

  test("supported_kinds limits the kinds a group accepts", async () => {
    const admin = newUser();
    const c = await connectAs(relay, uniqueIp());
    const id = await createGroup(c, admin, [], [["supported_kinds", "9"]]);
    expect((await c.publish(sign(admin.sk, { kind: 9, content: "ok", tags: [["h", id]] }))).ok).toBe(true);
    expect((await c.publish(sign(admin.sk, { kind: 11, content: "no", tags: [["h", id]] }))).ok).toBe(false);
    c.close();
  });
});

describe("NIP-29 read visibility", () => {
  test("COUNT without an #h filter does not count private group content for outsiders", async () => {
    const admin = newUser();
    const c = await connectAs(relay, uniqueIp());
    const id = await createGroup(c, admin, ["private"]);
    const marker = `t${Math.random().toString(36).slice(2)}`;
    await c.publish(sign(admin.sk, { kind: 9, content: "s", tags: [["h", id], ["t", marker]] }));
    const out = await count(reader, { kinds: [9], "#t": [marker] });
    expect(out[0]).toBe("COUNT");
    expect((out[2] as any).count).toBe(0);
    const mem = await connectAuthed(relay, admin.sk, uniqueIp());
    expect(((await count(mem, { kinds: [9], "#t": [marker] }))[2] as any).count).toBe(1);
    c.close();
    mem.close();
  });

  test("private (not hidden) group: metadata stays readable by anyone, only messages are gated", async () => {
    const admin = newUser();
    const c = await connectAs(relay, uniqueIp());
    const id = await createGroup(c, admin, ["private"]);
    expect((await meta(39000, id))?.tags).toContainEqual(["private"]);
    c.close();
  });

  test("hidden group: 39001-39003 hidden from non-members too, and COUNT of its metadata is 0", async () => {
    const admin = newUser();
    const c = await connectAs(relay, uniqueIp());
    const id = await createGroup(c, admin, ["hidden"]);
    for (const k of [39001, 39002, 39003]) expect(await meta(k, id)).toBeUndefined();
    const r = await count(reader, { kinds: [39000, 39001, 39002, 39003], "#d": [id] });
    expect(r[0] === "CLOSED" || (r[2] as any).count === 0).toBe(true);
    c.close();
  });

  test("hidden group: regenerated 39000 is not live-broadcast to non-members", async () => {
    const admin = newUser();
    const c = await connectAs(relay, uniqueIp());
    const id = await createGroup(c, admin, ["hidden"]);
    const out = await connectAuthed(relay, newUser().sk, uniqueIp());
    const s = nextSub();
    await out.query(s, [{ kinds: [39000], "#d": [id] }], false);
    expect((await c.publish(ctl(admin, 9002, id, [["name", "still hidden"], ["hidden"]]))).ok).toBe(true);
    await out.expectNone((f) => f[0] === "EVENT" && f[1] === s, 300);
    c.close();
    out.close();
  });
});

// ------------------------------------------------------------------ NIP-86 / NIP-98

function rawAuth(ev: Record<string, unknown>) {
  return `Nostr ${Buffer.from(JSON.stringify(ev)).toString("base64")}`;
}
async function post(url: string, body: string, auth: string, ct = "application/nostr+json+rpc") {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": ct, Authorization: auth }, body });
  return { status: res.status, json: await res.json().catch(() => ({})) as any, headers: res.headers };
}

describe("NIP-86 transport and auth", () => {
  test("an auth event with a bad signature is 401", async () => {
    const body = JSON.stringify({ method: "supportedmethods", params: [] });
    const ev = finalizeEvent({ kind: 27235, created_at: now(), content: "", tags: [["u", relay.http], ["method", "POST"], ["payload", sha256(body)]] }, relay.owner.sk);
    const tampered = { ...ev, sig: (ev.sig[0] === "a" ? "b" : "a") + ev.sig.slice(1) };
    expect((await post(`${relay.http}/`, body, rawAuth(tampered))).status).toBe(401);
  });

  test("an auth event of another kind is 401", async () => {
    const body = JSON.stringify({ method: "supportedmethods", params: [] });
    const ev = finalizeEvent({ kind: 27236, created_at: now(), content: "", tags: [["u", relay.http], ["method", "POST"], ["payload", sha256(body)]] }, relay.owner.sk);
    expect((await post(`${relay.http}/`, body, rawAuth(ev))).status).toBe(401);
  });

  test("Content-Type with parameters is still routed to NIP-86", async () => {
    const body = JSON.stringify({ method: "supportedmethods", params: [] });
    const r = await post(`${relay.http}/`, body, nip98(relay.owner.sk, relay.http, "POST", body), "application/nostr+json+rpc; charset=utf-8");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.result)).toBe(true);
  });

  // NIP-98: "The `u` tag MUST be exactly the same as the absolute request URL (including query parameters)" (regression)
  test("NIP-98 u tag is matched against the actual request URL, query included", async () => {
    const body = JSON.stringify({ method: "supportedmethods", params: [] });
    const url = `${relay.http}/?probe=1`;
    expect((await post(url, body, nip98(relay.owner.sk, url, "POST", body))).status).toBe(200);
    expect((await post(url, body, nip98(relay.owner.sk, relay.http, "POST", body))).status).toBe(401);
  });

  test("unknown method: {result, error} with an error string", async () => {
    const r = await nip86(relay, "nosuchmethod");
    expect(typeof r.error).toBe("string");
    expect(r.result ?? null).toBeNull();
  });
});

describe("NIP-86 param and result shapes", () => {
  test("mutating methods return exactly `true`", async () => {
    const u = newUser();
    const ev = note(newUser().sk);
    const ip = uniqueIp("10");
    const calls: [string, unknown[]][] = [
      ["banpubkey", [u.pubkey, "r"]], ["unbanpubkey", [u.pubkey, "r"]], ["allowpubkey", [u.pubkey, "r"]], ["unallowpubkey", [u.pubkey, "r"]],
      ["banevent", [ev.id, "r"]], ["allowevent", [ev.id, "r"]], ["unbanevent", [ev.id, "r"]],
      ["allowkind", [30333]], ["disallowkind", [30333]], ["allowkind", [30333]],
      ["blockip", [ip, "r"]], ["unblockip", [ip]],
    ];
    for (const [m, p] of calls) expect([m, await nip86ok(relay, m, p)]).toEqual([m, true]);
  });

  test("list methods return arrays of the spec'd object shapes, reasons as strings", async () => {
    const u = newUser();
    const ev = note(newUser().sk);
    const ip = uniqueIp("10");
    await nip86ok(relay, "banpubkey", [u.pubkey]);
    await nip86ok(relay, "banevent", [ev.id]);
    await nip86ok(relay, "blockip", [ip]);
    try {
      const bp = (await nip86ok(relay, "listbannedpubkeys")).find((x: any) => x.pubkey === u.pubkey);
      expect(typeof bp.reason === "string" || bp.reason === undefined).toBe(true);
      const be = (await nip86ok(relay, "listbannedevents")).find((x: any) => x.id === ev.id);
      expect(be).toBeDefined();
      expect(typeof be.reason === "string" || be.reason === undefined).toBe(true);
      const bi = (await nip86ok(relay, "listblockedips")).find((x: any) => x.ip === ip);
      expect(bi).toBeDefined();
      expect(typeof bi.reason === "string" || bi.reason === undefined).toBe(true);
      for (const m of ["listallowedkinds", "listdisallowedkinds"]) {
        const r = await nip86ok(relay, m);
        expect(Array.isArray(r) && r.every((k: unknown) => typeof k === "number")).toBe(true);
      }
      expect(Array.isArray(await nip86ok(relay, "listeventsneedingmoderation"))).toBe(true);
      expect(Array.isArray(await nip86ok(relay, "listallowedpubkeys"))).toBe(true);
    } finally {
      await nip86ok(relay, "unbanpubkey", [u.pubkey]);
      await nip86ok(relay, "unbanevent", [ev.id]);
      await nip86ok(relay, "unblockip", [ip]);
    }
  });
});
