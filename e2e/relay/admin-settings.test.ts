/** Settings validation + live effect + persistence across a restart; invites gating an invite-only relay; IP rules. */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { startRelay, type Relay } from "../harness/relay";
import { RelayClient, pngBytes, sha256 } from "../harness/client";
import { api, bauth, bootRelay, nip98, removeDir, signEvent, upload, user, waitUntil } from "./admin-helpers";

let relay: Relay;
const clients: RelayClient[] = [];
beforeAll(async () => {
  relay = await startRelay();
});
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});
afterAll(() => relay?.stop());

const owner = () => relay.owner.sk;
const patch = (body: unknown, base = relay.http, sk = owner()) => api(base, sk, "PATCH", "/settings", body);
async function client(ws = relay.ws) {
  const c = await RelayClient.connect(ws);
  clients.push(c);
  return c;
}

describe("settings", () => {
  test("GET returns the full runtime settings", async () => {
    const r = await api(relay.http, owner(), "GET", "/settings");
    expect(r.status).toBe(200);
    expect(Object.keys(r.body.settings).sort()).toEqual(["access", "blossom", "groups", "info", "limits", "moderation", "nip05", "retention"]);
    expect(r.body.settings.access.mode).toBe("public");
  });

  test("validation errors are 400 with a message naming the field", async () => {
    const unknown = await patch({ nonsense: { a: 1 } });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ error: "unknown settings section: nonsense", code: "validation" });
    const type = await patch({ limits: { maxSubscriptions: "lots" } });
    expect(type.status).toBe(400);
    expect(type.body.error).toContain("limits.maxSubscriptions");
    const min = await patch({ limits: { maxSubscriptions: 0 } });
    expect(min.status).toBe(400);
    const url = await patch({ info: { icon: "javascript:alert(1)" } });
    expect(url.status).toBe(400);
    expect(url.body.error).toContain("must be an http(s) URL");
    const mode = await patch({ access: { mode: "everyone" } });
    expect(mode.status).toBe(400);
    expect(mode.body.error).toContain("access.mode");
    const regex = await patch({ moderation: { wordFilters: [{ id: "r", pattern: "(a+)+$", isRegex: true, kinds: [], action: "reject", enabled: true }] } });
    expect(regex.status).toBe(400);
    expect(regex.body.error).toContain("invalid word filter regex");
    const badJson = await api(relay.http, owner(), "PATCH", "/settings", undefined, { raw: "{" });
    expect(badJson.status).toBe(400);
    expect(badJson.body.code).toBe("invalid_json");
    // nothing changed
    expect((await api(relay.http, owner(), "GET", "/settings")).body.settings.limits.maxSubscriptions).toBe(30);
  });

  test("regression: pubkey settings are stored as hex (npub accepted), anything else refused", async () => {
    const { pubkey, npub } = relay.owner;
    const r = await patch({ info: { pubkey: npub }, retention: { rules: [{ id: "x", enabled: false, maxAgeDays: 30, exemptPubkeys: [npub, pubkey.toUpperCase()] }] } });
    expect(r.status).toBe(200);
    expect(r.body.settings.info.pubkey).toBe(pubkey);
    expect(r.body.settings.retention.rules[0].exemptPubkeys).toEqual([pubkey]);
    const nip11 = await (await fetch(relay.http, { headers: { Accept: "application/nostr+json" } })).json();
    expect(nip11.pubkey).toBe(pubkey);
    const bad = await patch({ info: { pubkey: "npub1typo" } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("info.pubkey");
    const badExempt = await patch({ retention: { rules: [{ id: "y", exemptPubkeys: ["alice"] }] } });
    expect(badExempt.status).toBe(400);
    expect(badExempt.body.error).toContain("retention.rules.0.exemptPubkeys.0");
    expect((await patch({ info: { pubkey: "" }, retention: { rules: [] } })).body.settings.info.pubkey).toBe("");
  });

  test("a patch is deep-merged, audited and takes effect on NIP-11 and the ws pipeline", async () => {
    const name = `relay ${Math.floor(Math.random() * 1e6)}`;
    const r = await patch({ info: { name }, moderation: { kindBlocklist: [30023] } });
    expect(r.status).toBe(200);
    expect(r.body.settings.info.name).toBe(name);
    expect(r.body.settings.info.description).toBe("A beamhop nostr relay"); // untouched sibling kept
    try {
      const nip11 = await (await fetch(relay.http, { headers: { Accept: "application/nostr+json" } })).json();
      expect(nip11.name).toBe(name);
      const c = await client();
      const res = await c.publish(signEvent(user().sk, { kind: 30023, content: "long", tags: [["d", "x"]] }));
      expect(res.ok).toBe(false);
      expect(res.message).toContain("blocked");
      const audit = await api(relay.http, owner(), "GET", "/audit?action=settings.update");
      expect(audit.body.items[0].details.patch).toEqual({ info: { name }, moderation: { kindBlocklist: [30023] } });
      expect(audit.body.items[0].actor).toBe(relay.owner.pubkey);
    } finally {
      await patch({ moderation: { kindBlocklist: [] } });
    }
  });

  test("a reject word filter refuses matching events", async () => {
    const word = `nope${Math.floor(Math.random() * 1e9)}`;
    await patch({ moderation: { wordFilters: [{ id: "w", pattern: word, isRegex: false, kinds: [1], action: "reject", enabled: true }] } });
    try {
      const c = await client();
      expect((await c.publish(signEvent(user().sk, { kind: 1, content: `say ${word}` }))).ok).toBe(false);
      expect((await c.publish(signEvent(user().sk, { kind: 7, content: word }))).ok).toBe(true);
    } finally {
      await patch({ moderation: { wordFilters: [] } });
    }
  });
});

