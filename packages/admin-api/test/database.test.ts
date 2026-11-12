import { describe, expect, test } from "bun:test";
import type { DatabaseStatus, DatabaseSwitcher, DatabaseSwitchJobView, DatabaseSwitchRequest, DatabaseTarget } from "@beamhop/sdk";
import { DELETE_ROLLBACK_CONFIRM_PHRASE } from "@beamhop/sdk";
import { defaultSqlitePath } from "../src/routes/database";
import { createHarness } from "./fakes";

type Harness = Awaited<ReturnType<typeof createHarness>>;

const JOB: DatabaseSwitchJobView = {
  id: "job-1",
  from: { driver: "sqlite", sqlitePath: "/data/beamhop.db" },
  to: { driver: "postgres", postgresUrl: "postgres://u:***@h/db" },
  phase: "bulk_copy",
  startedAt: 1,
  tables: [],
  cancellable: true,
  actor: "x",
};

function fakeSwitcher() {
  const calls = { start: [] as { req: DatabaseSwitchRequest; actor: string }[], test: [] as DatabaseTarget[], cancel: [] as string[], deleted: [] as { id: string; confirm: string; actor: string }[] };
  let startError: Error | undefined;
  const status: DatabaseStatus = {
    current: { driver: "sqlite", sqlitePath: "/data/beamhop.db" },
    tables: [{ name: "events", rows: 3 }],
    envPinned: false,
    instances: [],
    rollbacks: [],
  };
  const sw: DatabaseSwitcher & { calls: typeof calls; failStart(e: Error): void; status_: DatabaseStatus } = {
    calls,
    status_: status,
    failStart: (e) => (startError = e),
    status: async () => status,
    test: async (t) => {
      calls.test.push(t);
      return { ok: true, reachable: true, empty: true, existingTables: [], sameAsCurrent: false, errors: [] };
    },
    start: async (req, actor) => {
      if (startError) throw startError;
      calls.start.push({ req, actor });
      return JOB;
    },
    job: (id) => (id === JOB.id ? JOB : undefined),
    cancel: (id) => {
      calls.cancel.push(id);
      return true;
    },
    deleteRollback: async (id, confirm, actor) => {
      if (confirm !== DELETE_ROLLBACK_CONFIRM_PHRASE) throw Object.assign(new Error("type it"), { code: "db_confirm_mismatch" });
      calls.deleted.push({ id, confirm, actor });
    },
  };
  return sw;
}

async function setup() {
  const h = await createHarness();
  const sw = fakeSwitcher();
  h.deps.databaseSwitcher = sw;
  return { h, sw };
}

const PG = { driver: "postgres", postgresUrl: "postgres://u:pw@h/db" };

/** an owner session older than the re-auth window, with a password set before it began */
async function staleOwnerSession(h: Harness, password = "the-password") {
  const first = await h.login(h.owner);
  expect((await h.withCookie(first, "/auth/password/set", { method: "POST", body: { password } })).status).toBe(200);
  h.clock.now += 1000;
  const cookie = await h.login(h.owner);
  h.clock.now += 20 * 60_000;
  return cookie;
}

