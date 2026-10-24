import { Hono } from "hono";
import * as nip19 from "nostr-tools/nip19";
import type { RelayContext } from "../context";
import { toWsUrl } from "../util/url";
import { buildNip11 } from "./nip11";
import { invitePage } from "./invite-page";
import { verifyNip98 } from "./nip98";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, *", // "*" alone does not cover Authorization (NIP-86 uses NIP-98)
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const NIP05_NAME = /^[a-z0-9._-]{1,64}$/;
const MAX_REDEEM_BODY = 4096;

/** Relay HTTP routes: NIP-11, NIP-05 and invite redemption. Unhandled requests fall through via next(). */
export function createHttp(ctx: RelayContext): Hono {
  const app = new Hono();

  // CORS preflight for NIP-11 (and NIP-86, which shares "/")
  app.options("/", () => new Response(null, { status: 204, headers: CORS }));

  app.get("/", (c, next) => {
    if (!(c.req.header("accept") ?? "").includes("application/nostr+json")) return next();
    return new Response(JSON.stringify(buildNip11(ctx)), {
      headers: { ...CORS, "Content-Type": "application/nostr+json; charset=utf-8" },
    });
  });

  app.options("/.well-known/nostr.json", () => new Response(null, { status: 204, headers: CORS }));
  app.get("/.well-known/nostr.json", async (c) => {
    const s = ctx.s();
    if (!s.nip05.enabled) return c.json({ error: "NIP-05 disabled" }, 404, CORS);
    const name = (c.req.query("name") ?? "").toLowerCase();
    const names: Record<string, string> = {};
    const ownerPk = hexPubkey(s.info.pubkey);
    if (ownerPk && (name === "" || name === "_")) names._ = ownerPk;
    if (name && name !== "_" && NIP05_NAME.test(name)) {
      const u = await ctx.stores.users.getByNip05(name);
      if (u && u.status !== "banned" && !u.denied) names[name] = u.pubkey;
    }
    const relayUrls = [...new Set([toWsUrl(ctx.config.server.publicUrl), ...s.nip05.relays])];
    const relays: Record<string, string[]> = {};
    for (const pk of new Set(Object.values(names))) relays[pk] = relayUrls;
    return c.json({ names, relays }, 200, CORS);
  });

  app.options("/invite/redeem", () => new Response(null, { status: 204, headers: CORS }));
  app.post("/invite/redeem", async (c) => {
    const body = new Uint8Array(await c.req.arrayBuffer());
    if (body.length > MAX_REDEEM_BODY) return c.json({ ok: false, error: "body too large" }, 413, CORS);
    const auth = verifyNip98(c.req.raw, { publicUrl: ctx.config.server.publicUrl, verifier: ctx.verifier, body });
    if (!auth.ok) return c.json({ ok: false, error: auth.error }, auth.status, CORS);
    let code: unknown;
    try {
      code = (JSON.parse(new TextDecoder().decode(body)) as { code?: unknown }).code;
    } catch {
      return c.json({ ok: false, error: "body must be JSON {code}" }, 400, CORS);
    }
    if (typeof code !== "string" || !code || code.length > 256) return c.json({ ok: false, error: "missing invite code" }, 400, CORS);
    const existing = await ctx.stores.users.get(auth.pubkey);
    if (existing?.status === "banned" || existing?.denied) return c.json({ ok: false, error: "pubkey is banned" }, 403, CORS);
    if (existing && ctx.users.isMember(auth.pubkey, existing)) return c.json({ ok: true, pubkey: auth.pubkey, alreadyMember: true }, 200, CORS);
    const ok = await ctx.stores.invites.redeem(code, auth.pubkey);
    if (!ok) return c.json({ ok: false, error: "invalid, expired or exhausted invite code" }, 400, CORS);
    ctx.users.invalidate(auth.pubkey);
    const user = await ctx.stores.users.get(auth.pubkey);
    if (user) ctx.bus.emit("user.updated", { pubkey: auth.pubkey, user, actor: "invite" });
    return c.json({ ok: true, pubkey: auth.pubkey }, 200, CORS);
  });

  app.get("/invite/:code", (c) => {
    const code = c.req.param("code");
    if (code === "redeem" || code.length > 256) return c.notFound();
    const base = ctx.config.server.publicUrl.replace(/\/+$/, "");
    const html = invitePage({ code, relayName: ctx.s().info.name, relayUrl: toWsUrl(base), redeemUrl: `${base}/invite/redeem` });
    return c.html(html, 200, { "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
  });

  return app;
}

/** NIP-05 keys must be lowercase hex; accept an operator-entered npub or uppercase hex. */
function hexPubkey(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const t = v.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return t.toLowerCase();
  if (t.startsWith("npub1")) {
    try {
      const d = nip19.decode(t);
      if (d.type === "npub") return d.data;
    } catch {
      /* invalid */
    }
  }
  return undefined;
}