describe("persistence across a restart (same data dir)", () => {
  test("settings, roles, bans, invites, blobs and used delete tokens survive", async () => {
    const first = await bootRelay();
    const dir = first.dir;
    let second: Awaited<ReturnType<typeof bootRelay>> | undefined;
    try {
      const sk = first.owner.sk;
      expect((await patch({ info: { name: "persisted" }, limits: { maxSubscriptions: 7 }, blossom: { requireApproval: true } }, first.http, sk)).status).toBe(200);
      const mod = user();
      const bad = user();
      expect((await api(first.http, sk, "PUT", `/users/${mod.pubkey}/role`, { role: "moderator" })).status).toBe(200);
      expect((await api(first.http, sk, "POST", `/users/${bad.pubkey}/ban`, { reason: "gone" })).status).toBe(200);
      const inv = await api(first.http, sk, "POST", "/invites", { note: "keep me" });
      const code = inv.body.items[0].code;
      // a blob, approved, then deleted with a token that must stay used after the restart
      expect((await patch({ blossom: { requireApproval: false } }, first.http, sk)).status).toBe(200);
      const u = user();
      const bytes = pngBytes();
      expect((await upload(first.http, u.sk, bytes)).status).toBe(201);
      const kept = await upload(first.http, u.sk, pngBytes());
      const delToken = bauth(u.sk, "delete", { hashes: [sha256(bytes)] });
      expect((await fetch(`${first.http}/${sha256(bytes)}`, { method: "DELETE", headers: { Authorization: delToken } })).status).toBe(200);
      expect((await patch({ blossom: { requireApproval: true } }, first.http, sk)).status).toBe(200);
      await first.stop();

      second = await bootRelay({ dir, ownerSk: sk });
      const s = (await api(second.http, sk, "GET", "/settings")).body.settings;
      expect(s.info.name).toBe("persisted");
      expect(s.limits.maxSubscriptions).toBe(7);
      expect(s.blossom.requireApproval).toBe(true);
      expect((await api(second.http, mod.sk, "GET", "/auth/me")).body.role).toBe("moderator");
      expect((await api(second.http, sk, "GET", `/users/${bad.pubkey}`)).body).toMatchObject({ status: "banned", banReason: "gone" });
      const c = await client(second.ws);
      expect((await c.publish(signEvent(bad.sk, { kind: 1, content: "x" }))).ok).toBe(false);
      const invites = await api(second.http, sk, "GET", "/invites");
      expect(invites.body.items.find((i: any) => i.code === code)?.note).toBe("keep me");
      // the blob is still served, from the same bytes
      const got = await fetch(`${second.http}/${kept.sha}`);
      expect(got.status).toBe(200);
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(kept.bytes);
      // re-upload with a fresh token, then replay the pre-restart delete token
      await patch({ blossom: { requireApproval: false } }, second.http, sk);
      while (Math.floor(Date.now() / 1000) <= JSON.parse(Buffer.from(delToken.slice(6), "base64").toString()).created_at) await Bun.sleep(20);
      expect((await upload(second.http, u.sk, bytes)).status).toBe(201);
      const replay = await fetch(`${second.http}/${sha256(bytes)}`, { method: "DELETE", headers: { Authorization: delToken } });
      expect(replay.status).toBe(401);
      expect((await fetch(`${second.http}/${sha256(bytes)}`)).status).toBe(200);
    } finally {
      await first.stop();
      await second?.stop();
      removeDir(dir);
    }
  }, 30000);
});

