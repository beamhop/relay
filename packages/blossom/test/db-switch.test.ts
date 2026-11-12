import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, EventBus, HookRegistry, createLogger } from "@beamhop/sdk";
import { createMemoryDb } from "@beamhop/storage";
import { createBlossomService, type BlossomServiceImpl } from "../src";
import { DB_SWITCHING_REASON } from "../src/http";
import { FakeDbSwitch, pausableDb } from "../../core/test/db-switch-fake";
import { authHeader, createFakeSettings, createFakeStores, newUser, PNG_1x1, sha256, xOf } from "./fakes";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "beamhop-blossom-switch-"));
  const config = ConfigSchema.parse({ server: { publicUrl: "https://cdn.example.com" }, blossom: { fsPath: join(dir, "blobs") } });
  const sw = new FakeDbSwitch();
  const stores = { ...(await createFakeStores()), dbSwitch: sw };
  stores.db = pausableDb(stores.db, sw);
  const deps = { config, stores, settings: createFakeSettings(), hooks: new HookRegistry(), bus: new EventBus(), logger: createLogger("error") };
  const svc: BlossomServiceImpl = await createBlossomService(deps, { useSharp: false });
  cleanups.push(async () => {
    await svc.stop?.({ reason: "test", signal: AbortSignal.timeout(1000), deadline: Date.now() + 1000 });
    await stores.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const request = (path: string, init?: RequestInit) => svc.app.fetch(new Request(`https://cdn.example.com${path}`, init));
  const blobFiles = () => {
    const root = join(dir, "blobs");
    if (!existsSync(root)) return [] as string[];
    return (readdirSync(root, { recursive: true }) as string[]).filter((f) => /[0-9a-f]{64}$/.test(f));
  };
  return { sw, svc, request, blobFiles, stores };
}

const alice = newUser();
const PDF = new TextEncoder().encode("%PDF-1.4\ndb-switch\n%%EOF\n");
const upload = (h: Awaited<ReturnType<typeof harness>>, data: Uint8Array) =>
  h.request("/upload", { method: "PUT", body: data as BodyInit, headers: { authorization: authHeader(alice.sk, "upload", { x: [xOf(data)] }) } });

describe("blossom during a database switch", () => {
  test("uploads get 503 + Retry-After + X-Reason, leave no orphaned bytes, and work again after resume", async () => {
    const h = await harness();
    h.sw.retryAfterSec = 7;
    h.sw.pause();
    const res = await upload(h, PDF);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(res.headers.get("x-reason")).toBe(DB_SWITCHING_REASON);
    expect(await res.text()).toBe(DB_SWITCHING_REASON);
    // the bytes written before the metadata insert failed were discarded
    expect(h.blobFiles()).toEqual([]);

    h.sw.resume();
    const ok = await upload(h, PDF);
    expect(ok.status).toBe(201);
    expect(h.blobFiles()).toHaveLength(1);
  });

  test("downloads keep working; deletes get 503", async () => {
    const h = await harness();
    const sha = await sha256(PNG_1x1);
    expect((await upload(h, PNG_1x1)).status).toBe(201);
    h.sw.pause();
    const get = await h.request(`/${sha}`);
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(PNG_1x1);
    const del = await h.request(`/${sha}`, { method: "DELETE", headers: { authorization: authHeader(alice.sk, "delete", { x: [sha] }) } });
    expect(del.status).toBe(503);
    expect(del.headers.get("retry-after")).toBe("5");
    h.sw.resume();
    expect((await h.request(`/${sha}`)).status).toBe(200);
  });

  test("registers an onSwapped hook that drops the used delete-token cache; stop() removes it", async () => {
    const h = await harness();
    expect(h.sw.swapped.map((x) => x.name)).toContain("blossom");
    await h.sw.runSwapped();
    await h.svc.stop?.({ reason: "test", signal: AbortSignal.timeout(1000), deadline: Date.now() + 1000 });
    expect(h.sw.swapped.map((x) => x.name)).not.toContain("blossom");
  });
});
