/**
 * Runs beamhop as a child process (server-proc.ts) so the load generator doesn't share its event loop, and so it can
 * be killed (-9 / SIGTERM) and restarted on the same data. Load runs relax the per-IP limits for 127.0.0.1 (all
 * clients share it) through the admin API, as an operator would for a trusted importer.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { bytesToHex } from "nostr-tools/utils";
import { adminApi } from "../../harness/client";
import { freePort } from "../../harness/relay";

export type DbKind = "sqlite" | "postgres";
export const DEFAULT_PG_URL = "postgres://beamhop:beamhop@127.0.0.1:5432/load_tests";

export interface ServerOptions {
  db: DbKind;
  pgUrl?: string;
  /** data dir (reused across restarts); a temp dir by default */
  dir?: string;
  port?: number;
  verifyWorkers?: number;
  /** emit STATS lines this often (ms) */
  statsMs?: number;
  env?: Record<string, string>;
  /** relax rate/connection limits for 127.0.0.1 after start (default true) */
  relax?: boolean;
  quiet?: boolean;
}

export interface Stats {
  t: number;
  rss: number;
  heapUsed: number;
  heapObjects: number;
  fds: number;
  conns: number;
  objects: Record<string, number>;
}

const SERVER_ENTRY = join(import.meta.dir, "../server-proc.ts");

export class ServerProc {
  readonly dir: string;
  readonly port: number;
  readonly http: string;
  readonly ws: string;
  readonly ownerSk = generateSecretKey();
  readonly relayKey = bytesToHex(generateSecretKey());
  proc?: ReturnType<typeof Bun.spawn>;
  stats: Stats[] = [];
  log: string[] = [];
  exitCode?: number | null;
  private exited?: Promise<number>;

  private constructor(readonly opts: ServerOptions, dir: string, port: number) {
    this.dir = dir;
    this.port = port;
    this.http = `http://127.0.0.1:${port}`;
    this.ws = `ws://127.0.0.1:${port}`;
  }

  static async create(opts: ServerOptions): Promise<ServerProc> {
    const dir = opts.dir ?? mkdtempSync(join(tmpdir(), "beamhop-load-"));
    mkdirSync(dir, { recursive: true });
    return new ServerProc(opts, dir, opts.port ?? (await freePort()));
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    const o = this.opts;
    return {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      BEAMHOP_HOST: "127.0.0.1",
      BEAMHOP_PORT: String(this.port),
      BEAMHOP_PUBLIC_URL: this.http,
      BEAMHOP_DB_DRIVER: o.db,
      BEAMHOP_SQLITE_PATH: join(this.dir, "beamhop.db"),
      ...(o.db === "postgres" ? { BEAMHOP_DATABASE_URL: o.pgUrl ?? DEFAULT_PG_URL } : {}),
      BEAMHOP_BLOSSOM_FS_PATH: join(this.dir, "blobs"),
      BEAMHOP_PLUGINS_DIR: join(this.dir, "plugins"),
      BEAMHOP_PLUGINS_AUTO_DISCOVER: "false",
      BEAMHOP_OWNERS: getPublicKey(this.ownerSk),
      BEAMHOP_RELAY_SECRET_KEY: this.relayKey,
      BEAMHOP_PROMETHEUS: "true",
      BEAMHOP_LOG_LEVEL: "warn",
      BEAMHOP_VERIFY_WORKERS: String(o.verifyWorkers ?? 0),
      LOAD_STATS_MS: String(o.statsMs ?? 0),
      ...(o.env ?? {}),
      ...extra,
    };
  }

  /** Starts (or restarts) the server on the same data dir and waits until /health answers 200. */
  async start(timeoutMs = 60_000): Promise<void> {
    this.exitCode = undefined;
    // LOAD_BUN_ARGS: extra runtime flags for the server process, e.g. "--cpu-prof-md --cpu-prof-dir=/tmp/prof"
    const flags = (process.env.LOAD_BUN_ARGS ?? "").split(" ").filter(Boolean);
    const proc = Bun.spawn([process.execPath, ...flags, SERVER_ENTRY], { cwd: this.dir, env: this.env(), stdout: "pipe", stderr: "pipe" });
    this.proc = proc;
    this.exited = proc.exited.then((c) => (this.exitCode = c));
    let ready = false;
    void this.pump(proc.stdout as ReadableStream<Uint8Array>, (line) => {
      if (line.startsWith("READY")) ready = true;
      else if (line.startsWith("STATS ")) this.stats.push(JSON.parse(line.slice(6)));
      else this.note(line);
    });
    void this.pump(proc.stderr as ReadableStream<Uint8Array>, (line) => this.note(line));
    const deadline = Date.now() + timeoutMs;
    while (!ready) {
      if (this.exitCode !== undefined) throw new Error(`server exited with ${this.exitCode}:\n${this.log.slice(-30).join("\n")}`);
      if (Date.now() > deadline) throw new Error(`server did not start:\n${this.log.slice(-30).join("\n")}`);
      await Bun.sleep(20);
    }
    if (this.opts.relax !== false) await this.relax();
    if (this.opts.statsMs) {
      const n = this.stats.length;
      while (this.stats.length === n && Date.now() < deadline) await Bun.sleep(20);
    }
  }