describe("invites", () => {
  const redeem = async (sk: Uint8Array, code: string) => {
    const url = `${relay.http}/invite/redeem`;
    const body = JSON.stringify({ code });
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: nip98(sk, url, "POST", body) }, body });
    return { status: r.status, body: await r.json() };
  };

  test("invite-only relay: strangers refused, redeeming a code makes them a member", async () => {
    expect((await patch({ access: { mode: "invite" } })).status).toBe(200);
    try {
      const u = user();
      const c = await client();
      const refused = await c.publish(signEvent(u.sk, { kind: 1, content: "let me in" }));
      expect(refused).toEqual({ ok: false, message: "restricted: this relay is invite-only; redeem an invite code first" });
      const created = await api(relay.http, owner(), "POST", "/invites", { count: 2, maxUses: 1, note: "e2e" });
      expect(created.status).toBe(201);
      expect(created.body.items.length).toBe(2);
      const inv = created.body.items[0];
      expect(inv).toMatchObject({ maxUses: 1, uses: 0, note: "e2e", createdBy: relay.owner.pubkey });
      expect(inv.url).toBe(`${relay.http}/invite/${inv.code}`);
      const page = await fetch(inv.url);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(inv.code);
      const ok = await redeem(u.sk, inv.code);
      expect(ok).toEqual({ status: 200, body: { ok: true, pubkey: u.pubkey } });
      expect((await c.publish(signEvent(u.sk, { kind: 1, content: "in!" }))).ok).toBe(true);
      const rec = await api(relay.http, owner(), "GET", `/users/${u.pubkey}`);
      expect(rec.body).toMatchObject({ allowed: true, invitedBy: relay.owner.pubkey });
      const listed = await api(relay.http, owner(), "GET", "/invites");
      expect(listed.body.items.find((i: any) => i.code === inv.code).uses).toBe(1);
      // exhausted for the next person; already-members get a friendly answer
      const second = await redeem(user().sk, inv.code);
      expect(second.status).toBe(400);
      expect((await redeem(u.sk, inv.code)).body.alreadyMember).toBe(true);
      const audit = await api(relay.http, owner(), "GET", "/audit?action=invite.create");
      expect(audit.body.items[0].details.codes).toEqual(created.body.items.map((i: any) => i.code));
    } finally {
      await patch({ access: { mode: "public" } });
    }
  });

  test("revoked, expired and unknown codes don't redeem; unlimited codes do", async () => {
    const [inv] = (await api(relay.http, owner(), "POST", "/invites", {})).body.items;
    expect((await api(relay.http, owner(), "DELETE", `/invites/${inv.code}`)).body).toEqual({ ok: true });
    expect((await api(relay.http, owner(), "DELETE", `/invites/${inv.code}`)).status).toBe(404);
    expect((await redeem(user().sk, inv.code)).status).toBe(400);
    const [expired] = (await api(relay.http, owner(), "POST", "/invites", { expiresAt: Math.floor(Date.now() / 1000) - 10 })).body.items;
    expect((await redeem(user().sk, expired.code)).status).toBe(400);
    expect((await redeem(user().sk, "no-such-code")).status).toBe(400);
    const [unlimited] = (await api(relay.http, owner(), "POST", "/invites", { maxUses: 0 })).body.items;
    for (let i = 0; i < 3; i++) expect((await redeem(user().sk, unlimited.code)).status).toBe(200);
    expect((await api(relay.http, owner(), "POST", "/invites", { count: 101 })).status).toBe(400);
  });

  test("redeem requires valid NIP-98 with a payload; banned users can't redeem", async () => {
    const [inv] = (await api(relay.http, owner(), "POST", "/invites", { maxUses: 0 })).body.items;
    const url = `${relay.http}/invite/redeem`;
    const body = JSON.stringify({ code: inv.code });
    const noAuth = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    expect(noAuth.status).toBe(401);
    const noPayload = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: nip98(user().sk, url, "POST") }, body });
    expect(noPayload.status).toBe(401);
    const banned = user();
    await api(relay.http, owner(), "POST", `/users/${banned.pubkey}/ban`, {});
    expect((await redeem(banned.sk, inv.code)).status).toBe(403);
  });
});

