import { z } from "zod";
import type { AdminRole, BulkResult, BulkUserRequest, UserDetail, UserRecord } from "@beamhop/sdk";
import type { AdminApp, ApiContext } from "../context";
import { principalOf } from "../context";
import { badRequest, conflict, forbidden } from "../errors";
import { assertPermission, requirePermission } from "../middleware/auth";
import { parsePubkey, tryParsePubkey } from "../util/pubkey";
import { readBody, readQuery } from "../util/request";

const ROLES = ["owner", "admin", "moderator", "viewer"] as const;
const boolStr = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const ListQuery = z.object({
  search: z.string().max(200).optional(),
  status: z.enum(["active", "banned", "muted"]).optional(),
  role: z.enum(ROLES).optional(),
  tag: z.string().max(100).optional(),
  allowed: boolStr.optional(),
  sort: z.enum(["lastSeen", "firstSeen", "eventCount"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).max(10_000_000).default(0),
});

const Tags = z.array(z.string().trim().min(1).max(64)).max(50);
const Nip05Name = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{1,64}$/, "invalid nip05 name");
const UserPatchSchema = z
  .object({
    notes: z.string().max(10_000).optional(),
    tags: Tags.optional(),
    rateLimit: z
      .object({ eventsPerMinute: z.number().int().min(0).max(1_000_000).optional(), reqPerMinute: z.number().int().min(0).max(1_000_000).optional() })
      .strict()
      .nullable()
      .optional(),
    blossomQuota: z.number().int().min(0).nullable().optional(),
    nip05Name: Nip05Name.nullable().optional(),
    allowed: z.boolean().optional(),
    denied: z.boolean().optional(),
  })
  .strict();
const BanSchema = z.object({
  reason: z.string().max(1000).optional(),
  deleteEvents: z.boolean().optional(),
  deleteMedia: z.boolean().optional(),
  disconnect: z.boolean().optional(),
});
const RoleSchema = z.object({ role: z.enum(ROLES).nullable() });
const BulkSchema = z.object({
  pubkeys: z.array(z.string()).min(1).max(1000),
  action: z.enum(["ban", "unban", "mute", "unmute", "allow", "disallow", "deny", "undeny", "delete-events", "delete", "add-tag", "remove-tag"]),
  reason: z.string().max(1000).optional(),
  tag: z.string().trim().min(1).max(64).optional(),
});
const AddUserSchema = z.object({ pubkey: z.string(), allowed: z.boolean().optional(), notes: z.string().max(10_000).optional(), tags: Tags.optional() });
const EventsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  until: z.coerce.number().int().min(0).optional(),
  kinds: z.string().regex(/^\d+(,\d+)*$/).optional(),
});

const BULK_PERMISSION = {
  ban: "users.ban",
  unban: "users.ban",
  mute: "users.ban",
  unmute: "users.ban",
  allow: "users.edit",
  disallow: "users.edit",
  deny: "users.edit",
  undeny: "users.edit",
  "add-tag": "users.edit",
  "remove-tag": "users.edit",
  "delete-events": "content.delete",
  delete: "users.delete",
} as const;

