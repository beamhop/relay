import { describe, expect, test } from "bun:test";
import { EventBus, type UserRecord, type UserStore } from "@beamhop/sdk";
import { UserCache } from "../src/users";

const rec = (pubkey: string, status: UserRecord["status"]) => ({ pubkey, status }) as UserRecord;

describe("UserCache", () => {
  test("a ban landing while a lookup is in flight isn't cached away for the TTL", async () => {
    const bus = new EventBus();
    let status: UserRecord["status"] = "active";
    let calls = 0;
    let release!: () => void;
    const store = {
      get: async (pk: string) => {
        calls++;
        const s = status;
        if (calls === 1) await new Promise<void>((r) => (release = r));
        return rec(pk, s);
      },
    } as unknown as UserStore;
    const cache = new UserCache(store, bus, []);
    const first = cache.get("p"); // reads "active", slowly
    await Bun.sleep(1);
    status = "banned";
    bus.emit("user.updated", { pubkey: "p" } as never); // nothing cached yet, but the lookup is stale
    release();
    expect((await first)?.status).toBe("active");
    expect((await cache.get("p"))?.status).toBe("banned");
    expect(calls).toBe(2);
    expect((await cache.get("p"))?.status).toBe("banned"); // now cached
    expect(calls).toBe(2);
  });

  test("concurrent misses for one pubkey share one lookup", async () => {
    let calls = 0;
    const store = {
      get: async () => {
        calls++;
        await Bun.sleep(5);
        return undefined;
      },
    } as unknown as UserStore;
    const cache = new UserCache(store, new EventBus(), []);
    await Promise.all(Array.from({ length: 50 }, () => cache.get("p")));
    expect(calls).toBe(1);
  });

  test("a failed lookup is shared by its waiters and not cached", async () => {
    let calls = 0;
    const store = {
      get: async (pk: string) => {
        calls++;
        await Bun.sleep(2);
        if (calls === 1) throw new Error("db down");
        return rec(pk, "active");
      },
    } as unknown as UserStore;
    const cache = new UserCache(store, new EventBus(), []);
    const results = await Promise.allSettled([cache.get("p"), cache.get("p")]);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect((await cache.get("p"))?.status).toBe("active");
    expect(calls).toBe(2);
  });

  test("at capacity the least recently used entry is evicted, not the whole cache", async () => {
    const seen: string[] = [];
    const store = {
      get: async (pk: string) => {
        seen.push(pk);
        return rec(pk, "active");
      },
    } as unknown as UserStore;
    const cache = new UserCache(store, new EventBus(), [], 10_000, 3);
    for (const pk of ["a", "b", "c"]) await cache.get(pk);
    await cache.get("a"); // a is now the most recently used
    await cache.get("d"); // evicts b
    seen.length = 0;
    for (const pk of ["a", "c", "d"]) await cache.get(pk);
    expect(seen).toEqual([]);
    await cache.get("b");
    expect(seen).toEqual(["b"]);
  });
});
