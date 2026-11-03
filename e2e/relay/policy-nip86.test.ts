/** NIP-86 relay management API (POST / with application/nostr+json+rpc), and its effect on the live relay. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient, newUser, now, sign } from "../harness/client";
import { api } from "./admin-helpers";
import { connectAs, connectAuthed, fetchIds, nip11, nip86, nip86ok, note, setRole, tryConnect, uniqueIp, waitClosed, withSettings } from "./policy-helpers";

let relay: Relay;
let c: RelayClient;
beforeAll(async () => {
  relay = await startRelay({ overrides: { server: { trustProxy: true } } });
  c = await RelayClient.connect(relay.ws);
});
afterAll(async () => {
  c?.close();
  await relay?.stop();
});

const ALL_METHODS = [
  "banpubkey", "unbanpubkey", "listbannedpubkeys", "allowpubkey", "unallowpubkey", "listallowedpubkeys",
  "listeventsneedingmoderation", "allowevent", "banevent", "unbanevent", "listbannedevents",
  "changerelayname", "changerelaydescription", "changerelayicon",
  "allowkind", "disallowkind", "listallowedkinds", "listdisallowedkinds",
  "blockip", "unblockip", "listblockedips",
];

describe("NIP-98 authorization", () => {
  test("supportedmethods lists every method for the owner", async () => {
    const r = await nip86(relay, "supportedmethods");
    expect(r.status).toBe(200);
    expect([...r.result].sort()).toEqual([...ALL_METHODS].sort());
    expect(r.headers.get("content-type")).toStartWith("application/nostr+json+rpc");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("missing Authorization is 401", async () => {
    const r = await nip86(relay, "supportedmethods", [], { sk: null });
    expect(r.status).toBe(401);
    expect(r.error).toStartWith("unauthorized");
  });

  test("a payload tag is required, and must match the body", async () => {
    const none = await nip86(relay, "supportedmethods", [], { auth: { noPayload: true } });
    expect(none.status).toBe(401);
    expect(none.error).toContain("payload tag required");
    const wrong = await nip86(relay, "supportedmethods", [], { auth: { payload: "ab".repeat(32) } });
    expect(wrong.status).toBe(401);
    expect(wrong.error).toContain("payload mismatch");
  });

  test("wrong u tag, wrong method tag and stale created_at are 401", async () => {
    expect((await nip86(relay, "supportedmethods", [], { auth: { url: "https://elsewhere.example.com" } })).status).toBe(401);
    expect((await nip86(relay, "supportedmethods", [], { auth: { method: "GET" } })).status).toBe(401);
    expect((await nip86(relay, "supportedmethods", [], { auth: { created_at: now() - 3600 } })).status).toBe(401);
  });

  test("the relay's ws:// URL is accepted as the u tag", async () => {
    const r = await nip86(relay, "supportedmethods", [], { auth: { url: relay.ws } });
    expect(r.status).toBe(200);
  });

  test("a replayed authorization is refused", async () => {
    const body = JSON.stringify({ method: "listbannedpubkeys", params: [] });
    const { nip98 } = await import("./policy-helpers");
    const auth = nip98(relay.owner.sk, relay.http, "POST", body);
    const send = () => fetch(`${relay.http}/`, { method: "POST", headers: { "Content-Type": "application/nostr+json+rpc", Authorization: auth }, body });
    expect((await send()).status).toBe(200);
    const again = await send();
    expect(again.status).toBe(401);
    expect((await again.json()).error).toContain("already used");
  });

  test("non-admin pubkey is 403", async () => {
    const r = await nip86(relay, "supportedmethods", [], { sk: newUser().sk });
    expect(r.status).toBe(403);
    expect(r.error).toBe("forbidden: not an admin");
  });

  test("a viewer only sees read methods and is refused write methods", async () => {
    const viewer = newUser();
    await setRole(relay, viewer.pubkey, "viewer");
    const methods: string[] = (await nip86(relay, "supportedmethods", [], { sk: viewer.sk })).result;
    expect(methods).toContain("listbannedpubkeys");
    expect(methods).not.toContain("banpubkey");
    expect(methods).not.toContain("blockip");
    const target = newUser();
    const r = await nip86(relay, "banpubkey", [target.pubkey], { sk: viewer.sk });
    expect(r.status).toBe(403);
    expect(r.error).toBe("forbidden: missing permission users.ban");
    expect((await c.publish(note(target.sk))).ok).toBe(true);
  });

  test("unknown methods, bad params and malformed JSON are errors", async () => {
    expect((await nip86(relay, "frobnicate")).error).toBe("unsupported method: frobnicate");
    expect((await nip86(relay, "banpubkey", ["not-a-pubkey"])).error).toBe("invalid pubkey");
    expect((await nip86(relay, "banpubkey", [])).error).toBe("missing param: pubkey");
    expect((await nip86(relay, "allowkind", ["7"])).error).toBe("invalid kind");
    const notArray = await nip86(relay, "x", [], { rawBody: JSON.stringify({ method: "listbannedpubkeys", params: {} }) });
    expect(notArray.status).toBe(400);
    const broken = await nip86(relay, "x", [], { rawBody: "{not json" });
    expect(broken.status).toBe(400);
  });
});

describe("pubkey methods affect publishing", () => {
  test("banpubkey blocks publishing and is listed with its reason; unbanpubkey restores", async () => {
    const u = newUser();
    expect(await nip86ok(relay, "banpubkey", [u.pubkey, "nip86 spam"])).toBe(true);
    const r = await c.publish(note(u.sk));
    expect(r).toEqual({ ok: false, message: "blocked: pubkey is banned (nip86 spam)" });
    const banned = await nip86ok(relay, "listbannedpubkeys");
    expect(banned).toContainEqual({ pubkey: u.pubkey, reason: "nip86 spam" });
    expect(await nip86ok(relay, "unbanpubkey", [u.pubkey])).toBe(true);
    expect((await c.publish(note(u.sk))).ok).toBe(true);
    expect((await nip86ok(relay, "listbannedpubkeys")).some((b: any) => b.pubkey === u.pubkey)).toBe(false);
  });

  test("banpubkey disconnects the pubkey's authenticated sessions", async () => {
    const u = newUser();
    const s = await connectAuthed(relay, u.sk);
    await nip86ok(relay, "banpubkey", [u.pubkey]);
    await waitClosed(s);
  });

  test("allowpubkey admits a pubkey on a whitelist relay; unallowpubkey removes it", async () => {
    const u = newUser();
    await withSettings(relay, { access: { mode: "whitelist" } }, async () => {
      expect((await c.publish(note(u.sk))).message).toStartWith("restricted:");
      await nip86ok(relay, "allowpubkey", [u.pubkey, "friend"]);
      expect((await c.publish(note(u.sk))).ok).toBe(true);
      expect((await nip86ok(relay, "listallowedpubkeys")).map((x: any) => x.pubkey)).toContain(u.pubkey);
      await nip86ok(relay, "unallowpubkey", [u.pubkey]);
      expect((await c.publish(note(u.sk))).message).toStartWith("restricted:");
    });
  });

  test("allowpubkey also lifts a ban; banpubkey also removes from the allow list", async () => {
    const u = newUser();
    await nip86ok(relay, "banpubkey", [u.pubkey]);
    await nip86ok(relay, "allowpubkey", [u.pubkey]);
    expect((await c.publish(note(u.sk))).ok).toBe(true);
    await nip86ok(relay, "banpubkey", [u.pubkey]);
    expect((await nip86ok(relay, "listallowedpubkeys")).map((x: any) => x.pubkey)).not.toContain(u.pubkey);
    expect((await c.publish(note(u.sk))).ok).toBe(false);
  });

  test("banpubkey cannot ban the relay owner", async () => {
    const r = await nip86(relay, "banpubkey", [relay.owner.pubkey]);
    expect(r.error).toBeTruthy();
    expect((await c.publish(note(relay.owner.sk))).ok).toBe(true);
  });

  test("pubkeys may be given as npub", async () => {
    const { nip19 } = await import("nostr-tools");
    const u = newUser();
    await nip86ok(relay, "banpubkey", [nip19.npubEncode(u.pubkey)]);
    expect((await c.publish(note(u.sk))).message).toStartWith("blocked:");
  });
});

describe("event methods", () => {
  test("banevent deletes the event and blocks re-publishing; unbanevent lifts the block", async () => {
    const u = newUser();
    const ev = note(u.sk);
    expect((await c.publish(ev)).ok).toBe(true);
    await nip86ok(relay, "banevent", [ev.id, "illegal"]);
    expect(await fetchIds(c, [ev.id])).toEqual([]);
    expect(await nip86ok(relay, "listbannedevents")).toContainEqual({ id: ev.id, reason: "illegal" });
    expect(await c.publish(ev)).toEqual({ ok: false, message: "blocked: this event was banned by the relay operator" });
    await nip86ok(relay, "unbanevent", [ev.id]);
    expect((await c.publish(ev)).ok).toBe(true);
    expect(await fetchIds(c, [ev.id])).toEqual([ev.id]);
  });

  test("a moderator cannot lift an event ban placed by the owner", async () => {
    const mod = newUser();
    await setRole(relay, mod.pubkey, "moderator");
    const ev = note(newUser().sk);
    await c.publish(ev);
    await nip86ok(relay, "banevent", [ev.id]);
    const r = await nip86(relay, "unbanevent", [ev.id], { sk: mod.sk });
    expect(r.error).toBe("forbidden: this event was banned by a user with role owner");
    const r2 = await nip86(relay, "allowevent", [ev.id], { sk: mod.sk });
    expect(r2.error).toBe("forbidden: this event was banned by a user with role owner");
    expect((await c.publish(ev)).ok).toBe(false);
  });

  test("allowevent lifts an event ban too", async () => {
    const u = newUser();
    const ev = note(u.sk);
    await c.publish(ev);
    await nip86ok(relay, "banevent", [ev.id]);
    await nip86ok(relay, "allowevent", [ev.id]);
    expect((await c.publish(ev)).ok).toBe(true);
  });

  test("listeventsneedingmoderation lists reported events; allowevent dismisses them", async () => {
    const author = newUser();
    const reporter = newUser();
    const ev = note(author.sk, "reportable");
    await c.publish(ev);
    const report = sign(reporter.sk, { kind: 1984, content: "this is spam", tags: [["e", ev.id, "spam"], ["p", author.pubkey]] });
    expect((await c.publish(report)).ok).toBe(true);
    let listed: any[] = [];
    for (let i = 0; i < 100; i++) {
      listed = await nip86ok(relay, "listeventsneedingmoderation");
      if (listed.some((x) => x.id === ev.id)) break;
      await Bun.sleep(20);
    }
    const row = listed.find((x) => x.id === ev.id);
    expect(row).toBeDefined();
    expect(row.reason).toContain("spam");
    await nip86ok(relay, "allowevent", [ev.id]);
    expect((await nip86ok(relay, "listeventsneedingmoderation")).some((x: any) => x.id === ev.id)).toBe(false);
  });

  test("banevent of an unknown id is allowed for the owner and blocks it before it's ever published", async () => {
    const ev = note(newUser().sk);
    await nip86ok(relay, "banevent", [ev.id]);
    expect((await c.publish(ev)).message).toBe("blocked: this event was banned by the relay operator");
  });
});

describe("kind methods", () => {
  test("disallowkind blocks a kind; allowkind unblocks it; lists reflect the change", async () => {
    const u = newUser();
    await nip86ok(relay, "disallowkind", [30078]);
    try {
      expect(await nip86ok(relay, "listdisallowedkinds")).toContain(30078);
      const ev = sign(u.sk, { kind: 30078, content: "x", tags: [["d", "app"]] });
      expect((await c.publish(ev)).message).toBe("blocked: kind 30078 is not allowed on this relay");
    } finally {
      await nip86ok(relay, "allowkind", [30078]);
    }
    expect(await nip86ok(relay, "listdisallowedkinds")).not.toContain(30078);
    expect((await c.publish(sign(u.sk, { kind: 30078, content: "y", tags: [["d", "app"]] }))).ok).toBe(true);
  });

  test("with an allow list in use, allowkind extends it and disallowkind shrinks it", async () => {
    const u = newUser();
    await withSettings(relay, { moderation: { kindAllowlist: [1] } }, async () => {
      expect((await c.publish(sign(u.sk, { kind: 7, content: "+" }))).ok).toBe(false);
      await nip86ok(relay, "allowkind", [7]);
      expect(await nip86ok(relay, "listallowedkinds")).toEqual([1, 7]);
      expect((await c.publish(sign(u.sk, { kind: 7, content: "+" }))).ok).toBe(true);
      await nip86ok(relay, "disallowkind", [7]);
      expect((await c.publish(sign(u.sk, { kind: 7, content: "-" }))).ok).toBe(false);
    });
  });

  test("disallowkind of the only allow-listed kind never opens the relay to every kind (regression)", async () => {
    const u = newUser();
    await withSettings(relay, { moderation: { kindAllowlist: [1] } }, async () => {
      expect((await c.publish(sign(u.sk, { kind: 7, content: "+" }))).ok).toBe(false);
      await nip86ok(relay, "disallowkind", [1]);
      // neither the disallowed kind nor any other kind may become publishable by disallowing a kind
      expect((await c.publish(note(u.sk))).ok).toBe(false);
      expect((await c.publish(sign(u.sk, { kind: 7, content: "+" }))).ok).toBe(false);
    });
  });
});

describe("relay info methods", () => {
  test("changerelayname / description / icon update NIP-11", async () => {
    await nip86ok(relay, "changerelayname", ["NIP-86 named"]);
    await nip86ok(relay, "changerelaydescription", ["described via nip86"]);
    await nip86ok(relay, "changerelayicon", ["https://example.com/icon.png"]);
    const d = await nip11(relay);
    expect(d.name).toBe("NIP-86 named");
    expect(d.description).toBe("described via nip86");
    expect(d.icon).toBe("https://example.com/icon.png");
  });

  test("changerelayicon refuses a non-http(s) URL", async () => {
    const r = await nip86(relay, "changerelayicon", ["javascript:alert(1)"]);
    // a readable validation message, not raw zod JSON
    expect(r.error).toStartWith("invalid:");
    expect(r.error).not.toContain("[{");
    expect((await nip11(relay)).icon).not.toBe("javascript:alert(1)");
  });
});

describe("IP methods", () => {
  test("blockip disconnects and refuses that address; listblockedips shows it; unblockip restores", async () => {
    const ip = uniqueIp();
    const open = await connectAs(relay, ip);
    await nip86ok(relay, "blockip", [ip, "abuse"]);
    await waitClosed(open);
    expect((await tryConnect(relay, ip)).closed).toBe(true);
    expect(await nip86ok(relay, "listblockedips")).toContainEqual({ ip, reason: "abuse" });
    await nip86ok(relay, "unblockip", [ip]);
    const ok = await tryConnect(relay, ip);
    expect(ok.closed).toBe(false);
    ok.client.close();
  });

  test("blockip with a CIDR closes open connections inside the range", async () => {
    const net = `10.252.${Math.floor(Math.random() * 250)}`;
    const open = await connectAs(relay, `${net}.9`);
    await nip86ok(relay, "blockip", [`${net}.0/24`]);
    try {
      await waitClosed(open);
    } finally {
      await nip86ok(relay, "unblockip", [`${net}.0/24`]);
    }
  });

  test("regression: an IPv6 rule is stored in one spelling, so any spelling unblocks it and it disconnects", async () => {
    const tail = Math.floor(Math.random() * 0xfff0 + 1).toString(16);
    const canonical = `2001:db8::${tail}`;
    const open = await connectAs(relay, canonical);
    await nip86ok(relay, "blockip", [`2001:DB8:0:0::${tail.toUpperCase()}`, "v6"]);
    await waitClosed(open);
    expect(await nip86ok(relay, "listblockedips")).toContainEqual({ ip: canonical, reason: "v6" });
    // the REST API sees the same rule, and a second spelling doesn't add another
    expect((await api(relay.http, relay.owner.sk, "POST", "/ip-rules", { cidr: `2001:0db8::${tail}`, action: "block", reason: "v6" })).body.cidr).toBe(canonical);
    expect((await nip86ok(relay, "listblockedips")).filter((r: { ip: string }) => r.ip.startsWith("2001:db8::")).length).toBe(1);
    await nip86ok(relay, "unblockip", [`2001:0DB8:0000::${tail}`]);
    expect((await nip86ok(relay, "listblockedips")).some((r: { ip: string }) => r.ip === canonical)).toBe(false);
    const ok = await tryConnect(relay, canonical);
    expect(ok.closed).toBe(false);
    ok.client.close();
  });

  test("blockip refuses an invalid address", async () => {
    expect((await nip86(relay, "blockip", ["999.1.1.1"])).error).toBe("invalid ip");
  });
});
