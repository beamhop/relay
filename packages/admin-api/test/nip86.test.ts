import { describe, expect, test } from "bun:test";
import { nip19 } from "nostr-tools";
import { createHarness, newKey, nip98Header, PUBLIC_URL, type Key } from "./fakes";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const rpc = (h: Harness, k: Key | null, body: unknown, opts: { url?: string; payloadBody?: string; noPayload?: boolean } = {}) => {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/nostr+json+rpc" };
  if (k) {
    headers.authorization = opts.noPayload
      ? nip98Header(k, opts.url ?? PUBLIC_URL, "POST")
      : nip98Header(k, opts.url ?? PUBLIC_URL, "POST", opts.payloadBody ?? text);
  }
  return h.api.nip86(new Request(`${PUBLIC_URL}/`, { method: "POST", body: text, headers }));
};

describe("NIP-86", () => {
  test("banpubkey with valid auth bans, audits and lists", async () => {
    const h = await createHarness();
    const target = newKey();
    const res = await rpc(h, h.owner, { method: "banpubkey", params: [target.pk, "spam"] });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/nostr+json+rpc");
    expect(await res.json()).toEqual({ result: true });
    const u = await h.stores.users.get(target.pk);
    expect(u).toMatchObject({ status: "banned", banReason: "spam" });
    expect(h.audit.entries.some((e) => e.action === "user.ban" && e.details.via === "nip86" && e.target === target.pk && e.actor === h.owner.pk)).toBe(true);
    const list = (await (await rpc(h, h.owner, { method: "listbannedpubkeys", params: [] })).json()) as { result: { pubkey: string; reason?: string }[] };
    expect(list.result).toEqual([{ pubkey: target.pk, reason: "spam" }]);
  });

  test("accepts ws url variant and trailing slash; npub params", async () => {
    const h = await createHarness();
    const target = newKey();
    const res = await rpc(h, h.owner, { method: "banpubkey", params: [nip19.npubEncode(target.pk)] }, { url: "wss://relay.test/" });
    expect(((await res.json()) as { result: unknown }).result).toBe(true);
  });

  test("auth failures: missing, wrong url, missing/mismatched payload, non-admin, insufficient role", async () => {
    const h = await createHarness();
    const body = { method: "banpubkey", params: [newKey().pk] };
    expect((await rpc(h, null, body)).status).toBe(401);
    expect((await rpc(h, h.owner, body, { url: "https://evil.test" })).status).toBe(401);
    expect((await rpc(h, h.owner, body, { noPayload: true })).status).toBe(401);
    expect((await rpc(h, h.owner, body, { payloadBody: "{}" })).status).toBe(401);
    expect((await rpc(h, newKey(), body)).status).toBe(403);
    const viewer = await h.addAdmin("viewer");
    expect((await rpc(h, viewer, body)).status).toBe(403);
    expect((await rpc(h, viewer, { method: "listbannedpubkeys" })).status).toBe(200);
    expect(h.audit.entries.filter((e) => e.details.via === "nip86").length).toBe(0);
  });

  test("replayed authorization is rejected", async () => {
    const h = await createHarness();
    const text = JSON.stringify({ method: "supportedmethods", params: [] });
    const auth = nip98Header(h.owner, PUBLIC_URL, "POST", text);
    const send = () => h.api.nip86(new Request(PUBLIC_URL, { method: "POST", body: text, headers: { authorization: auth } }));
    const first = (await (await send()).json()) as { result: string[] };
    expect(first.result).toContain("banpubkey");
    expect((await send()).status).toBe(401);
  });

  test("unknown method, kinds, ips, relay info, banevent", async () => {
    const h = await createHarness();
    expect(await (await rpc(h, h.owner, { method: "nope" })).json()).toMatchObject({ result: null, error: expect.stringContaining("unsupported") });
    expect(await (await rpc(h, h.owner, { method: "disallowkind", params: [4] })).json()).toEqual({ result: true });
    expect(h.settings.get().moderation.kindBlocklist).toEqual([4]);
    expect(await (await rpc(h, h.owner, { method: "allowkind", params: [4] })).json()).toEqual({ result: true });
    expect(h.settings.get().moderation.kindBlocklist).toEqual([]);
    expect(await (await rpc(h, h.owner, { method: "blockip", params: ["5.6.7.8", "abuse"] })).json()).toEqual({ result: true });
    expect(((await (await rpc(h, h.owner, { method: "listblockedips" })).json()) as { result: { ip: string }[] }).result[0].ip).toContain("5.6.7.8");
    expect(await (await rpc(h, h.owner, { method: "unblockip", params: ["5.6.7.8"] })).json()).toEqual({ result: true });
    expect(await (await rpc(h, h.owner, { method: "changerelayname", params: ["New name"] })).json()).toEqual({ result: true });
    expect(h.settings.get().info.name).toBe("New name");
    expect(await (await rpc(h, h.owner, { method: "blockip", params: ["not an ip"] })).json()).toMatchObject({ result: null, error: expect.any(String) });
    const id = "f".repeat(64);
    expect(await (await rpc(h, h.owner, { method: "banevent", params: [id, "bad"] })).json()).toEqual({ result: true });
    expect(((await (await rpc(h, h.owner, { method: "listbannedevents" })).json()) as { result: { id: string }[] }).result).toMatchObject([{ id, reason: "bad" }]);
  });

  test("supportedmethods lists the other methods, filtered by the caller's role", async () => {
    const h = await createHarness();
    const all = ((await (await rpc(h, h.owner, { method: "supportedmethods" })).json()) as { result: string[] }).result;
    expect(all).not.toContain("supportedmethods");
    expect(all).toEqual(expect.arrayContaining(["banpubkey", "unbanevent", "listdisallowedkinds", "blockip"]));
    const viewer = await h.addAdmin("viewer");
    const some = ((await (await rpc(h, viewer, { method: "supportedmethods" })).json()) as { result: string[] }).result;
    expect(some).toContain("listbannedpubkeys");
    expect(some).not.toContain("banpubkey");
  });

  test("banpubkey removes from the allow list; allowpubkey lifts a ban; unbanpubkey doesn't allow or unmute", async () => {
    const h = await createHarness();
    const target = newKey();
    expect(await (await rpc(h, h.owner, { method: "allowpubkey", params: [target.pk, "friend"] })).json()).toEqual({ result: true });
    expect(await h.stores.users.get(target.pk)).toMatchObject({ allowed: true, status: "active" });
    expect(await (await rpc(h, h.owner, { method: "banpubkey", params: [target.pk, "spam"] })).json()).toEqual({ result: true });
    expect(await h.stores.users.get(target.pk)).toMatchObject({ allowed: false, status: "banned", banReason: "spam" });
    expect(((await (await rpc(h, h.owner, { method: "listallowedpubkeys" })).json()) as { result: unknown[] }).result).toEqual([]);
    expect(await (await rpc(h, h.owner, { method: "allowpubkey", params: [target.pk] })).json()).toEqual({ result: true });
    expect(await h.stores.users.get(target.pk)).toMatchObject({ allowed: true, status: "active", banReason: null });
    expect(((await (await rpc(h, h.owner, { method: "listbannedpubkeys" })).json()) as { result: unknown[] }).result).toEqual([]);

    const other = newKey();
    await rpc(h, h.owner, { method: "banpubkey", params: [other.pk] });
    expect(await (await rpc(h, h.owner, { method: "unbanpubkey", params: [other.pk] })).json()).toEqual({ result: true });
    expect(await h.stores.users.get(other.pk)).toMatchObject({ allowed: false, status: "active" });
    const muted = newKey();
    await h.stores.users.upsert(muted.pk, { status: "muted" });
    await rpc(h, h.owner, { method: "unbanpubkey", params: [muted.pk] });
    expect((await h.stores.users.get(muted.pk))?.status).toBe("muted");
  });

  test("unbanevent lifts an event ban; listdisallowedkinds", async () => {
    const h = await createHarness();
    const id = "e".repeat(64);
    await rpc(h, h.owner, { method: "banevent", params: [id, "bad"] });
    expect(await (await rpc(h, h.owner, { method: "unbanevent", params: [id.toUpperCase(), "ok now"] })).json()).toEqual({ result: true });
    expect(((await (await rpc(h, h.owner, { method: "listbannedevents" })).json()) as { result: unknown[] }).result).toEqual([]);
    expect(h.audit.entries.some((e) => e.action === "event.unban" && e.target === id)).toBe(true);
    expect(await (await rpc(h, h.owner, { method: "unbanevent", params: ["nope"] })).json()).toMatchObject({ result: null, error: "invalid event id" });

    expect(await (await rpc(h, h.owner, { method: "listdisallowedkinds" })).json()).toEqual({ result: [] });
    await rpc(h, h.owner, { method: "disallowkind", params: [7] });
    expect(await (await rpc(h, h.owner, { method: "listdisallowedkinds" })).json()).toEqual({ result: [7] });
  });

  test("responses carry CORS headers, including errors and 401; OPTIONS preflight", async () => {
    const h = await createHarness();
    const ok = await rpc(h, h.owner, { method: "supportedmethods" });
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    const unauth = await rpc(h, null, { method: "supportedmethods" });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("access-control-allow-origin")).toBe("*");
    const err = await rpc(h, h.owner, { method: "nope" });
    expect(err.headers.get("access-control-allow-origin")).toBe("*");
    const pre = await h.api.nip86(new Request(PUBLIC_URL, { method: "OPTIONS" }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");
    expect(pre.headers.get("access-control-allow-headers")).toContain("Authorization");
  });
});
