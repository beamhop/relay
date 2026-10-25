import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlossomService, createFsDriver } from "../src";
import { authHeader, createHarness, newUser, PNG_1x1, sha256, xOf, type Harness } from "./fakes";

let h: Harness | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempRoot = () => {
  const d = mkdtempSync(join(tmpdir(), "beamhop-fs-"));
  dirs.push(d);
  return d;
};
const hoursAgo = (n: number) => new Date(Date.now() - n * 3600_000);
const sha = "ab".repeat(32);

describe("fs driver durability", () => {
  test("has() with an expected size treats a short (torn) file as missing", async () => {
    const root = tempRoot();
    const d = createFsDriver(root);
    await d.put(sha, new Uint8Array([1, 2, 3]), "text/plain");
    expect(await d.has(sha, { size: 3 })).toBe(true);
    expect(await d.has(sha, { size: 4 })).toBe(false);
    expect(await d.has(sha)).toBe(true);
  });

  test("sweepTempFiles removes stale temp files only", async () => {
    const root = tempRoot();
    const d = createFsDriver(root);
    await d.put(sha, new Uint8Array([1]), "text/plain");
    const dir = join(root, "ab", "ab");
    const stale = join(dir, `.${sha}.0123456789ab.tmp`);
    const fresh = join(dir, `.${sha}.ba9876543210.tmp`);
    writeFileSync(stale, "partial");
    writeFileSync(fresh, "in progress");
    utimesSync(stale, hoursAgo(2), hoursAgo(2));
    // something unrelated in the root isn't touched
    mkdirSync(join(root, "lost+found"));
    writeFileSync(join(root, "lost+found", ".x.tmp"), "");
    utimesSync(join(root, "lost+found", ".x.tmp"), hoursAgo(2), hoursAgo(2));

    expect(await d.sweepTempFiles!(3600_000)).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(join(dir, sha))).toBe(true);
    expect(existsSync(join(root, "lost+found", ".x.tmp"))).toBe(true);
    // a root that doesn't exist yet is fine
    expect(await createFsDriver(join(root, "missing")).sweepTempFiles!(0)).toBe(0);
  });

  test("the service sweeps stale temp files in the background at startup", async () => {
    h = await createHarness({ useSharp: false });
    const dir = join(h.dir, "blobs", "ab", "ab");
    mkdirSync(dir, { recursive: true });
    const stale = join(dir, `.${sha}.0123456789ab.tmp`);
    writeFileSync(stale, "partial");
    utimesSync(stale, hoursAgo(2), hoursAgo(2));
    // "restart" over the same storage
    await createBlossomService(h.deps as never, { useSharp: false });
    for (let i = 0; i < 100 && existsSync(stale); i++) await new Promise((r) => setTimeout(r, 10));
    expect(existsSync(stale)).toBe(false);
  });

  test("a re-upload repairs a stored file of the wrong size", async () => {
    h = await createHarness({ useSharp: false });
    const alice = newUser();
    const put = () => h!.request("/upload", { method: "PUT", body: PNG_1x1 as BodyInit, headers: { authorization: authHeader(alice.sk, "upload", { x: [xOf(PNG_1x1)] }) } });
    expect((await put()).status).toBe(201);
    const x = await sha256(PNG_1x1);
    const path = join(h.dir, "blobs", x.slice(0, 2), x.slice(2, 4), x);
    truncateSync(path, 10);
    expect((await put()).status).toBe(200);
    expect(new Uint8Array(readFileSync(path))).toEqual(PNG_1x1);
  });
});