describe("IP rules", () => {
  test("validation: bad CIDR, broad allow needs confirmation, delete of unknown rule", async () => {
    expect((await api(relay.http, owner(), "POST", "/ip-rules", { cidr: "999.1.1.1", action: "block" })).status).toBe(400);
    expect((await api(relay.http, owner(), "POST", "/ip-rules", { cidr: "10.0.0.0/8", action: "maybe" })).status).toBe(400);
    const broad = await api(relay.http, owner(), "POST", "/ip-rules", { cidr: "10.0.0.0/8", action: "allow" });
    expect(broad.status).toBe(400);
    expect(broad.body.code).toBe("broad_allow_rule");
    const confirmed = await api(relay.http, owner(), "POST", "/ip-rules", { cidr: "10.0.0.0/8", action: "allow", reason: "lan", confirmBroad: true });
    expect(confirmed.status).toBe(201);
    expect(confirmed.body).toMatchObject({ cidr: "10.0.0.0/8", action: "allow", reason: "lan" });
    const list = await api(relay.http, owner(), "GET", "/ip-rules");
    expect(list.body.items.map((r: any) => r.cidr)).toContain("10.0.0.0/8");
    expect((await api(relay.http, owner(), "DELETE", `/ip-rules/${encodeURIComponent("10.0.0.0/8")}`)).body).toEqual({ ok: true });
    expect((await api(relay.http, owner(), "DELETE", `/ip-rules/${encodeURIComponent("10.0.0.0/8")}`)).status).toBe(404);
    const audit = await api(relay.http, owner(), "GET", "/audit?action=ip.add&target=10.0.0.0/8");
    expect(audit.body.items[0].details).toMatchObject({ action: "allow", confirmedBroad: true });
  });

  test("blocking our address drops the open connection and refuses new ones until removed", async () => {
    const c = await client();
    const added = await api(relay.http, owner(), "POST", "/ip-rules", { cidr: "127.0.0.1", action: "block", reason: "e2e block" });
    try {
      expect(added.status).toBe(201);
      await waitUntil(async () => c.closed);
      expect(c.closeCode).toBe(1008);
      const again = await client();
      const notice = await again.waitFor((f) => f[0] === "NOTICE");
      expect(notice[1]).toBe("blocked: e2e block");
      await waitUntil(async () => again.closed);
      const audit = await api(relay.http, owner(), "GET", "/audit?action=ip.add&target=127.0.0.1");
      expect(audit.body.items[0].details.disconnected).toBeGreaterThanOrEqual(1);
    } finally {
      await api(relay.http, owner(), "DELETE", "/ip-rules/127.0.0.1");
    }
    const ok = await client();
    expect((await ok.publish(signEvent(user().sk, { kind: 1, content: "unblocked" }))).ok).toBe(true);
  });
});