  private note(line: string) {
    this.log.push(line);
    if (this.log.length > 2000) this.log.splice(0, 1000);
    if (!this.opts.quiet) console.error(`[server] ${line}`);
  }

  private async pump(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void) {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of stream) {
      buf += dec.decode(chunk, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    }
    if (buf) onLine(buf);
  }

  /** Lifts the per-IP limits for loopback (every load client shares 127.0.0.1). Settings persist across restarts. */
  async relax(extra: Record<string, unknown> = {}): Promise<void> {
    const s = await this.api("PATCH", "/settings", {
      limits: { eventsPerMinute: 0, reqPerMinute: 0, connectionsPerIp: 0, maxSubscriptions: 100, ...((extra.limits as object) ?? {}) },
      blossom: { uploadAccess: "anyone", defaultQuotaBytes: 0, thumbnails: false, ...((extra.blossom as object) ?? {}) },
    });
    if (s.status !== 200) throw new Error(`settings: ${s.status} ${JSON.stringify(s.body)}`);
    const rules = await this.api("GET", "/ip-rules");
    if (!rules.body.items?.some((r: { cidr: string }) => r.cidr === "127.0.0.1/32")) {
      const r = await this.api("POST", "/ip-rules", { cidr: "127.0.0.1/32", action: "allow", reason: "load test" });
      if (r.status !== 201) throw new Error(`ip rule: ${r.status} ${JSON.stringify(r.body)}`);
    }
  }

  api(method: string, path: string, body?: unknown) {
    return adminApi(this.http, this.ownerSk, method, path, body);
  }

  async metrics(): Promise<Record<string, number>> {
    const text = await (await fetch(`${this.http}/metrics`)).text();
    const out: Record<string, number> = {};
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("#")) continue;
      const [k, v] = line.split(" ");
      out[k] = Number(v);
    }
    return out;
  }

  /** Open descriptors of the server process (lsof; -1 when unavailable). */
  async fds(): Promise<number> {
    if (!this.proc?.pid) return -1;
    const p = Bun.spawn(["lsof", "-n", "-P", "-p", String(this.proc.pid)], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return Math.max(0, out.trim().split("\n").length - 1);
  }

  kill(signal: "SIGKILL" | "SIGTERM" | "SIGINT" = "SIGKILL") {
    this.proc?.kill(signal);
  }

  /** Waits for the process to exit; returns its exit code (null when killed by a signal). */
  async waitExit(timeoutMs = 30_000): Promise<number | null> {
    if (!this.exited) return null;
    const t = setTimeout(() => this.proc?.kill("SIGKILL"), timeoutMs);
    await this.exited;
    clearTimeout(t);
    return this.proc?.signalCode ? null : (this.exitCode ?? null);
  }

  async stop(): Promise<void> {
    if (!this.proc || this.exitCode !== undefined) return;
    this.kill("SIGTERM");
    await this.waitExit(20_000);
  }

  cleanup() {
    if (!this.opts.dir) rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Empties the load database (postgres): everything lives in the public schema. */
export async function resetPostgres(url = DEFAULT_PG_URL): Promise<void> {
  await psql(url, "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;");
}

export async function psql(url: string, sql: string): Promise<string> {
  const p = Bun.spawn(["psql", url, "-v", "ON_ERROR_STOP=1", "-q", "-A", "-t", "-c", sql], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`psql failed: ${err}`);
  return out;
}

/** Bulk-seeds n synthetic events (lib/seed.ts) through a short-lived server process on the same database. */
export async function seed(srv: ServerProc, n: number, base: number, offset = 0): Promise<number> {
  const t0 = performance.now();
  const p = Bun.spawn([process.execPath, SERVER_ENTRY], {
    cwd: srv.dir,
    env: srv.env({ LOAD_SEED: String(n), LOAD_SEED_OFFSET: String(offset), LOAD_SEED_BASE: String(base), LOAD_STATS_MS: "0" }),
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await p.exited) !== 0) throw new Error("seeding failed");
  return performance.now() - t0;
}
