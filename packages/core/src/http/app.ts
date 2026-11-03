import { Hono } from "hono";
import * as nip19 from "nostr-tools/nip19";
import type { RelayContext } from "../context";
import { toWsUrl } from "../util/url";
import { buildNip11 } from "./nip11";
import { inviteCsp, invitePage } from "./invite-page";
import { verifyNip98 } from "./nip98";
import { ipKey } from "../util/cidr";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  // `*` never covers Authorization in a preflight, and NIP-98 (invite redeem, NIP-86 on "/") needs it
  "Access-Control-Allow-Headers": "Authorization, Content-Type, *",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const NIP05_NAME = /^[a-z0-9._-]{1,64}$/;
const MAX_REDEEM_BODY = 4096;
/** Invite redemption attempts per address per minute (each one costs a signature check and a replay-cache slot). */
const REDEEM_PER_MINUTE = 20;

/** Relay HTTP routes: NIP-11, NIP-05 and invite redemption. Unhandled requests fall through via next(). */
export function createHttp(ctx: RelayContext): Hono {
  const app = new Hono<{ Bindings: { ip?: string } }>();
  let warnedNip05Host = false;

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
    // identifiers are name@domain: with a domain configured, other hosts pointing here directly don't get answers.
    // The relay's own host is accepted too, since the domain's site typically proxies this path to it (nginx sends
    // `Host: $proxy_host` by default, a Cloudflare Worker fetches the relay's URL), and so is the host a reverse proxy
    // reports (X-Forwarded-Host): a client spoofing it only changes its own answer.
    const domain = hostOf(s.nip05.domain);
    if (domain) {
      const host = new URL(c.req.url).host;
      const forwarded = c.req.header("x-forwarded-host")?.split(",")[0]?.trim();
      const allowed = [domain, hostOf(ctx.config.server.publicUrl)];
      if (![host, forwarded].some((h) => h && allowed.includes(hostOf(h)))) {
        if (!warnedNip05Host) {
          warnedNip05Host = true;
          ctx.logger.warn("NIP-05 request refused: its host is neither nip05.domain nor the publicUrl host (logged once)", { host, forwardedHost: forwarded, domain });
        }
        return c.json({ error: "NIP-05 is not served for this host" }, 404, CORS);
      }
    }
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
    const ip = c.env?.ip;
    // the relay's limiter is swept on a timer, so addresses that come once don't stay in memory
    if (ip && !ctx.rate.take(`redeem:${ipKey(ip)}`, REDEEM_PER_MINUTE)) return c.json({ ok: false, error: "rate-limited: too many attempts" }, 429, CORS);
    const body = await readCapped(c.req.raw, MAX_REDEEM_BODY);
    if (!body) return c.json({ ok: false, error: "body too large" }, 413, CORS);
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
    const redeemUrl = `${base}/invite/redeem`;
    const html = invitePage({ code, relayName: ctx.s().info.name, relayUrl: toWsUrl(base), redeemUrl });
    return c.html(html, 200, {
      "Content-Security-Policy": inviteCsp(redeemUrl),
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
  });

  return app as unknown as Hono;
}

/** Reads a request body, giving up (null) as soon as it exceeds `max` bytes instead of buffering it all. */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  return out;
}

/** Lowercase hostname of a host, host:port or URL ("" when there's none); ports and IPv6 brackets are dropped. */
function hostOf(v: string | undefined): string {
  const t = (v ?? "").trim();
  if (!t) return "";
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `http://${t}`).hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return t.toLowerCase();
  }
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
