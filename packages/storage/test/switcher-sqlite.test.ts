import { describe, expect, test } from "bun:test";
import { ConfigSchema, type DatabaseStateFile } from "@beamhop/sdk";
import { createDb, createDatabaseSwitcher, createStores, silentLogger } from "../src";
import { signer } from "./helpers";
import { tempSqlite } from "./transfer-helpers";

describe("database switcher on real SQLite files", () => {
  test("switches a live store set to another file and freezes the old one", async () => {
    const from = tempSqlite("old.db");
    const to = tempSqlite("new.db");
    const config = ConfigSchema.parse({ database: { driver: "sqlite", sqlitePath: from } });
    const stores = await createStores(config, silentLogger);
    const alice = signer();
    const ev = alice.sign({ kind: 1, created_at: 1_700_000_000, content: "before the switch" });
    expect((await stores.events.save(ev)).status).toBe("saved");
    await stores.kv.set("test", "k", { v: 1 });

    let state: DatabaseStateFile | undefined;
    const audits: string[] = [];
    const sw = createDatabaseSwitcher({
      db: stores.swappable,
      logger: silentLogger,
      initial: { driver: "sqlite", sqlitePath: from },
      envPinned: false,
      readState: () => state,
      writeState: async (s) => {
        state = s;
      },
      instances: async () => [{ id: "me", seenAt: 0, self: true }],
      audit: async (e) => {
        await stores.audit.record({ ...e, ip: null });
        audits.push(e.action);
      },
    });
    const test1 = await sw.test({ driver: "sqlite", sqlitePath: to });
    expect(test1).toMatchObject({ ok: true, empty: true });
    const job = await sw.start({ target: { driver: "sqlite", sqlitePath: to } }, "owner");
    await sw.whenIdle();
    const done = sw.job(job.id)!;
    expect(done.error).toBeUndefined();
    expect(done.phase).toBe("done");
    expect(audits).toEqual(["db.switch.start", "db.switch.done"]);
    expect(state!.current).toEqual({ driver: "sqlite", sqlitePath: to });
    expect(state!.rollbacks[0].target).toEqual({ driver: "sqlite", sqlitePath: from });

    // the stores now read and write the new file
    expect((await stores.events.query([{ ids: [ev.id] }]))[0]?.content).toBe("before the switch");
    expect(await stores.kv.get("test", "k")).toEqual({ v: 1 });
    const ev2 = alice.sign({ kind: 1, created_at: 1_700_000_100, content: "after the switch" });
    expect((await stores.events.save(ev2)).status).toBe("saved");
    const status = await sw.status();
    expect(status.current).toEqual({ driver: "sqlite", sqlitePath: to });
    expect(status.tables.find((t) => t.name === "events")?.rows).toBe(2);
    expect(status.rollbacks).toHaveLength(1);

    const old = await createDb({ database: { driver: "sqlite", sqlitePath: from } });
    const marker = await old.get<{ value: string }>("SELECT value FROM kv WHERE namespace = 'server' AND key = 'frozenAt'");
    expect(JSON.parse(marker!.value)).toMatchObject({ replacedBy: "sqlite" });
    expect((await old.get<{ n: number }>("SELECT COUNT(*) AS n FROM events"))!.n).toBe(1);
    await old.close();

    // switching back onto the frozen file is refused; deleting it removes it from the state
    await expect(sw.start({ target: { driver: "sqlite", sqlitePath: from } }, "owner")).rejects.toThrow(/rollback point/);
    await sw.deleteRollback(state!.rollbacks[0].id, "delete old database", "owner");
    expect(state!.rollbacks).toEqual([]);
    expect(await Bun.file(from).exists()).toBe(false);
    await stores.close();
  });
});
