import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { finalizeEvent } from "nostr-tools/pure";
import { keypair, now, setup, type Keypair } from "./fakes";

function nip98(kp: Keypair, url: string, method = "POST", created_at = now(), body?: string) {
  const tags = [["u", url], ["method", method]];
  if (body !== undefined) tags.push(["payload", createHash("sha256").update(body).digest("hex")]);
  const ev = finalizeEvent({ kind: 27235, created_at, content: "", tags }, kp.sk);
  return `Nostr ${btoa(JSON.stringify(ev))}`;
}

describe("HTTP", () => {
  test("NIP-11 document with CORS", async () => {
    const { relay } = await setup({ settings: { info: { name: "Test Relay" }, limits: { minPowDifficulty: 4 }, access: { mode: "whitelist" } } });
    const res = await relay.http.request("/", { headers: { Accept: "application/nostr+json" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const doc = (await res.json()) as Record<string, any>;
    expect(doc.name).toBe("Test Relay");
    expect(doc.self).toBe(relay.pubkey);
    expect(doc.supported_nips).toContain(77);
    expect(doc.limitation.min_pow_difficulty).toBe(4);
    expect(doc.limitation.restricted_writes).toBe(true);
    expect(doc.limitation.payment_required).toBe(false);
    expect(relay.nip11()).toEqual(doc);
    expect((await relay.http.request("/", { method: "OPTIONS" })).status).toBe(204);
    expect((await relay.http.request("/")).status).toBe(404); // falls through to other apps
  });

  test("NIP-05 nostr.json", async () => {
    const op = keypair();
    const alice = keypair();
    const { relay, stores } = await setup({ settings: { info: { pubkey: op.pk }, nip05: { enabled: true, relays: ["wss://extra.example.com"] } } });
    await stores.users.upsert(alice.pk, { nip05Name: "alice" });
    const res = await relay.http.request("/.well-known/nostr.json?name=alice");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ names: { alice: alice.pk }, relays: { [alice.pk]: ["wss://relay.example.com", "wss://extra.example.com"] } });
    const root = (await (await relay.http.request("/.well-known/nostr.json?name=_")).json()) as { names: Record<string, string> };
    expect(root.names._).toBe(op.pk);
    expect(((await (await relay.http.request("/.well-known/nostr.json?name=bob")).json()) as { names: object }).names).toEqual({});
  });

  test("POST /invite/redeem with NIP-98", async () => {
    const { relay, stores } = await setup({ settings: { access: { mode: "invite" } } });
    const inv = await stores.invites.create({ createdBy: "admin", maxUses: 1 });
    const kp = keypair();
    const url = "https://relay.example.com/invite/redeem";
    const body = (code: string) => JSON.stringify({ code });
    const post = (auth: string | undefined, code = inv.code) =>
      relay.http.request("/invite/redeem", { method: "POST", headers: auth ? { Authorization: auth } : {}, body: body(code) });

    expect((await post(undefined)).status).toBe(401);
    expect((await post(nip98(kp, "https://evil.example.com/invite/redeem", "POST", now(), body(inv.code)))).status).toBe(401);
    expect((await post(nip98(kp, url, "GET", now(), body(inv.code)))).status).toBe(401);
    expect((await post(nip98(kp, url, "POST", now() - 120, body(inv.code)))).status).toBe(401);
    expect((await post(nip98(kp, url))).status).toBe(401); // POST without a payload tag
    const used = nip98(kp, url, "POST", now() - 1, body("wrong"));
    expect((await post(used, "wrong")).status).toBe(400);
    expect((await post(used, "wrong")).status).toBe(401); // replayed auth event
    const ok = await post(nip98(kp, url, "POST", now(), body(inv.code)));
    expect(ok.status).toBe(200);
    expect((await stores.users.get(kp.pk))?.allowed).toBe(true);
    expect((await post(nip98(keypair(), url, "POST", now(), body(inv.code)))).status).toBe(400); // exhausted
  });
});
