import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { MiddlewareHandler } from "hono";
import { z } from "zod";
import type { DatabaseRollbackDeleteBody, DatabaseStatus, DatabaseStatusResponse, DatabaseSwitchBody, DatabaseSwitcher, DatabaseTarget } from "@beamhop/sdk";
import type { AdminApp, AdminEnv, ApiContext } from "../context";
import { principalOf } from "../context";
import { forbidden, HttpError, notFound } from "../errors";
import { requirePermission } from "../middleware/auth";
import type { LoginGuard } from "../services/login-guard";
import type { Same } from "../util/contract";
import { readBody } from "../util/request";

const Target = z.discriminatedUnion("driver", [
  z.object({
    driver: z.literal("sqlite"),
    sqlitePath: z.string().trim().min(1).max(4096).refine((p) => isAbsolute(p), "must be an absolute path"),
  }),
  z.object({
    driver: z.literal("postgres"),
    postgresUrl: z
      .string()
      .trim()
      .min(1)
      .max(4096)
      .refine((u) => u === "env" || /^postgres(ql)?:\/\//i.test(u), "must start with postgres:// or postgresql:// (or be \"env\")"),
  }),
]);
const TestBody = z.object({ target: Target });
const SwitchBody = z.object({ target: Target, wipeConfirm: z.string().max(200).optional(), currentPassword: z.string().max(1024).optional() });
const DeleteRollbackBody = z.object({ confirm: z.string().max(200), currentPassword: z.string().max(1024).optional() });
true satisfies Same<z.output<typeof DeleteRollbackBody>, DatabaseRollbackDeleteBody>;
// the parsed target is a DatabaseTarget, so the switch body fits the contract
true satisfies [z.output<typeof SwitchBody>] extends [DatabaseSwitchBody] ? true : false;

/** Errors the switcher throws for the admin carry a `db_*` code; anything else is an internal error. */
function switcherError(err: unknown): never {
  const code = (err as { code?: unknown })?.code;
  if (err instanceof Error && typeof code === "string" && code.startsWith("db_")) {
    const status = code === "db_rollback_not_found" ? 404 : code === "db_target_invalid" || code === "db_confirm_mismatch" ? 400 : 409;
    throw new HttpError(status, err.message, code);
  }
  throw err;
}

function requireOwner(): MiddlewareHandler<AdminEnv> {
  return async (c, next) => {
    if (principalOf(c).role !== "owner") throw forbidden("only the owner can switch the database", "owner_only");
    await next();
  };
}

/** `beamhop.db` in the data directory, or `beamhop-<date>.db` when that one is in use (current or a rollback point). */
export function defaultSqlitePath(status: DatabaseStatus, configured: { sqlitePath: string; stateFile?: string }, now: Date): string {
  const cur = status.current.driver === "sqlite" && status.current.sqlitePath ? resolve(status.current.sqlitePath) : undefined;
  const dir = cur ? dirname(cur) : dirname(resolve(configured.stateFile ?? configured.sqlitePath));
  const taken = new Set([cur, ...status.rollbacks.map((r) => (r.target.driver === "sqlite" && r.target.sqlitePath ? resolve(r.target.sqlitePath) : undefined))]);
  const plain = join(dir, "beamhop.db");
  if (!taken.has(plain)) return plain;
  const date = now.toISOString().slice(0, 10);
  for (let i = 1; ; i++) {
    const p = join(dir, i === 1 ? `beamhop-${date}.db` : `beamhop-${date}-${i}.db`);
    if (!taken.has(p) && !existsSync(p)) return p;
  }
}

/** System → Database: runtime switch between SQLite and Postgres (see docs/plans/database-hot-swap.md). */
export function registerDatabaseRoutes(app: AdminApp, ctx: ApiContext, guard: LoginGuard) {
  const switcher = (): DatabaseSwitcher => {
    const s = ctx.deps.databaseSwitcher;
    if (!s) throw new HttpError(501, "database switching is not available on this server", "db_switch_unavailable");
    return s;
  };
  // checked after the permission check: a server without a switcher answers 501 to every admin allowed to ask
  const available: MiddlewareHandler<AdminEnv> = async (_c, next) => {
    switcher();
    await next();
  };
  const view = requirePermission("settings.edit");

  app.get("/database", view, available, async (c) => {
    const status = await switcher().status();
    const owner = principalOf(c).role === "owner";
    const body: DatabaseStatusResponse = {
      ...status,
      blockedReason: status.blockedReason ?? (owner ? undefined : "Only the owner can switch the database."),
      defaultSqlitePath: defaultSqlitePath(status, ctx.deps.config.database, new Date(ctx.nowMs())),
      canSwitch: owner,
    };
    if (body.blockedReason === undefined) delete body.blockedReason;
    return c.json(body);
  });

  app.post("/database/test", view, available, requireOwner(), async (c) => {
    const { target } = await readBody(c, TestBody);
    try {
      return c.json(await switcher().test(target as DatabaseTarget));
    } catch (err) {
      switcherError(err);
    }
  });

  app.post("/database/switch", view, available, requireOwner(), async (c) => {
    const p = principalOf(c);
    const { target, wipeConfirm, currentPassword } = await readBody(c, SwitchBody);
    await guard.requireFreshAuth(p, currentPassword, "switch the database");
    try {
      return c.json(await switcher().start({ target: target as DatabaseTarget, ...(wipeConfirm !== undefined ? { wipeConfirm } : {}) }, p.pubkey), 202);
    } catch (err) {
      switcherError(err);
    }
  });

  app.get("/database/switch/:id", view, available, (c) => {
    const job = switcher().job(c.req.param("id"));
    if (!job) throw notFound("switch job not found");
    return c.json(job);
  });

  app.post("/database/switch/:id/cancel", view, available, requireOwner(), (c) => {
    const id = c.req.param("id");
    const s = switcher();
    if (!s.job(id)) throw notFound("switch job not found");
    return c.json({ cancelled: s.cancel(id) });
  });

  app.delete("/database/rollback/:id", view, available, requireOwner(), async (c) => {
    const p = principalOf(c);
    const { confirm, currentPassword } = await readBody(c, DeleteRollbackBody);
    await guard.requireFreshAuth(p, currentPassword, "delete an old database");
    try {
      await switcher().deleteRollback(c.req.param("id"), confirm, p.pubkey);
    } catch (err) {
      switcherError(err);
    }
    return c.json({ ok: true });
  });
}
