import type { Permission, UserRecord } from "@beamhop/sdk";
import type { ApiContext } from "../context";
import { isValidCidr } from "./ip";
import { permissionsFor } from "../services/roles";
import { AUTH_REPLAY_TTL_MS } from "../middleware/auth";
import { parseNostrAuthorization, readBodyCapped, verifyNip98 } from "../util/nip98";
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

  const assertCan = async (what: "edit" | "moderate", caller: Caller, pk: string, patch?: Partial<UserRecord>) => {
    try {
      if (what === "edit") await ctx.users.assertCanEdit(caller, pk, patch);
      else await ctx.users.assertCanModerate(caller, pk);
    } catch (e) {
      throw new RpcError((e as Error).message);
    }
  };

  const updateInfo = async (field: "name" | "description" | "icon", value: string, caller: Caller) => {
    if (value.length > 2000) throw new RpcError(`${field} too long`);
    await settings.update({ info: { [field]: value } }, caller.pubkey);
    await audit(caller, "settings.update", null, { patch: { info: { [field]: value } } });
    return true;
  };

  const methods: Record<string, Method> = {
    supportedmethods: { permission: null, run: async () => Object.keys(methods) },

    banpubkey: {
      permission: "users.ban",
      async run(params, caller) {
        const pk = pubkeyParam(params);
        const reason = str(params, 1, "reason", true);
        await assertCan("moderate", caller, pk);
        const r = await ctx.users.ban(pk, { reason: reason || undefined, disconnect: true }, caller.pubkey);
        await audit(caller, "user.ban", pk, { reason, disconnected: r.disconnected });
        return true;
      },
    },
    unbanpubkey: {
      permission: "users.ban",
      async run(params, caller) {
        const pk = pubkeyParam(params);
        await assertCan("moderate", caller, pk);
        await ctx.users.setStatus(pk, "active", caller.pubkey);
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
        await assertCan("edit", caller, pk, { allowed: true });
        // the reason goes to the audit log; it must not overwrite the operator's notes on the user
        await ctx.users.update(pk, { allowed: true }, caller.pubkey);
        await audit(caller, "user.allow", pk, { reason });
        return true;
      },
    },
    unallowpubkey: {
      permission: "users.edit",
      async run(params, caller) {
        const pk = pubkeyParam(params);
        await assertCan("edit", caller, pk, { allowed: false });
        await ctx.users.update(pk, { allowed: false }, caller.pubkey);
        await audit(caller, "user.disallow", pk, { reason: str(params, 1, "reason", true) });
        return true;
      },
    },
    listallowedpubkeys: {
      permission: "users.view",
      async run() {
        const { items } = await stores.users.list({ allowed: true, limit: 10_000 });
        return items.map((u) => ({ pubkey: u.pubkey, reason: "" }));
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
        const target = await stores.events.getById(id);
        if (target) await ctx.users.assertCanDeleteEventsOf(caller, [target.pubkey]).catch((e: Error) => {
          throw new RpcError(e.message);
        });
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

  const reply = (body: { result: unknown; error?: string }, status = 200) =>
    // NIP-86 clients are browser apps on other origins; auth is a header (NIP-98), never a cookie
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": CONTENT_TYPE, "Access-Control-Allow-Origin": "*" } });

  return async function nip86(req: Request): Promise<Response> {
    if (req.method !== "POST") return reply({ result: null, error: "method not allowed" }, 405);
    // stops reading as soon as the cap is exceeded (Content-Length may be absent with chunked bodies)
    const buf = await readBodyCapped(req, MAX_BODY);
    if (!buf) return reply({ result: null, error: "request too large" }, 413);

    const ev = parseNostrAuthorization(req.headers.get("authorization"));
    if (!ev) return reply({ result: null, error: "unauthorized: missing NIP-98 authorization" }, 401);
    const v = verifyNip98(ev, { urls: relayUrls, method: "POST", body: buf, requirePayload: true, nowSec: ctx.nowSec() });
    if (!v.ok) return reply({ result: null, error: `unauthorized: ${v.reason}` }, 401);

    const role = await ctx.roles.resolve(ev.pubkey);
    if (!role) return reply({ result: null, error: "forbidden: not an admin" }, 403);
    // recorded only for admins so strangers can't flood the replay table (shared with the other instances)
    if (!(await ctx.replay.consume(ev.id, AUTH_REPLAY_TTL_MS))) return reply({ result: null, error: "unauthorized: authorization already used" }, 401);

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
