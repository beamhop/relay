import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stopContext } from "@beamhop/sdk";
import { createFsDriver, type BlobDriver } from "../src";
import { authHeader, createHarness, newUser, sha256, xOf, type Harness } from "./fakes";

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const alice = newUser();
const PDF = new TextEncoder().encode("%PDF-1.4\nshutdown\n%%EOF\n");
const upload = (data: Uint8Array) =>
  h!.request("/upload", { method: "PUT", body: data as BodyInit, headers: { authorization: authHeader(alice.sk, "upload", { x: [xOf(data)] }) } });
const pending = async () => (await h!.deps.stores.db.all<{ sha256: string }>("SELECT sha256 FROM blossom_pending_deletes")).map((r) => r.sha256);

describe("blossom shutdown", () => {
  test("drain refuses new uploads and mirrors with 503; blobs are still served", async () => {
    h = await createHarness({ useSharp: false });
    const sha = await sha256(PDF);
    expect((await upload(PDF)).status).toBe(201);
    await h.svc.drain!(stopContext("test", 1_000));
    const other = new TextEncoder().encode("%PDF-1.4\nlate\n%%EOF\n");
    expect((await upload(other)).status).toBe(503);
    const mirror = await h.request("/mirror", {
      method: "PUT",
      body: JSON.stringify({ url: "https://example.com/x.pdf" }),
      headers: { "content-type": "application/json", authorization: authHeader(alice.sk, "upload", { x: [xOf(other)] }) },
    });
    expect(mirror.status).toBe(503);
    expect((await h.request(`/${sha}`)).status).toBe(200);
  });

  test("drain stops the pending-delete retries", async () => {
    const root = mkdtempSync(join(tmpdir(), "beamhop-shutdown-"));
    dirs.push(root);
    const inner = createFsDriver(root);
    const state = { failDeletes: true };
    const driver: BlobDriver = {
      ...inner,
      async delete(sha) {
        if (state.failDeletes) throw new Error("storage unavailable");
        return inner.delete(sha);
      },
    };
    h = await createHarness({ useSharp: false, driver, pendingDeleteRetryMs: 20 });
    const sha = await sha256(PDF);
    expect((await upload(PDF)).status).toBe(201);
    expect((await h.request(`/${sha}`, { method: "DELETE", headers: { authorization: authHeader(alice.sk, "delete", { x: [sha] }) } })).status).toBe(200);
    expect(await pending()).toEqual([sha]);
    await h.svc.drain!(stopContext("test", 1_000));
    state.failDeletes = false;
    await Bun.sleep(80);
    // no retry ran after the drain (the next start retries it)
    expect(await pending()).toEqual([sha]);
    expect(await driver.has(sha)).toBe(true);
  });
});