describe("database routes", () => {
  test("501 db_switch_unavailable on every route when the server has no switcher", async () => {
    const h = await createHarness();
    const routes: [string, string, unknown?][] = [
      ["GET", "/database"],
      ["POST", "/database/test", { target: PG }],
      ["POST", "/database/switch", { target: PG }],
      ["GET", "/database/switch/x"],
      ["POST", "/database/switch/x/cancel"],
      ["DELETE", "/database/rollback/x", { confirm: DELETE_ROLLBACK_CONFIRM_PHRASE }],
    ];
    for (const [method, path, body] of routes) {
      const res = await h.asKey(h.owner, path, { method, body });
      expect(res.status).toBe(501);
      expect(((await res.json()) as { code: string }).code).toBe("db_switch_unavailable");
    }
    expect((await h.req("/database")).status).toBe(401);
  });

  test("viewing needs settings.edit; only the owner can switch", async () => {
    const { h } = await setup();
    const viewer = await h.addAdmin("viewer");
    const mod = await h.addAdmin("moderator");
    const admin = await h.addAdmin("admin");
    expect((await h.req("/database")).status).toBe(401);
    expect((await h.asKey(viewer, "/database")).status).toBe(403);
    expect((await h.asKey(mod, "/database")).status).toBe(403);
    const asAdmin = await h.asKey(admin, "/database");
    expect(asAdmin.status).toBe(200);
    const a = (await asAdmin.json()) as { canSwitch: boolean; blockedReason?: string; defaultSqlitePath: string };
    expect(a.canSwitch).toBe(false);
    expect(a.blockedReason).toContain("Only the owner");
    expect(a.defaultSqlitePath).toBe("/data/beamhop-" + new Date(h.clock.now).toISOString().slice(0, 10) + ".db");
    const o = (await (await h.asKey(h.owner, "/database")).json()) as { canSwitch: boolean; blockedReason?: string };
    expect(o.canSwitch).toBe(true);
    expect(o.blockedReason).toBeUndefined();
    expect((await h.asKey(admin, "/database/switch/job-1")).status).toBe(200);
    for (const [method, path, body] of [
      ["POST", "/database/test", { target: PG }],
      ["POST", "/database/switch", { target: PG }],
      ["POST", "/database/switch/job-1/cancel", undefined],
      ["DELETE", "/database/rollback/r1", { confirm: DELETE_ROLLBACK_CONFIRM_PHRASE }],
    ] as const) {
      const res = await h.asKey(admin, path, { method, body });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("owner_only");
    }
  });

  test("switch: fresh login, NIP-98 or the current password", async () => {
    const { h, sw } = await setup();
    const fresh = await h.login(h.owner);
    const ok = await h.withCookie(fresh, "/database/switch", { method: "POST", body: { target: PG } });
    expect(ok.status).toBe(202);
    expect(((await ok.json()) as DatabaseSwitchJobView).id).toBe("job-1");
    expect(sw.calls.start[0]).toEqual({ req: { target: PG as DatabaseTarget }, actor: h.owner.pk });
    expect((await h.asKey(h.owner, "/database/switch", { method: "POST", body: { target: PG, wipeConfirm: "wipe target database" } })).status).toBe(202);
    expect(sw.calls.start[1].req.wipeConfirm).toBe("wipe target database");

    const stale = await staleOwnerSession(h);
    const refused = await h.withCookie(stale, "/database/switch", { method: "POST", body: { target: PG } });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe("reauth_required");
    expect((await h.withCookie(stale, "/database/switch", { method: "POST", body: { target: PG, currentPassword: "wrong" } })).status).toBe(403);
    expect((await h.withCookie(stale, "/database/switch", { method: "POST", body: { target: PG, currentPassword: "the-password" } })).status).toBe(202);
    expect(sw.calls.start).toHaveLength(3);
  });

  test("targets are validated", async () => {
    const { h, sw } = await setup();
    const post = (target: unknown) => h.asKey(h.owner, "/database/test", { method: "POST", body: { target } });
    expect((await post({ driver: "postgres", postgresUrl: "mysql://x/y" })).status).toBe(400);
    expect((await post({ driver: "sqlite", sqlitePath: "data/beamhop.db" })).status).toBe(400);
    expect((await post({ driver: "oracle" })).status).toBe(400);
    expect((await post({ driver: "postgres", postgresUrl: "env" })).status).toBe(200);
    expect((await post({ driver: "postgres", postgresUrl: "postgresql://u@h/db" })).status).toBe(200);
    expect((await post({ driver: "sqlite", sqlitePath: "/tmp/x.db" })).status).toBe(200);
    expect(sw.calls.test).toEqual([
      { driver: "postgres", postgresUrl: "env" },
      { driver: "postgres", postgresUrl: "postgresql://u@h/db" },
      { driver: "sqlite", sqlitePath: "/tmp/x.db" },
    ]);
  });

  test("switcher refusals map to 4xx with their code and message", async () => {
    const { h, sw } = await setup();
    sw.failStart(Object.assign(new Error("the target database is not empty"), { code: "db_target_not_empty" }));
    const res = await h.asKey(h.owner, "/database/switch", { method: "POST", body: { target: PG } });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "the target database is not empty", code: "db_target_not_empty" });
    sw.failStart(new Error("boom"));
    expect((await h.asKey(h.owner, "/database/switch", { method: "POST", body: { target: PG } })).status).toBe(500);
  });

  test("job, cancel and rollback deletion", async () => {
    const { h, sw } = await setup();
    expect((await h.asKey(h.owner, "/database/switch/nope")).status).toBe(404);
    expect((await h.asKey(h.owner, "/database/switch/nope/cancel", { method: "POST" })).status).toBe(404);
    expect(await (await h.asKey(h.owner, "/database/switch/job-1/cancel", { method: "POST" })).json()).toEqual({ cancelled: true });
    expect(sw.calls.cancel).toEqual(["job-1"]);

    const bad = await h.asKey(h.owner, "/database/rollback/r1", { method: "DELETE", body: { confirm: "nope" } });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe("db_confirm_mismatch");
    const stale = await staleOwnerSession(h);
    const refused = await h.withCookie(stale, "/database/rollback/r1", { method: "DELETE", body: { confirm: DELETE_ROLLBACK_CONFIRM_PHRASE } });
    expect(((await refused.json()) as { code: string }).code).toBe("reauth_required");
    const ok = await h.withCookie(stale, "/database/rollback/r1", { method: "DELETE", body: { confirm: DELETE_ROLLBACK_CONFIRM_PHRASE, currentPassword: "the-password" } });
    expect(ok.status).toBe(200);
    expect(sw.calls.deleted).toEqual([{ id: "r1", confirm: DELETE_ROLLBACK_CONFIRM_PHRASE, actor: h.owner.pk }]);
  });
});

describe("defaultSqlitePath", () => {
  const base: DatabaseStatus = { current: { driver: "postgres", postgresUrl: "postgres://h/db" }, tables: [], envPinned: false, instances: [], rollbacks: [] };
  const day = new Date("2026-11-12T10:00:00Z");
  test("beamhop.db next to the state file while on postgres", () => {
    expect(defaultSqlitePath(base, { sqlitePath: "./data/beamhop.db", stateFile: "/srv/data/database.json" }, day)).toBe("/srv/data/beamhop.db");
  });
  test("a dated name when beamhop.db is current or a rollback point", () => {
    const cur: DatabaseStatus = { ...base, current: { driver: "sqlite", sqlitePath: "/srv/data/beamhop.db" } };
    expect(defaultSqlitePath(cur, { sqlitePath: "/srv/data/beamhop.db" }, day)).toBe("/srv/data/beamhop-2026-11-12.db");
    const rb: DatabaseStatus = {
      ...base,
      rollbacks: [
        { id: "a", target: { driver: "sqlite", sqlitePath: "/srv/data/beamhop.db" }, frozenAt: 1, replacedBy: "postgres" },
        { id: "b", target: { driver: "sqlite", sqlitePath: "/srv/data/beamhop-2026-11-12.db" }, frozenAt: 2, replacedBy: "postgres" },
      ],
    };
    expect(defaultSqlitePath(rb, { sqlitePath: "/x/beamhop.db", stateFile: "/srv/data/database.json" }, day)).toBe("/srv/data/beamhop-2026-11-12-2.db");
  });
});
