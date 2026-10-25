import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsDriver, type BlobDriver } from "../src";
import { BlobRepo } from "../src/repo";
import { authHeader, createHarness, newUser, PNG_1x1, sha256, xOf, type Harness } from "./fakes";

let h: Harness | undefined;
const P = BlobRepo.prototype as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
const saved = { ...Object.fromEntries(Object.getOwnPropertyNames(BlobRepo.prototype).map((k) => [k, P[k]])) };
const dirs: string[] = [];
afterEach(async () => {
  Object.assign(P, saved);
  await h?.cleanup();
  h = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const alice = newUser();
const PDF = new TextEncoder().encode("%PDF-1.4\nblob-transactions\n%%EOF\n");
const upload = (data: Uint8Array, u = alice) =>
  h!.request("/upload", { method: "PUT", body: data as BodyInit, headers: { authorization: authHeader(u.sk, "upload", { x: [xOf(data)] }) } });
const del = (sha: string, u = alice) => h!.request(`/${sha}`, { method: "DELETE", headers: { authorization: authHeader(u.sk, "delete", { x: [sha] }) } });
const blobPath = (sha: string) => join(h!.dir, "blobs", sha.slice(0, 2), sha.slice(2, 4), sha);
const pending = async () => (await h!.deps.stores.db.all<{ sha256: string }>("SELECT sha256 FROM blossom_pending_deletes")).map((r) => r.sha256);
const waitFor = async (cond: () => Promise<boolean>, ms = 2000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) if (await cond()) return;
  throw new Error("condition not met in time");
};

/** FS driver whose deletes can be made to fail */
function flakyDriver() {
  const root = mkdtempSync(join(tmpdir(), "beamhop-flaky-"));
  dirs.push(root);
  const inner = createFsDriver(root);
  const state = { failDeletes: false };
  const driver: BlobDriver = {
    ...inner,
    async delete(sha) {
      if (state.failDeletes) throw new Error("storage unavailable");
      return inner.delete(sha);
    },
  };
  return { driver, state };
}

describe("upload rows commit together", () => {
  test("a database error after the insert leaves neither a row without data nor data deleted under a row", async () => {
    h = await createHarness({ useSharp: false });
    const sha = await sha256(PDF);
    let outage = false;
    const { insert, addOwner, get } = saved;
    P.insert = async function (this: unknown, ...a: unknown[]) {
      const r = await insert.apply(this, a);
      outage = true;
      return r;
    };
    P.get = async function (this: unknown, ...a: unknown[]) {
      if (outage) throw new Error("db blip");
      return get.apply(this, a);
    };
    P.addOwner = async function (this: unknown, ...a: unknown[]) {
      if (outage) throw new Error("db blip");
      return addOwner.apply(this, a);
    };
    expect((await upload(PDF)).status).toBe(500);
    Object.assign(P, saved);
    // the insert was rolled back with the failed owner insert
    expect(await h.svc.get(sha)).toBeUndefined();
    expect((await h.request(`/${sha}`)).status).toBe(404);
    // the lookup that would decide about the bytes failed too: they're queued, not deleted blindly
    expect(existsSync(blobPath(sha))).toBe(true);
    expect(await pending()).toEqual([sha]);
    // an upload now works and takes the queued bytes back
    expect((await upload(PDF)).status).toBe(201);
    expect((await h.request(`/${sha}`)).status).toBe(200);
  });

  test("bytes of a refused upload are deleted once the row is positively absent", async () => {
    h = await createHarness({ useSharp: false });
    await h.deps.stores.users.upsert(alice.pubkey, { blossomQuota: 10 });
    const sha = await sha256(PDF);
    expect((await upload(PDF)).status).toBe(413);
    expect(existsSync(blobPath(sha))).toBe(false);
    expect(await pending()).toEqual([]);
  });
});

describe("owner deletes commit together", () => {
  test("a failure mid-release changes nothing and the same token works on retry", async () => {
    h = await createHarness({ useSharp: false });
    const sha = await sha256(PDF);
    expect((await upload(PDF)).status).toBe(201);
    P.ownerCount = async () => {
      throw new Error("db blip");
    };
    const token = authHeader(alice.sk, "delete", { x: [sha] });
    expect((await h.request(`/${sha}`, { method: "DELETE", headers: { authorization: token } })).status).toBe(500);
    Object.assign(P, saved);
    // owner removal, deletion record and used token were rolled back together
    expect((await h.svc.get(sha))?.owners).toEqual([alice.pubkey]);
    expect(await h.deps.stores.db.get("SELECT 1 FROM blossom_deletions WHERE sha256 = ?", [sha])).toBeUndefined();
    expect((await h.request(`/${sha}`)).status).toBe(200);
    expect((await h.request(`/${sha}`, { method: "DELETE", headers: { authorization: token } })).status).toBe(200);
    expect(await h.svc.get(sha)).toBeUndefined();
    expect(existsSync(blobPath(sha))).toBe(false);
  });
});

describe("failed byte deletions are retried", () => {
  test("a delete the driver failed is queued and retried while the blob has no row", async () => {
    const { driver, state } = flakyDriver();
    h = await createHarness({ useSharp: false, driver, pendingDeleteRetryMs: 20 });
    const sha = await sha256(PDF);
    expect((await upload(PDF)).status).toBe(201);
    state.failDeletes = true;
    expect((await del(sha)).status).toBe(200);
    expect(await h.svc.get(sha)).toBeUndefined();
    expect(await driver.has(sha)).toBe(true);
    expect(await pending()).toEqual([sha]);
    state.failDeletes = false;
    await waitFor(async () => (await pending()).length === 0);
    expect(await driver.has(sha)).toBe(false);
  });

  test("a queued delete of a blob uploaded again keeps its bytes", async () => {
    const { driver, state } = flakyDriver();
    h = await createHarness({ useSharp: false, driver, pendingDeleteRetryMs: 20 });
    const sha = await sha256(PNG_1x1);
    expect((await upload(PNG_1x1)).status).toBe(201);
    state.failDeletes = true;
    expect((await h.request(`/${sha}`, { method: "DELETE", headers: { authorization: authHeader(alice.sk, "delete", { x: [sha] }) } })).status).toBe(200);
    state.failDeletes = false;
    // uploaded again (by someone whose tokens the delete didn't void) before the retry ran
    const bob = newUser();
    expect((await upload(PNG_1x1, bob)).status).toBe(201);
    await waitFor(async () => (await pending()).length === 0);
    expect((await h.request(`/${sha}`)).status).toBe(200);
  });
});

describe("admin deletes", () => {
  test("deleteByPubkey releases every blob and audits the count", async () => {
    h = await createHarness({ useSharp: false });
    const blobs = Array.from({ length: 9 }, (_, i) => new TextEncoder().encode(`%PDF-1.4\nblob ${i}\n%%EOF\n`));
    for (const b of blobs) expect((await upload(b)).status).toBe(201);
    expect(await h.svc.deleteByPubkey(alice.pubkey, "admin")).toBe(9);
    expect((await h.svc.list({ pubkey: alice.pubkey })).total).toBe(0);
    expect(h.deps.stores.audit.entries.at(-1)).toMatchObject({ action: "blob.deleteByPubkey", details: { count: 9 } });
  });

  test("deleteByPubkey audits what it managed when a blob fails", async () => {
    h = await createHarness({ useSharp: false });
    const blobs = Array.from({ length: 6 }, (_, i) => new TextEncoder().encode(`%PDF-1.4\nblob ${i}\n%%EOF\n`));
    for (const b of blobs) expect((await upload(b)).status).toBe(201);
    const failing = await sha256(blobs[3]);
    const { removeOwner } = saved;
    P.removeOwner = async function (this: unknown, ...a: unknown[]) {
      if (a[0] === failing) throw new Error("db blip");
      return removeOwner.apply(this, a);
    };
    await expect(h.svc.deleteByPubkey(alice.pubkey, "admin")).rejects.toThrow("db blip");
    const entry = h.deps.stores.audit.entries.at(-1)!;
    expect(entry.action).toBe("blob.deleteByPubkey");
    const { count } = entry.details as { count: number; incomplete: boolean };
    expect(count).toBeGreaterThan(0);
    expect(entry.details).toMatchObject({ of: 6, incomplete: true });
    Object.assign(P, saved);
    expect((await h.svc.list({ pubkey: alice.pubkey })).total).toBe(6 - count);
  });
});
