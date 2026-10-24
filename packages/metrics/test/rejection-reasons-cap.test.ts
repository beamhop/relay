import { describe, expect, test } from "bun:test";
import { createMemoryDb } from "@beamhop/storage";
import { OTHER_REASON, Rollup } from "../src/rollup";
import { migrations } from "../src/schema";

const T = 1_700_000_000 - (1_700_000_000 % 3600) + 60;

describe("rejection reasons are capped per hour", () => {
  test("client-controlled reason text can't add unbounded rows: past the cap it counts as (other) per code", async () => {
    const db = await createMemoryDb();
    await db.migrate("metrics", migrations);
    const r = new Rollup(db, T, { maxPubkeysPerBucket: 10, topPubkeysPerHour: 10, maxRejectionReasonsPerHour: 3 });
    for (let i = 0; i < 10; i++) r.hour.rejection("pow", `committed target attacker-${i} is less than <n>`);
    // a flush mid-hour starts a new accumulator: the cap still counts the whole hour
    await r.flush();
    for (let i = 10; i < 20; i++) r.hour.rejection("invalid", `reason ${String.fromCharCode(97 + i)}`);
    r.hour.rejection("pow", "committed target attacker-0 is less than <n>"); // admitted before: still its own row
    await r.flush();
    const rows = await r.rejections({ from: T - 3600, to: T + 3600 });
    expect(rows.length).toBe(5);
    expect(rows.filter((x) => x.reason !== OTHER_REASON).length).toBe(3);
    expect(rows.find((x) => x.code === "pow" && x.reason === OTHER_REASON)?.count).toBe(7);
    expect(rows.find((x) => x.code === "invalid" && x.reason === OTHER_REASON)?.count).toBe(10);
    expect(rows.find((x) => x.reason === "committed target attacker-0 is less than <n>")?.count).toBe(2);
    expect(rows.reduce((n, x) => n + x.count, 0)).toBe(21);
    await db.close();
  });

  test("a new hour starts with a fresh budget", async () => {
    const db = await createMemoryDb();
    await db.migrate("metrics", migrations);
    const r = new Rollup(db, T, { maxPubkeysPerBucket: 10, topPubkeysPerHour: 10, maxRejectionReasonsPerHour: 1 });
    r.hour.rejection("blocked", "a");
    r.hour.rejection("blocked", "b");
    r.advance(T + 3600);
    r.hour.rejection("blocked", "c");
    await r.flush();
    const rows = await r.rejections({ from: T - 3600, to: T + 7200 });
    expect(rows.map((x) => x.reason).sort()).toEqual([OTHER_REASON, "a", "c"]);
    await db.close();
  });
});