export function registerUserRoutes(app: AdminApp, ctx: ApiContext) {
  const { stores } = ctx.deps;

  async function kindStats(pubkey: string): Promise<{ kind: number; count: number }[]> {
    try {
      const rows = await stores.db.all<{ kind: number; count: number }>(
        "SELECT kind, COUNT(*) AS count FROM events WHERE pubkey = ? GROUP BY kind ORDER BY count DESC",
        [pubkey],
      );
      return rows.map((r) => ({ kind: Number(r.kind), count: Number(r.count) }));
    } catch {
      // fall back to a capped scan through the EventStore API
      const evs = await stores.events.query([{ authors: [pubkey], limit: 5000 }], { maxLimit: 5000 });
      const m = new Map<number, number>();
      for (const e of evs) m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
      return [...m].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
    }
  }

  /** Pubkeys matching a search by npub/hex or by profile name (kind-0 full-text search). */
  async function searchPubkeys(search: string): Promise<string[]> {
    const out = new Set<string>();
    const pk = tryParsePubkey(search);
    if (pk) out.add(pk);
    if (search.length >= 2 && !pk) {
      try {
        const evs = await stores.events.query([{ kinds: [0], search, limit: 200 }], { maxLimit: 200 });
        for (const e of evs) out.add(e.pubkey);
      } catch {
        // search unsupported by this backend — fall back to column matches only
      }
    }
    return [...out];
  }

  /** Count of owners (config owners ∪ DB owners). */
  async function ownerCount(): Promise<Set<string>> {
    const set = new Set(ctx.roles.owners);
    const { items } = await stores.users.list({ role: "owner", limit: 1000 });
    for (const u of items) set.add(u.pubkey);
    return set;
  }

  app.get("/users", requirePermission("users.view"), async (c) => {
    const q = readQuery(c, ListQuery);
    const { items, total } = await stores.users.list({
      ...q,
      ...(q.search?.trim() ? { searchPubkeys: await searchPubkeys(q.search.trim()) } : {}),
      ...(q.role === "owner" ? { rolePubkeys: [...ctx.roles.owners] } : {}),
    });
    return c.json({ items: await ctx.users.toViews(items), total });
  });

  app.post("/users", requirePermission("users.edit"), async (c) => {
    const body = await readBody(c, AddUserSchema);
    const pubkey = parsePubkey(body.pubkey);
    const patch: Partial<UserRecord> = {};
    if (body.allowed !== undefined) patch.allowed = body.allowed;
    if (body.notes !== undefined) patch.notes = body.notes;
    if (body.tags !== undefined) patch.tags = body.tags;
    await ctx.users.assertCanEdit(principalOf(c), pubkey, patch);
    const user = await ctx.users.update(pubkey, patch, principalOf(c).pubkey);
    await ctx.audit(c, "user.create", pubkey, patch);
    return c.json(await ctx.users.toView(user), 201);
  });

  app.get("/admins", requirePermission("users.view"), async (c) => {
    const byPk = new Map<string, UserRecord>();
    for (const role of ROLES) {
      const { items } = await stores.users.list({ role, limit: 1000 });
      for (const u of items) byPk.set(u.pubkey, u);
    }
    for (const pk of ctx.roles.owners) if (!byPk.has(pk)) byPk.set(pk, await ctx.users.getOrDefault(pk));
    const views = await ctx.users.toViews([...byPk.values()]);
    const rank: Record<AdminRole, number> = { owner: 0, admin: 1, moderator: 2, viewer: 3 };
    views.sort((a, b) => rank[a.role ?? "viewer"] - rank[b.role ?? "viewer"]);
    return c.json({ items: views });
  });

  app.post("/users/bulk", requirePermission("users.view"), async (c) => {
    const body = (await readBody(c, BulkSchema)) as BulkUserRequest;
    assertPermission(c, BULK_PERMISSION[body.action]);
    if ((body.action === "add-tag" || body.action === "remove-tag") && !body.tag) throw badRequest("tag required");
    const actor = principalOf(c);
    const result: BulkResult = { ok: 0, failed: [] };
    for (const raw of body.pubkeys) {
      let pubkey = raw;
      try {
        pubkey = parsePubkey(raw);
        switch (body.action) {
          case "ban":
            await ctx.users.assertCanModerate(actor, pubkey);
            await ctx.users.ban(pubkey, { reason: body.reason, disconnect: true }, actor.pubkey);
            break;
          case "mute":
            await ctx.users.assertCanModerate(actor, pubkey);
            await ctx.users.setStatus(pubkey, "muted", actor.pubkey);
            break;
          case "unban":
          case "unmute":
            await ctx.users.assertCanModerate(actor, pubkey);
            if ((await ctx.users.getOrDefault(pubkey)).status === (body.action === "unban" ? "banned" : "muted"))
              await ctx.users.setStatus(pubkey, "active", actor.pubkey);
            break;
          case "allow":
          case "disallow": {
            const patch = { allowed: body.action === "allow" };
            await ctx.users.assertCanEdit(actor, pubkey, patch);
            await ctx.users.update(pubkey, patch, actor.pubkey);
            break;
          }
          case "deny":
          case "undeny":
            await ctx.users.assertCanModerate(actor, pubkey);
            await ctx.users.update(pubkey, { denied: body.action === "deny" }, actor.pubkey);
            break;
          case "delete-events":
            await ctx.users.assertCanModerate(actor, pubkey);
            await stores.events.deleteByPubkey(pubkey);
            break;
          case "delete":
            await ctx.users.assertCanModerate(actor, pubkey);
            await ctx.users.delete(pubkey, actor.pubkey);
            await ctx.sessions.destroyAllFor(pubkey);
            break;
          case "add-tag":
          case "remove-tag": {
            await ctx.users.assertCanEdit(actor, pubkey);
            const u = await ctx.users.getOrDefault(pubkey);
            const tags = new Set(u.tags);
            if (body.action === "add-tag") tags.add(body.tag!);
            else tags.delete(body.tag!);
            await ctx.users.update(pubkey, { tags: [...tags] }, actor.pubkey);
            break;
          }
        }
        result.ok++;
      } catch (err) {
        result.failed.push({ pubkey, error: (err as Error).message });
      }
    }
    await ctx.audit(c, `user.bulk.${body.action}`, null, {
      pubkeys: body.pubkeys.slice(0, 100),
      count: body.pubkeys.length,
      ok: result.ok,
      failed: result.failed.length,
      ...(body.reason ? { reason: body.reason } : {}),
      ...(body.tag ? { tag: body.tag } : {}),
    });
    return c.json(result);
  });

  app.get("/users/:pubkey", requirePermission("users.view"), async (c) => {
    const pubkey = parsePubkey(c.req.param("pubkey"));
    const user = await ctx.users.getOrDefault(pubkey);
    const [view, eventCount, kinds, usage, reportsAgainst, reportsFiled] = await Promise.all([
      ctx.users.toView(user),
      stores.events.count([{ authors: [pubkey] }]),
      kindStats(pubkey),
      ctx.deps.blossom ? ctx.deps.blossom.usage(pubkey) : Promise.resolve({ count: 0, bytes: 0 }),
      stores.events.count([{ kinds: [1984], "#p": [pubkey] }]),
      stores.events.count([{ kinds: [1984], authors: [pubkey] }]),
    ]);
    const detail: UserDetail = {
      ...view,
      stats: { eventCount, kinds, blobCount: usage.count, blobBytes: usage.bytes, reportsAgainst, reportsFiled },
    };
    return c.json(detail);
  });

  app.patch("/users/:pubkey", requirePermission("users.edit"), async (c) => {
    const pubkey = parsePubkey(c.req.param("pubkey"));
    const patch = await readBody(c, UserPatchSchema);
    if (patch.denied !== undefined) await ctx.users.assertCanModerate(principalOf(c), pubkey);
    else await ctx.users.assertCanEdit(principalOf(c), pubkey, patch as Partial<UserRecord>);
    if (patch.nip05Name) {
      const holder = await stores.users.getByNip05(patch.nip05Name);
      if (holder && holder.pubkey !== pubkey) throw conflict("nip05 name already taken");
    }
    const user = await ctx.users.update(pubkey, patch as Partial<UserRecord>, principalOf(c).pubkey);
    await ctx.audit(c, "user.update", pubkey, patch);
    return c.json(await ctx.users.toView(user));
  });

  app.post("/users/:pubkey/ban", requirePermission("users.ban"), async (c) => {
    const pubkey = parsePubkey(c.req.param("pubkey"));
    const body = await readBody(c, BanSchema);
    const actor = principalOf(c);
    await ctx.users.assertCanModerate(actor, pubkey);
    if (body.deleteEvents) assertPermission(c, "content.delete");
    if (body.deleteMedia) assertPermission(c, "media.moderate");
    const r = await ctx.users.ban(pubkey, body, actor.pubkey);
    await ctx.audit(c, "user.ban", pubkey, {
      ...body,
      deletedEvents: r.deletedEvents,
      deletedMedia: r.deletedMedia,
      disconnected: r.disconnected,
    });
    return c.json(await ctx.users.toView(r.user));
  });

  app.delete("/users/:pubkey", requirePermission("users.delete"), async (c) => {
    const pubkey = parsePubkey(c.req.param("pubkey"));
    const actor = principalOf(c);
    await ctx.users.assertCanModerate(actor, pubkey);
    const r = await ctx.users.delete(pubkey, actor.pubkey);
    await ctx.sessions.destroyAllFor(pubkey);
    await ctx.audit(c, "user.delete", pubkey, r);
    return c.json(r);
  });

  const statusRoute = (path: string, action: string, status: "active" | "muted", from?: "banned" | "muted") =>
    app.post(`/users/:pubkey/${path}`, requirePermission("users.ban"), async (c) => {
      const pubkey = parsePubkey(c.req.param("pubkey"));
      const actor = principalOf(c);
      // lifting a ban/mute needs the same rank as imposing it (a moderator can't undo an owner's ban of an admin)
      await ctx.users.assertCanModerate(actor, pubkey);
      const current = await ctx.users.getOrDefault(pubkey);
      let user: UserRecord = current;
      if (!from || current.status === from) user = await ctx.users.setStatus(pubkey, status, actor.pubkey);
      await ctx.audit(c, action, pubkey);
      return c.json(await ctx.users.toView(user));
    });
  statusRoute("unban", "user.unban", "active", "banned");
  statusRoute("mute", "user.mute", "muted");
  statusRoute("unmute", "user.unmute", "active", "muted");

  app.put("/users/:pubkey/role", requirePermission("admins.manage"), async (c) => {
    const pubkey = parsePubkey(c.req.param("pubkey"));
    const { role } = await readBody(c, RoleSchema);
    if (ctx.roles.isConfigOwner(pubkey)) {
      if (role === "owner") return c.json(await ctx.users.toView(await ctx.users.getOrDefault(pubkey)));
      throw forbidden("cannot change the role of a configured owner", "config_owner");
    }
    const current = (await stores.users.get(pubkey))?.role ?? null;
    if (current === "owner" && role !== "owner") {
      const owners = await ownerCount();
      owners.delete(pubkey);
      if (owners.size === 0) throw conflict("cannot remove the last owner", "last_owner");
    }
    const user = await ctx.users.update(pubkey, { role }, principalOf(c).pubkey);
    if (!role) {
      await ctx.sessions.destroyAllFor(pubkey);
      await ctx.push.unsubscribeAllFor(pubkey);
    }
    await ctx.audit(c, "user.role", pubkey, { from: current, to: role });
    return c.json(await ctx.users.toView(user));
  });

  app.get("/users/:pubkey/events", requirePermission("users.view", "content.view"), async (c) => {
    const pubkey = parsePubkey(c.req.param("pubkey"));
    const q = readQuery(c, EventsQuery);
    const items = await stores.events.query(
      [{ authors: [pubkey], limit: q.limit, ...(q.until !== undefined ? { until: q.until } : {}), ...(q.kinds ? { kinds: q.kinds.split(",").map(Number) } : {}) }],
      { maxLimit: 500 },
    );
    return c.json({ items });
  });
}

