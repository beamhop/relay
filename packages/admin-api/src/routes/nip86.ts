import type { AdminRole, Permission, UserQuery, UserRecord } from "@beamhop/sdk";
import type { ApiContext } from "../context";
import { isZodError, zodMessage } from "../errors";
import { isValidCidr } from "./ip";
import { BannedEventCache } from "../services/banned-events";
import { permissionsFor, ROLE_RANK } from "../services/roles";
import { AUTH_REPLAY_TTL_MS } from "../middleware/auth";
import { parseNostrAuthorization, readBodyCapped, verifyNip98 } from "../util/nip98";
import { tryParsePubkey } from "../util/pubkey";

const CONTENT_TYPE = "application/nostr+json+rpc";
const MAX_BODY = 64 * 1024;
const HEX64 = /^[0-9a-f]{64}$/i;
/** UserStore.list returns at most this many rows per call */
const USER_PAGE = 1000;

type Params = unknown[];
interface Caller {
  pubkey: string;
  role: AdminRole;
  /** client IP bound by the server adapter (for the audit log) */
  ip: string | null;
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

/**
 * Builds the NIP-86 relay management handler (JSON-RPC-like over HTTP with NIP-98 auth). The server routes `POST /` with
 * the NIP-86 content type here, passing its env (`env.ip`: the client address); CORS preflights are answered by the
 * relay's HTTP routes.
 */
export async function createNip86Handler(ctx: ApiContext): Promise<(req: Request, env?: { ip?: unknown }) => Promise<Response>> {
  const { stores, settings, bus, hooks } = ctx.deps;
  // banned event ids are enforced on write so a banned event can't simply be republished — through any instance
  const bannedEvents = new BannedEventCache(stores.db, ctx.nowMs, ctx.opts.bannedEventsTtlMs ?? 5000, ctx.logger);
  await bannedEvents.init();
  hooks.onWrite(
    async (event) => ((await bannedEvents.has(event.id)) ? { action: "reject", reason: "blocked: this event was banned by the relay operator" } : undefined),
    "admin",
    0,
  );
  const audit = (caller: Caller, action: string, target: string | null, details: Record<string, unknown> = {}) =>
    ctx.auditAs(caller.pubkey, caller.ip, action, target, { via: "nip86", ...details });

  /**
   * Every user matching `q`, page by page (UserStore.list caps each call at USER_PAGE rows), in pubkey order: unlike the
   * default last-seen order it doesn't change while paging, so activity can't push users across page boundaries.
   * A user added to or removed from the set meanwhile can still shift the pages; repeats are dropped.
   */
  const allUsers = async (q: Omit<UserQuery, "limit" | "offset" | "sort">): Promise<UserRecord[]> => {
    const out = new Map<string, UserRecord>();
    for (let offset = 0; ; offset += USER_PAGE) {
      const { items, total } = await stores.users.list({ ...q, sort: "pubkey", limit: USER_PAGE, offset });
      for (const u of items) out.set(u.pubkey, u);
      if (items.length < USER_PAGE || offset + items.length >= total) return [...out.values()];
    }
  };

  /**
   * An event ban can only be lifted by a role at least as high as the one that placed it (rows from before roles were
   * recorded: the banner's current rank; an unknown role string counts as owner).
   */
  const banOf = (id: string) => stores.db.get<{ by: string; by_role: string | null }>("SELECT by, by_role FROM admin_banned_events WHERE id = ?", [id]);
  const banRole = async (row: { by: string; by_role: string | null }): Promise<AdminRole | null> =>
    row.by_role === null ? ctx.roles.rankRole(row.by) : row.by_role in ROLE_RANK ? (row.by_role as AdminRole) : "owner";
  const assertCanLiftBan = async (caller: Caller, id: string) => {
    const row = await banOf(id);
    const role = row ? await banRole(row) : null;
    if (role && ROLE_RANK[role] > ROLE_RANK[caller.role]) throw new RpcError(`forbidden: this event was banned by a user with role ${role}`);
  };

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
        await assertCan("moderate", caller, pk);
        // NIP-86: banning also removes the pubkey from the allow list (as every ban does)
        const r = await ctx.moderation.banUser(pk, { reason: reason || undefined, disconnect: true }, caller.pubkey);
        await audit(caller, "user.ban", pk, { reason, disconnected: r.disconnected, ...(r.unallowed ? { unallowed: true } : {}) });
        return true;
      },
    },
    unbanpubkey: {
      permission: "users.ban",
      async run(params, caller) {
        const pk = pubkeyParam(params);
        await assertCan("moderate", caller, pk);
        // only lift a ban; a muted user stays muted (and is not added to the allow list)
        await ctx.moderation.unbanUser(pk, caller.pubkey);
        await audit(caller, "user.unban", pk, { reason: str(params, 1, "reason", true) });
        return true;
      },
    },
    listbannedpubkeys: {
      permission: "users.view",
      async run() {
        return (await allUsers({ status: "banned" })).map((u) => ({ pubkey: u.pubkey, reason: u.banReason ?? "" }));
      },
    },
    allowpubkey: {
      permission: "users.edit",
      async run(params, caller) {
        const pk = pubkeyParam(params);
        const reason = str(params, 1, "reason", true);
        await assertCan("edit", caller, pk, { allowed: true });
        // NIP-86: allowing also removes the pubkey from the ban list (which needs ban rights)
        const unbanned = (await stores.users.get(pk))?.status === "banned";
        if (unbanned) {
          if (!permissionsFor(caller.role).has("users.ban")) throw new RpcError("forbidden: pubkey is banned; unbanning requires permission users.ban");
          await assertCan("moderate", caller, pk);
        }
        // the reason goes to the audit log; it must not overwrite the operator's notes on the user
        await ctx.users.update(pk, { allowed: true, ...(unbanned ? { status: "active", banReason: null } : {}) }, caller.pubkey);
        await audit(caller, "user.allow", pk, { reason, ...(unbanned ? { unbanned } : {}) });
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
        return (await allUsers({ allowed: true })).map((u) => ({ pubkey: u.pubkey, reason: "" }));
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
        // allowing lifts any ban on it: checked before reports are dismissed, so a refused call changes nothing
        await assertCanLiftBan(caller, id);
        const n = await ctx.reports.resolveFor(id, "dismissed", "dismiss", caller.pubkey, reason || "allowed via NIP-86");
        const lifted = (await stores.db.run("DELETE FROM admin_banned_events WHERE id = ?", [id])).changes > 0;
        bannedEvents.set(id, false);
        await audit(caller, "event.allow", id, { reason, dismissedReports: n, ...(lifted ? { liftedBan: true } : {}) });
        return true;
      },
    },
    banevent: {
      permission: "content.delete",
      async run(params, caller) {
        const id = eventIdParam(params);
        const reason = str(params, 1, "reason", true);
        const target = await stores.events.getById(id);
        if (target) {
          await ctx.users.assertCanDeleteEventsOf(caller, [target.pubkey]).catch((e: Error) => {
            throw new RpcError(e.message);
          });
        } else if (caller.role !== "owner") {
          // no stored event says whose it is: it may be a peer's or superior's yet to be published here
          throw new RpcError("forbidden: banning an event that isn't stored here needs the owner role");
        }
        const existing = await banOf(id);
        const existingRole = existing ? await banRole(existing) : null;
        const deleted = await stores.events.deleteByIds([id]);
        // a ban placed by a higher role stays on record as theirs (so it keeps needing their rank to lift)
        if (!existingRole || ROLE_RANK[existingRole] <= ROLE_RANK[caller.role]) {
          await stores.db.run(
            `INSERT INTO admin_banned_events (id, reason, by, at, by_role) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (id) DO UPDATE SET reason = excluded.reason, by = excluded.by, at = excluded.at, by_role = excluded.by_role`,
            [id, reason, caller.pubkey, ctx.nowSec(), caller.role],
          );
        }
        bannedEvents.set(id, true);
        await ctx.reports.resolveFor(id, "resolved", "delete-event", caller.pubkey, reason || undefined);
        bus.emit("event.deleted", { ids: [id], actor: caller.pubkey, reason: reason || undefined });
        await audit(caller, "event.delete", id, { reason, deleted });
        return true;
      },
    },
    unbanevent: {
      permission: "content.delete",
      async run(params, caller) {
        const id = eventIdParam(params);
        await assertCanLiftBan(caller, id);
        // lifts the write block only; the deleted event is not restored and is not added to any allow list
        await stores.db.run("DELETE FROM admin_banned_events WHERE id = ?", [id]);
        bannedEvents.set(id, false);
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
        // always blocklisted: the blocklist wins over the allowlist. The allowlist only shrinks while other kinds stay
        // on it, since an empty allowlist means "all kinds" and disallowing a kind must never open the relay up
        const rest = m.kindAllowlist.filter((k) => k !== kind);
        const patch = {
          kindBlocklist: m.kindBlocklist.includes(kind) ? m.kindBlocklist : [...m.kindBlocklist, kind],
          ...(rest.length ? { kindAllowlist: rest } : {}),
        };
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
        const { disconnected } = await ctx.moderation.addIpRule({ cidr: ip, action: "block", reason }, caller.pubkey);
        await audit(caller, "ip.add", ip, { action: "block", reason, disconnected });
        return true;
      },
    },
    unblockip: {
      permission: "ip.manage",
      async run(params, caller) {
        const ip = str(params, 0, "ip").trim();
        // nothing to remove: nothing changed, so nothing to announce or audit (still a success, like a repeated call)
        if (await ctx.moderation.removeIpRule(ip, caller.pubkey)) await audit(caller, "ip.remove", ip, {});
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

  // browser-based management clients call this cross-origin; auth is the NIP-98 header, not cookies (the preflight is
  // answered by the relay's HTTP routes, which share "/")
  const CORS = { "Access-Control-Allow-Origin": "*" };
  const reply = (body: { result: unknown; error?: string }, status = 200) =>
    // NIP-86 clients are browser apps on other origins; auth is a header (NIP-98), never a cookie
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": CONTENT_TYPE, ...CORS } });

  return async function nip86(req: Request, env?: { ip?: unknown }): Promise<Response> {
    const ip = typeof env?.ip === "string" && env.ip ? env.ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, "$1") : null;
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
      return reply({ result: await method.run(params, { pubkey: ev.pubkey, role, ip }) });
    } catch (err) {
      if (err instanceof RpcError) return reply({ result: null, error: err.message });
      // invalid settings values (e.g. a bad icon URL): the caller's mistake, answered like the settings API does
      if (isZodError(err)) return reply({ result: null, error: `invalid: ${zodMessage(err)}` });
      ctx.logger.error("nip86 method failed", { method: rpc.method, error: String(err) });
      return reply({ result: null, error: (err as Error).message || "internal error" });
    }
  };
}
