/**
 * Storage backend of the relays the e2e suites boot. SQLite + filesystem blobs unless the environment says otherwise:
 *
 *   BEAMHOP_E2E_DB=postgres     BEAMHOP_E2E_PG_URL=postgres://user:pass@127.0.0.1:5432/db   (falls back to BEAMHOP_TEST_PG)
 *   BEAMHOP_E2E_BLOBS=s3        BEAMHOP_E2E_S3_ENDPOINT=http://127.0.0.1:9000
 *                               BEAMHOP_E2E_S3_ACCESS_KEY_ID=…  BEAMHOP_E2E_S3_SECRET_ACCESS_KEY=…
 *                               [BEAMHOP_E2E_S3_BUCKET=prefix (default beamhop-e2e)]  [BEAMHOP_E2E_S3_REGION=us-east-1]
 *
 * Every relay data dir gets its own Postgres schema (`e2e_<random>`, via search_path) and its own bucket
 * (`<prefix>-<random>`), so relays never see each other's rows or blobs. Both live as long as the dir: a restart on
 * the same dir finds them again, `releaseBackend(dir)` (called by the helpers when they remove a dir) drops them.
 * The Postgres role needs CREATE on the database; the S3 key needs CreateBucket/DeleteBucket/ListBucket.
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export type E2eDb = "sqlite" | "postgres";
export type E2eBlobs = "fs" | "s3";

function pick<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = (process.env[name] || fallback).toLowerCase() as T;
  if (!allowed.includes(v)) throw new Error(`${name}=${v}: expected one of ${allowed.join(", ")}`);
  return v;
}

export const E2E_DB: E2eDb = pick("BEAMHOP_E2E_DB", ["sqlite", "postgres"], "sqlite");
export const E2E_BLOBS: E2eBlobs = pick("BEAMHOP_E2E_BLOBS", ["fs", "s3"], "fs");

function required(name: string, fallback?: string): string {
  const v = process.env[name] || fallback;
  if (!v) throw new Error(`${name} is required when BEAMHOP_E2E_DB=postgres / BEAMHOP_E2E_BLOBS=s3 (see e2e/harness/backend.ts)`);
  return v;
}

interface Provisioned {
  overrides: Record<string, unknown>;
  release(): Promise<void>;
}
const byDir = new Map<string, Promise<Provisioned>>();

type Pg = { unsafe(q: string): Promise<unknown>; end(): Promise<void> };
let pgAdmin: Pg | undefined;
async function pg(): Promise<Pg> {
  if (!pgAdmin) {
    const { default: postgres } = await import("../../packages/storage/node_modules/postgres");
    pgAdmin = postgres(required("BEAMHOP_E2E_PG_URL", process.env.BEAMHOP_TEST_PG), { max: 1, idle_timeout: 2, onnotice: () => {} }) as unknown as Pg;
  }
  return pgAdmin;
}

async function s3() {
  const { AwsClient } = await import("../../packages/blossom/node_modules/aws4fetch");
  const endpoint = required("BEAMHOP_E2E_S3_ENDPOINT").replace(/\/+$/, "");
  const accessKeyId = required("BEAMHOP_E2E_S3_ACCESS_KEY_ID");
  const secretAccessKey = required("BEAMHOP_E2E_S3_SECRET_ACCESS_KEY");
  const region = process.env.BEAMHOP_E2E_S3_REGION || "us-east-1";
  const client = new AwsClient({ accessKeyId, secretAccessKey, region, service: "s3" });
  const call = async (method: string, path: string, body?: string) => {
    const res = await client.fetch(`${endpoint}/${path}`, { method, body });
    const text = await res.text();
    if (!res.ok && res.status !== 404) throw new Error(`s3 ${method} /${path}: ${res.status} ${text.slice(0, 200)}`);
    return text;
  };
  return { endpoint, accessKeyId, secretAccessKey, region, call };
}

async function provision(): Promise<Provisioned> {
  const overrides: Record<string, unknown> = {};
  const releases: (() => Promise<void>)[] = [];
  const id = randomBytes(5).toString("hex");
  if (E2E_DB === "postgres") {
    const admin = await pg();
    const schema = `e2e_${id}`;
    await admin.unsafe(`CREATE SCHEMA ${schema}`);
    const url = new URL(required("BEAMHOP_E2E_PG_URL", process.env.BEAMHOP_TEST_PG));
    url.searchParams.set("search_path", schema);
    overrides.database = { driver: "postgres", postgresUrl: url.toString() };
    releases.push(async () => void (await (await pg()).unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)));
  }
  if (E2E_BLOBS === "s3") {
    const s = await s3();
    const bucket = `${process.env.BEAMHOP_E2E_S3_BUCKET || "beamhop-e2e"}-${id}`;
    await s.call("PUT", bucket);
    overrides.blossom = {
      driver: "s3",
      s3: { endpoint: s.endpoint, region: s.region, bucket, accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    };
    releases.push(async () => {
      // ListObjectsV2 pages of ≤1000 keys; delete each, then the (now empty) bucket
      for (;;) {
        const keys = [...(await s.call("GET", `${bucket}?list-type=2`)).matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!);
        if (!keys.length) break;
        await Promise.all(keys.map((k) => s.call("DELETE", `${bucket}/${encodeURIComponent(k)}`)));
      }
      await s.call("DELETE", bucket);
    });
  }
  return { overrides, release: async () => void (await Promise.allSettled(releases.map((r) => r()))) };
}

/**
 * Config overrides that put the relay on `dir` onto the selected backend (none for SQLite + fs: the helpers' own
 * `database.sqlitePath` / `blossom.fsPath` under the dir apply). Same dir → same schema/bucket.
 */
export async function backendOverrides(dir: string): Promise<Record<string, unknown>> {
  if (E2E_DB === "sqlite" && E2E_BLOBS === "fs") return {};
  let p = byDir.get(dir);
  if (!p) {
    p = provision();
    byDir.set(dir, p);
    p.catch(() => byDir.delete(dir));
  }
  return (await p).overrides;
}

/** Drops the schema/bucket created for `dir` (no-op if none). */
export async function releaseBackend(dir: string): Promise<void> {
  const p = byDir.get(dir);
  if (!p) return;
  byDir.delete(dir);
  await (await p).release();
}

/** Where the relay on `dir` keeps blobs when they're on the filesystem (undefined on S3). */
export const fsBlobDir = (dir: string) => (E2E_BLOBS === "fs" ? join(dir, "blobs") : undefined);

/** The same as BEAMHOP_* variables, for relays started as a child process (`beamhop start`). */
export async function backendEnv(dir: string): Promise<Record<string, string>> {
  const o = (await backendOverrides(dir)) as {
    database?: { driver: string; postgresUrl: string };
    blossom?: { driver: string; s3: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string } };
  };
  const env: Record<string, string> = {};
  if (o.database) Object.assign(env, { BEAMHOP_DB_DRIVER: o.database.driver, BEAMHOP_DATABASE_URL: o.database.postgresUrl });
  if (o.blossom) {
    const s = o.blossom.s3;
    Object.assign(env, {
      BEAMHOP_BLOSSOM_DRIVER: o.blossom.driver,
      BEAMHOP_S3_ENDPOINT: s.endpoint,
      BEAMHOP_S3_REGION: s.region,
      BEAMHOP_S3_BUCKET: s.bucket,
      BEAMHOP_S3_ACCESS_KEY_ID: s.accessKeyId,
      BEAMHOP_S3_SECRET_ACCESS_KEY: s.secretAccessKey,
    });
  }
  return env;
}
