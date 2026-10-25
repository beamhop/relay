import { afterEach, describe, expect, test } from "bun:test";
import { createBlossomService } from "../src";
import { authHeader, createHarness, newUser, PNG_1x1, sha256, xOf, type Harness } from "./fakes";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});
const alice = newUser();
const count = async (sql: string) => Number((await h!.deps.stores.db.get<{ n: number }>(sql))?.n);

describe("kv entries of older versions move to blossom tables", () => {
  test("held statuses and used delete tokens survive the upgrade; expired tokens are dropped", async () => {
    h = await createHarness({ useSharp: false });
    const x = await sha256(PNG_1x1);
    const kv = h.deps.stores.kv;
    await kv.set("blossom-held-status", x, { status: "pending", by: "mod" });
    await kv.set("blossom-held-status", "c".repeat(64), "blocked"); // oldest format: the bare status
    await kv.set("blossom-used-delete-tokens", `event:${x}`, Date.now() + 60_000);
    await kv.set("blossom-used-delete-tokens", "event:old", Date.now() - 1);

    const svc = await createBlossomService(h.deps as never, { useSharp: false });
    expect(await kv.list("blossom-held-status")).toEqual({});
    expect(await kv.list("blossom-used-delete-tokens")).toEqual({});
    expect(await count("SELECT COUNT(*) AS n FROM blossom_held")).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM blossom_used_tokens")).toBe(1);

    // the held status still applies to a re-upload
    const res = await svc.app.fetch(
      new Request("https://cdn.example.com/upload", { method: "PUT", body: PNG_1x1 as BodyInit, headers: { authorization: authHeader(alice.sk, "upload", { x: [xOf(PNG_1x1)] }) } }),
    );
    expect(res.status).toBe(201);
    expect(await svc.get(x)).toMatchObject({ status: "pending", moderatedBy: "mod" });
    expect(await count("SELECT COUNT(*) AS n FROM blossom_held")).toBe(1);
  });

  test("expired used delete tokens are pruned at startup", async () => {
    h = await createHarness({ useSharp: false });
    await h.deps.stores.db.run("INSERT INTO blossom_used_tokens (id, expires_at) VALUES (?, ?), (?, ?)", ["a", Date.now() - 1, "b", Date.now() + 60_000]);
    await createBlossomService(h.deps as never, { useSharp: false });
    for (let i = 0; i < 50 && (await count("SELECT COUNT(*) AS n FROM blossom_used_tokens")) !== 1; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await h.deps.stores.db.all<{ id: string }>("SELECT id FROM blossom_used_tokens")).map((r) => r.id)).toEqual(["b"]);
  });
});
