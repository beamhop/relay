import type { Permission } from "@beamhop/sdk";
import type { ApiContext } from "../context";
import { isValidCidr } from "./ip";
import { permissionsFor } from "../services/roles";
import { parseNostrAuthorization, verifyNip98 } from "../util/nip98";
import { tryParsePubkey } from "../util/pubkey";

const CONTENT_TYPE = "application/nostr+json+rpc";
const MAX_BODY = 64 * 1024;
const HEX64 = /^[0-9a-f]{64}$/i;

type Params = unknown[];
interface Caller {
  pubkey: string;
  role: NonNullable<Awaited<ReturnType<ApiContext["roles"]["resolve"]>>>;
}
interface Method {
  permission: Permission | null;
  run(params: Params, caller: Caller): Promise<unknown>;
}

class RpcError extends Error {}

const str = (params: Params, i: number, name: string, optional = false): string => {
  const v = params[i];
  if (v === undefined || v === null) {
    if (optional) return "";
    throw new RpcError(`missing param: ${name}`);
  }
  if (typeof v !== "string") throw new RpcError(`invalid param: ${name}`);
  return v;
};
const pubkeyParam = (params: Params, i = 0) => {
  const pk = tryParsePubkey(str(params, i, "pubkey"));
  if (!pk) throw new RpcError("invalid pubkey");
  return pk;
};
const eventIdParam = (params: Params, i = 0) => {
  const id = str(params, i, "event id");
  if (!HEX64.test(id)) throw new RpcError("invalid event id");
  return id.toLowerCase();
};
const kindParam = (params: Params, i = 0) => {
  const k = params[i];
  if (typeof k !== "number" || !Number.isInteger(k) || k < 0 || k > 65535) throw new RpcError("invalid kind");
  return k;
};

/** Builds the NIP-86 relay management handler (JSON-RPC-like over HTTP with NIP-98 auth). */
export function createNip86Handler(ctx: ApiContext) {
  const { stores, settings, relay, bus, hooks } = ctx.deps;
  // banned event ids are enforced on write so a banned event can't simply be republished
  const bannedEvents = new Set<string>();
  void stores.db
    .all<{ id: string }>("SELECT id FROM admin_banned_events")
    .then((rows) => rows.forEach((r) => bannedEvents.add(r.id)))
    .catch((err) => ctx.logger.warn("failed to load banned events", { err: String(err) }));
  hooks.onWrite((event) => (bannedEvents.has(event.id) ? { action: "reject", reason: "blocked: this event was banned by the relay operator" } : undefined), "admin", 0);
  const audit = (caller: Caller, action: string, target: string | null, details: Record<string, unknown> = {}) =>
    ctx.auditAs(caller.pubkey, null, action, target, { via: "nip86", ...details });

  const updateInfo = async (field: "name" | "description" | "icon", value: string, caller: Caller) => {
    if (value.length > 2000) throw new RpcError(`${field} too long`);
    await settings.update({ info: { [field]: value } }, caller.pubkey);
    await audit(caller, "settings.update", null, { patch: { info: { [field]: value } } });
    return true;
  };

  const methods: Record<string, Method> = {
    // the other methods, limited to what the caller's role may actually call
    supportedmethods: {
      permission: null,
      async run(_params, caller) {
        const perms = permissionsFor(caller.role);
        return Object.entries(methods)
          .filter(([name, m]) => name !== "supportedmethods" && (!m.permission || perms.has(m.permission)))
          .map(([name]) => name);
      },
    },

    banpubkey: {
      permission: "users.ban",
      async run(params, caller) {
        const pk = pubkeyParam(params);
        const reason = str(params, 1, "reason", true);
        await ctx.users.assertCanModerate(caller, pk).catch((e: Error) => {
          throw new RpcError(e.message);
        });
        const r = await ctx.users.ban(pk, { reason: reason || undefined, disconnect: true }, caller.pubkey);
        // NIP-86: banning also removes the pubkey from the allow list
        const unallowed = r.user.allowed;
        if (unallowed) await ctx.users.update(pk, { allowed: false }, caller.pubkey);
        await audit(caller, "user.ban", pk, { reason, disconnected: r.disconnected, ...(unallowed ? { unallowed } : {}) });
        return true;
      },
    },
    unbanpubkey: {
      permission: "users.ban",
      async run(params, caller) {
        const pk = pubkeyParam(params);
        // only lift a ban; a muted user stays muted (and is not added to the allow list)
        if ((await stores.users.get(pk))?.status === "banned") await ctx.users.setStatus(pk, "active", caller.pubkey);
        await audit(caller, "user.unban", pk, { reason: str(params, 1, "reason", true) });
        return true;
      },
    },
    listbannedpubkeys: {
      permission: "users.view",
      async run() {
        const { items } = await stores.users.list({ status: "banned", limit: 10_000 });
        return items.map((u) => ({ pubkey: u.pubkey, reason: u.banReason ?? "" }));
      },
    },
    allowpubkey: {
      permission: "users.edit",
      async run(params, caller) {
        const pk = pubkeyParam(params);
        const reason = str(params, 1, "reason", true);
        // NIP-86: allowing also removes the pubkey from the ban list (which needs ban rights)
        const unbanned = (await stores.users.get(pk))?.status === "banned";
        if (unbanned && !permissionsFor(caller.role).has("users.ban")) throw new RpcError("forbidden: pubkey is banned; unbanning requires permission users.ban");
        await ctx.users.update(pk, { allowed: true, ...(unbanned ? { status: "active", banReason: null } : {}), ...(reason ? { notes: reason } : {}) }, caller.pubkey);
        await audit(caller, "user.allow", pk, { reason, ...(unbanned ? { unbanned } : {}) });
        return true;
      },
    },
    unallowpubkey: {
      permission: "users.edit",
      async run(params, caller) {
        const pk = pubkeyParam(params);
        await ctx.users.update(pk, { allowed: false }, caller.pubkey);
        await audit(caller, "user.disallow", pk, { reason: str(params, 1, "reason", true) });
        return true;
      },
    },
    listallowedpubkeys: {
      permission: "users.view",
      async run() {
        const { items } = await stores.users.list({ allowed: true, limit: 10_000 });
        return items.map((u) => ({ pubkey: u.pubkey, reason: u.notes ?? "" }));
      },
    },
    listeventsneedingmoderation: {
      permission: "reports.view",
      async run() {
        const open = await ctx.reports.open(1000);
        const seen = new Set<string>();
        const out: { id: string; reason: string }[] = [];
        for (const { event, parsed } of open) {
          if (!parsed.targetEventId || seen.has(parsed.targetEventId)) continue;
          seen.add(parsed.targetEventId);
          out.push({ id: parsed.targetEventId, reason: [parsed.type, event.content].filter(Boolean).join(": ").slice(0, 500) });
        }
        return out;
      },
    },
    allowevent: {
      permission: "reports.resolve",
      async run(params, caller) {
        const id = eventIdParam(params);
        const reason = str(params, 1, "reason", true);
        const open = await ctx.reports.open(5000);
        let n = 0;
        for (const { event, parsed } of open) {
          if (parsed.targetEventId !== id) continue;
          await ctx.reports.setStatus(event.id, "dismissed", "dismiss", caller.pubkey, reason || "allowed via NIP-86");
          n++;
        }
        await stores.db.run("DELETE FROM admin_banned_events WHERE id = ?", [id]);
        bannedEvents.delete(id);
        await audit(caller, "event.allow", id, { reason, dismissedReports: n });
        return true;
      },
    },
    banevent: {
      permission: "content.delete",
      async run(params, caller) {
        const id = eventIdParam(params);
        const reason = str(params, 1, "reason", true);
        const deleted = await stores.events.deleteByIds([id]);
        await stores.db.run(
          `INSERT INTO admin_banned_events (id, reason, by, at) VALUES (?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET reason = excluded.reason, by = excluded.by, at = excluded.at`,
          [id, reason, caller.pubkey, ctx.nowSec()],
        );
        bannedEvents.add(id);
        const open = await ctx.reports.open(5000);
        for (const { event, parsed } of open) {
          if (parsed.targetEventId === id) await ctx.reports.setStatus(event.id, "resolved", "delete-event", caller.pubkey, reason || undefined);
        }
        bus.emit("event.deleted", { ids: [id], actor: caller.pubkey, reason: reason || undefined });
        await audit(caller, "event.delete", id, { reason, deleted });
        return true;
      },
    },
    unbanevent: {
      permission: "content.delete",
      async run(params, caller) {
        const id = eventIdParam(params);
        // lifts the write block only; the deleted event is not restored and is not added to any allow list
        await stores.db.run("DELETE FROM admin_banned_events WHERE id = ?", [id]);
        bannedEvents.delete(id);
        await audit(caller, "event.unban", id, { reason: str(params, 1, "reason", true) });
        return true;
      },
    },
    listbannedevents: {
      permission: "content.view",
      async run() {
        const rows = await stores.db.all<{ id: string; reason: string }>("SELECT id, reason FROM admin_banned_events ORDER BY at DESC LIMIT 10000");
        return rows.map((r) => ({ id: r.id, reason: r.reason }));
      },
    },
    changerelayname: { permission: "settings.edit", run: (p, c) => updateInfo("name", str(p, 0, "name"), c) },
    changerelaydescription: { permission: "settings.edit", run: (p, c) => updateInfo("description", str(p, 0, "description"), c) },
    changerelayicon: { permission: "settings.edit", run: (p, c) => updateInfo("icon", str(p, 0, "icon"), c) },
    allowkind: {
      permission: "settings.edit",
      async run(params, caller) {
        const kind = kindParam(params);
        const m = settings.get().moderation;
        const patch = {
          kindBlocklist: m.kindBlocklist.filter((k) => k !== kind),
          // an empty allowlist means "all kinds"; only extend it when it's already in use
          kindAllowlist: m.kindAllowlist.length && !m.kindAllowlist.includes(kind) ? [...m.kindAllowlist, kind] : m.kindAllowlist,
        };
        await settings.update({ moderation: patch }, caller.pubkey);
        await audit(caller, "settings.update", null, { patch: { moderation: patch }, kind });
        return true;
      },
    },
    disallowkind: {
      permission: "settings.edit",
      async run(params, caller) {
        const kind = kindParam(params);
        const m = settings.get().moderation;
        const patch = m.kindAllowlist.length
          ? { kindAllowlist: m.kindAllowlist.filter((k) => k !== kind) }
          : { kindBlocklist: m.kindBlocklist.includes(kind) ? m.kindBlocklist : [...m.kindBlocklist, kind] };
        await settings.update({ moderation: patch }, caller.pubkey);
        await audit(caller, "settings.update", null, { patch: { moderation: patch }, kind });
        return true;
      },
    },
    listallowedkinds: {
      permission: "settings.view",
      run: async () => settings.get().moderation.kindAllowlist,
    },
    listdisallowedkinds: {
      permission: "settings.view",
      run: async () => settings.get().moderation.kindBlocklist,
    },
    blockip: {
      permission: "ip.manage",
      async run(params, caller) {
        const ip = str(params, 0, "ip").trim();
        if (!isValidCidr(ip)) throw new RpcError("invalid ip");
        const reason = str(params, 1, "reason", true);
        await stores.ipRules.add({ cidr: ip, action: "block", reason });
        bus.emit("ip.rules.changed", { actor: caller.pubkey });
        const disconnected = ip.includes("/") ? 0 : relay.disconnect({ ip });
        await audit(caller, "ip.add", ip, { action: "block", reason, disconnected });
        return true;
      },
    },
    unblockip: {
      permission: "ip.manage",
      async run(params, caller) {
        const ip = str(params, 0, "ip").trim();
        await stores.ipRules.remove(ip);
        bus.emit("ip.rules.changed", { actor: caller.pubkey });
        await audit(caller, "ip.remove", ip, {});
        return true;
      },
    },
    listblockedips: {
      permission: "ip.manage",
      async run() {
        return (await stores.ipRules.list()).filter((r) => r.action === "block").map((r) => ({ ip: r.cidr, reason: r.reason }));
      },
    },
  };

  const relayUrls = (() => {
    const base = ctx.publicUrl;
    const ws = base.replace(/^http/, "ws");
    return [base, `${base}/`, ws, `${ws}/`];
  })();

  // browser-based management clients call this cross-origin; auth is the NIP-98 header, not cookies
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  const reply = (body: { result: unknown; error?: string }, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": CONTENT_TYPE, ...CORS } });

  return async function nip86(req: Request): Promise<Response> {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "POST") return reply({ result: null, error: "method not allowed" }, 405);
    const lenHeader = Number(req.headers.get("content-length") ?? 0);
    if (lenHeader > MAX_BODY) return reply({ result: null, error: "request too large" }, 413);
    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.byteLength > MAX_BODY) return reply({ result: null, error: "request too large" }, 413);

    const ev = parseNostrAuthorization(req.headers.get("authorization"));
    if (!ev) return reply({ result: null, error: "unauthorized: missing NIP-98 authorization" }, 401);
    const v = verifyNip98(ev, { urls: relayUrls, method: "POST", body: buf, requirePayload: true, nowSec: ctx.nowSec() });
    if (!v.ok) return reply({ result: null, error: `unauthorized: ${v.reason}` }, 401);
    if (ctx.usedAuthEvents.has(ev.id)) return reply({ result: null, error: "unauthorized: authorization already used" }, 401);
    ctx.usedAuthEvents.set(ev.id, true, 125_000);

    const role = await ctx.roles.resolve(ev.pubkey);
    if (!role) return reply({ result: null, error: "forbidden: not an admin" }, 403);

    let rpc: { method?: unknown; params?: unknown };
    try {
      rpc = JSON.parse(new TextDecoder().decode(buf));
    } catch {
      return reply({ result: null, error: "invalid JSON" }, 400);
    }
    if (!rpc || typeof rpc !== "object" || typeof rpc.method !== "string") return reply({ result: null, error: "invalid request" }, 400);
    const params = rpc.params === undefined ? [] : rpc.params;
    if (!Array.isArray(params)) return reply({ result: null, error: "params must be an array" }, 400);

    const method = Object.prototype.hasOwnProperty.call(methods, rpc.method) ? methods[rpc.method] : undefined;
    if (!method) return reply({ result: null, error: `unsupported method: ${rpc.method}` });
    if (method.permission && !permissionsFor(role).has(method.permission)) {
      return reply({ result: null, error: `forbidden: missing permission ${method.permission}` }, 403);
    }
    try {
      return reply({ result: await method.run(params, { pubkey: ev.pubkey, role }) });
    } catch (err) {
      if (err instanceof RpcError) return reply({ result: null, error: err.message });
      ctx.logger.error("nip86 method failed", { method: rpc.method, error: String(err) });
      return reply({ result: null, error: (err as Error).message || "internal error" });
    }
  };
}
