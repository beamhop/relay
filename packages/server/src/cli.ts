import { chmodSync, existsSync, realpathSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { nip19 } from "nostr-tools";
import { verifyEvent } from "nostr-tools/pure";
import { createLogger, isBun, type AdminRole, type BeamhopConfig, type Filter, type NostrEvent, type Stores } from "@beamhop/sdk";
import { loadConfig, toHexPubkey, type LoadedConfig } from "./config";
import { VERSION } from "./version";

const HELP = `beamhop ${VERSION} — Nostr relay + Blossom media server + admin panel

Usage: beamhop [command] [options]

Commands:
  start                          start the server (default)
  init [--force]                 write a beamhop.config.json with sensible defaults
  admin add <npub|hex> [--role owner|admin|moderator|viewer]
                                 grant an admin role (default: admin)
  admin remove <npub|hex>        revoke an admin role; ends their sessions and removes password, 2FA and passkeys
  admin password <npub|hex>      set a password login for an admin (reads stdin / prompts); signs them out
                                 everywhere. --reset-2fa also removes two-factor authentication and passkeys
  user ban <npub|hex> [--reason text]
  user unban <npub|hex>
  export [--filter '<json>']     write events as JSONL to stdout (no NIP-50 "search")
  import [--skip-verify]         read events as JSONL from stdin
  migrate                        run core/admin/blossom migrations and those of enabled plugins (plugins.dir /
                                 plugins.packages; npm auto-discovery is not used), then exit

Options:
  -c, --config <path>            config file (default ./beamhop.config.json, env BEAMHOP_CONFIG)
  -p, --port <n>                 listen port (env BEAMHOP_PORT)
      --host <addr>              listen address (env BEAMHOP_HOST)
      --public-url <url>         public base URL (env BEAMHOP_PUBLIC_URL)
      --db <sqlite|postgres>     database driver (env BEAMHOP_DB_DRIVER)
      --sqlite-path <path>       sqlite file (env BEAMHOP_SQLITE_PATH)
      --database-url <url>       postgres URL (env BEAMHOP_DATABASE_URL)
      --plugins-dir <path>       local plugins folder (env BEAMHOP_PLUGINS_DIR)
      --owner <npub|hex>         owner pubkey (repeatable; env BEAMHOP_OWNERS)
      --log-level <level>        debug|info|warn|error (env BEAMHOP_LOG_LEVEL)
      --trust-proxy              trust the proxy's client-IP header (server.proxyIpHeader; env BEAMHOP_TRUST_PROXY)
      --runtime <bun|node>       force the HTTP adapter (default: current runtime)
  -v, --version                  print version
  -h, --help                     show this help

Docs: https://github.com/beamhop/relay#readme`;

const options = {
  config: { type: "string", short: "c" },
  port: { type: "string", short: "p" },
  host: { type: "string" },
  "public-url": { type: "string" },
  db: { type: "string" },
  "sqlite-path": { type: "string" },
  "database-url": { type: "string" },
  "plugins-dir": { type: "string" },
  owner: { type: "string", multiple: true },
  "log-level": { type: "string" },
  "trust-proxy": { type: "boolean" },
  runtime: { type: "string" },
  role: { type: "string" },
  reason: { type: "string" },
  filter: { type: "string" },
  force: { type: "boolean" },
  "reset-2fa": { type: "boolean" },
  "skip-verify": { type: "boolean" },
  version: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parse>["values"];
const parse = (argv: string[]) => parseArgs({ args: argv, options, allowPositionals: true, strict: true });

function overridesFrom(v: Values): Record<string, unknown> {
  const o: Record<string, Record<string, unknown> | unknown> = {};
  const server: Record<string, unknown> = {};
  const database: Record<string, unknown> = {};
  if (v.port !== undefined) {
    const n = Number(v.port);
    if (!Number.isInteger(n)) throw new Error("--port must be an integer");
    server.port = n;
  }
  if (v.host) server.host = v.host;
  if (v["public-url"]) server.publicUrl = v["public-url"];
  if (v["trust-proxy"]) server.trustProxy = true;
  if (v.db) database.driver = v.db;
  if (v["sqlite-path"]) database.sqlitePath = v["sqlite-path"];
  if (v["database-url"]) database.postgresUrl = v["database-url"];
  if (Object.keys(server).length) o.server = server;
  if (Object.keys(database).length) o.database = database;
  if (v["plugins-dir"]) o.plugins = { dir: v["plugins-dir"] };
  if (v["log-level"]) o.logLevel = v["log-level"];
  return o;
}

function load(v: Values): LoadedConfig {
  const loaded = loadConfig({ configPath: v.config, overrides: overridesFrom(v) });
  if (v.owner?.length) loaded.config.admin.owners = [...new Set([...loaded.config.admin.owners, ...v.owner.map(toHexPubkey)])];
  return loaded;
}

async function withStores<T>(config: BeamhopConfig, fn: (stores: Stores) => Promise<T>): Promise<T> {
  const storage = (await import("@beamhop/storage")) as unknown as { createStores(c: BeamhopConfig, l: ReturnType<typeof createLogger>): Promise<Stores> };
  const stores = await storage.createStores(config, createLogger("warn"));
  try {
    return await fn(stores);
  } finally {
    await stores.db.close();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return (await readStdin()).split(/\r?\n/)[0] ?? "";
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const out = rl as unknown as { _writeToOutput(s: string): void; output: NodeJS.WriteStream };
  let muted = false;
  out._writeToOutput = (s: string) => {
    if (!muted || s.includes(question)) process.stderr.write(s);
  };
  const answer = await new Promise<string>((res) => {
    rl.question(question, res);
    muted = true;
  });
  rl.close();
  process.stderr.write("\n");
  return answer;
}

const ROLES: AdminRole[] = ["owner", "admin", "moderator", "viewer"];

/**
 * Admin account changes run against the stores with the admin API's own functions (no relay, Blossom, metrics or
 * plugins are started); its tables are migrated first, so this works on a fresh database too.
 */
async function withAdminStores<T>(config: BeamhopConfig, fn: (stores: Stores, admin: typeof import("@beamhop/admin-api")) => Promise<T>): Promise<T> {
  const admin = await import("@beamhop/admin-api");
  return withStores(config, async (stores) => {
    await admin.migrateAdmin(stores.db);
    return fn(stores, admin);
  });
}
const npub = (hex: string) => nip19.npubEncode(hex);

async function cmdStart(v: Values) {
  const loaded = load(v);
  const { startServer } = await import("./server");
  const runtime = v.runtime as "bun" | "node" | undefined;
  if (runtime && runtime !== "bun" && runtime !== "node") throw new Error("--runtime must be bun or node");
  if (runtime === "bun" && !isBun) throw new Error("--runtime bun requires running under Bun");
  if (!loaded.config.admin.owners.length) {
    console.warn("hint: no admin owners configured — set BEAMHOP_OWNERS=<npub> or run `beamhop admin add <npub> --role owner`");
  }
  await startServer(loaded, { runtime });
}

function cmdInit(v: Values) {
  const path = resolve(v.config ?? "beamhop.config.json");
  if (existsSync(path) && !v.force) throw new Error(`${path} already exists (use --force to overwrite)`);
  const owners = (v.owner ?? []).map(toHexPubkey);
  const port = v.port ? Number(v.port) : 3334;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be an integer between 1 and 65535 (got "${v.port}")`);
  const cfg = {
    server: { host: v.host ?? "0.0.0.0", port, publicUrl: v["public-url"] ?? `http://localhost:${port}`, trustProxy: !!v["trust-proxy"] },
    database: { driver: v.db ?? "sqlite", sqlitePath: v["sqlite-path"] ?? "./data/beamhop.db", ...(v["database-url"] ? { postgresUrl: v["database-url"] } : {}) },
    blossom: { enabled: true, driver: "fs", fsPath: "./data/blobs" },
    metrics: { otel: { enabled: false }, retentionDays: 30 },
    admin: { enabled: true, owners },
    plugins: { dir: v["plugins-dir"] ?? "./plugins", packages: [], enabled: [] as string[] },
    logLevel: v["log-level"] ?? "info",
  };
  // owner-only: the config may carry a database URL with a password (and later the relay key, metrics token, S3 keys)
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  console.log(`wrote ${path}`);
  if (!owners.length) {
    console.log(`
next steps:
  1. add your pubkey as owner: edit admin.owners in ${path} (npub or hex),
     or run:  beamhop admin add npub1... --role owner
  2. set server.publicUrl to the public https URL of your relay
  3. start:  beamhop start   → open ${cfg.server.publicUrl}/admin/`);
  }
}

async function cmdAdmin(v: Values, args: string[]) {
  const [sub, target] = args;
  if (!sub || !target) throw new Error("usage: beamhop admin <add|remove|password> <npub|hex>");
  const pubkey = toHexPubkey(target);
  const { config } = load(v);
  if (sub === "add") {
    const role = (v.role ?? "admin") as AdminRole;
    if (!ROLES.includes(role)) throw new Error(`--role must be one of ${ROLES.join(", ")}`);
    await withStores(config, async (stores) => {
      await stores.users.upsert(pubkey, { role, allowed: true });
      await stores.audit.record({ actor: "cli", action: "admin.add", target: pubkey, details: { role }, ip: null });
    });
    console.log(`${npub(pubkey)} is now ${role}`);
  } else if (sub === "remove") {
    await withAdminStores(config, async (stores, admin) => {
      await stores.users.upsert(pubkey, { role: null });
      // what removing a role through the admin API does too: sessions, push devices and login factors go
      await admin.revokeAdminAccess(admin.adminAccess(stores.db), pubkey);
      await stores.audit.record({ actor: "cli", action: "admin.remove", target: pubkey, details: {}, ip: null });
    });
    if (config.admin.owners.includes(pubkey)) console.warn("note: this pubkey is still an owner via config admin.owners / BEAMHOP_OWNERS");
    console.log(`${npub(pubkey)} is no longer an admin; signed out everywhere, password, two-factor and passkeys removed`);
  } else if (sub === "password") {
    const pw = await promptHidden(`new password for ${npub(pubkey).slice(0, 16)}…: `);
    if (pw.length < 8) throw new Error("password must be at least 8 characters");
    if (process.stdin.isTTY && (await promptHidden("repeat password: ")) !== pw) throw new Error("passwords do not match");
    await withAdminStores(config, async (stores, admin) => {
      const user = await stores.users.get(pubkey);
      if (!user?.role && !config.admin.owners.includes(pubkey)) console.warn(`warning: ${npub(pubkey)} has no admin role yet — run \`beamhop admin add ${target}\``);
      // a reset is how a compromised or locked-out account is recovered: the new password retires trusted-device
      // cookies issued before it, every session ends (running servers re-read sessions within seconds) with the push
      // devices it registered; --reset-2fa (a lost or hijacked authenticator) also drops TOTP and every passkey
      await admin.setAdminPassword(admin.adminAccess(stores.db), pubkey, await admin.hashPassword(pw), { resetSecondFactors: !!v["reset-2fa"] });
      await stores.audit.record({ actor: "cli", action: "admin.password", target: pubkey, details: { reset2fa: !!v["reset-2fa"] }, ip: null });
    });
    console.log(`password set for ${npub(pubkey)}; signed out everywhere${v["reset-2fa"] ? "; two-factor authentication and passkeys removed" : ""}`);
  } else throw new Error(`unknown admin command: ${sub}`);
}

async function cmdUser(v: Values, args: string[]) {
  const [sub, target] = args;
  if (!sub || !target) throw new Error("usage: beamhop user <ban|unban> <npub|hex>");
  const pubkey = toHexPubkey(target);
  const { config } = load(v);
  if (sub !== "ban" && sub !== "unban") throw new Error(`unknown user command: ${sub}`);
  await withStores(config, async (stores) => {
    await stores.users.upsert(pubkey, sub === "ban" ? { status: "banned", banReason: v.reason ?? "banned via cli" } : { status: "active", banReason: null });
    await stores.audit.record({ actor: "cli", action: `user.${sub}`, target: pubkey, details: v.reason ? { reason: v.reason } : {}, ip: null });
  });
  console.log(`${npub(pubkey)} ${sub === "ban" ? "banned" : "unbanned"}`);
}

async function cmdExport(v: Values) {
  const { config } = load(v);
  let filter: Filter = {};
  if (v.filter) {
    try {
      filter = JSON.parse(v.filter);
    } catch {
      throw new Error("--filter must be a JSON NIP-01 filter");
    }
    if (!filter || typeof filter !== "object" || Array.isArray(filter)) throw new Error("--filter must be a JSON NIP-01 filter object");
    // search results come back ranked by relevance, but export pages by created_at: it would repeat and skip events
    if ("search" in filter) throw new Error('--filter: "search" (NIP-50) is not supported by export; filter by ids/authors/kinds/tags/since/until instead');
  }
  const PAGE = 1000;
  let total = 0;
  await withStores(config, async (stores) => {
    // page backwards by created_at; ids at the boundary timestamp are remembered to skip duplicates
    let seen = new Set<string>();
    let until = filter.until;
    for (;;) {
      const want = Math.min(PAGE, filter.limit ? filter.limit - total : PAGE);
      if (want <= 0) break;
      const page = await stores.events.query([{ ...filter, ...(until !== undefined ? { until } : {}), limit: want }], { maxLimit: PAGE });
      const fresh = page.filter((e) => !seen.has(e.id));
      if (fresh.length) {
        total += fresh.length;
        if (!process.stdout.write(fresh.map((e) => JSON.stringify(e) + "\n").join(""))) await new Promise((r) => process.stdout.once("drain", r));
      }
      if (page.length < want) break;
      const last = page[page.length - 1].created_at;
      if (!fresh.length) {
        // a whole page shares one created_at: the store can't page within a second, so move on — loudly
        console.error(`warning: more than ${PAGE} events share created_at ${last}; some of them were not exported`);
        if (last <= 0) break;
        until = last - 1;
        seen = new Set();
        continue;
      }
      if (last !== until) seen = new Set();
      for (const e of page) if (e.created_at === last) seen.add(e.id);
      until = last;
    }
  });
  console.error(`exported ${total} events`);
}

type ValidateEventShape = (e: unknown) => { event: NostrEvent } | { reason: string };

/**
 * One JSONL line → event, or undefined when it's not one the relay would accept: shape checked with core's own rules
 * even with `skipVerify` (junk lines must not reach, and abort, the store), signature unless `skipVerify`.
 */
export function parseImportLine(line: string, validateEventShape: ValidateEventShape, skipVerify = false): NostrEvent | undefined {
  try {
    let raw: unknown = JSON.parse(line);
    if (Array.isArray(raw)) raw = raw.find((x) => x && typeof x === "object" && !Array.isArray(x)); // ["EVENT", {...}]
    const shape = validateEventShape(raw);
    if (!("event" in shape)) return undefined;
    if (!skipVerify && !verifyEvent({ ...shape.event } as never)) return undefined;
    return shape.event;
  } catch {
    return undefined;
  }
}

async function cmdImport(v: Values) {
  const { config } = load(v);
  // the relay's own shape rules (kind range, non-empty string tags, no NUL, d-tag length …): import must not store
  // events the relay would refuse
  const { validateEventShape } = (await import("@beamhop/core")) as unknown as { validateEventShape?: ValidateEventShape };
  if (typeof validateEventShape !== "function") throw new Error("import needs validateEventShape from @beamhop/core (is the package built/complete?)");
  const counts = { saved: 0, duplicate: 0, invalid: 0, other: 0, failed: 0 };
  await withStores(config, async (stores) => {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
    let n = 0;
    for await (const line of rl) {
      const s = line.trim();
      if (!s) continue;
      n++;
      const ev = parseImportLine(s, validateEventShape, !!v["skip-verify"]);
      if (!ev) {
        counts.invalid++;
        continue;
      }
      try {
        const r = await stores.events.save(ev);
        if (r.status === "saved" || r.status === "replaced") counts.saved++;
        else if (r.status === "duplicate") counts.duplicate++;
        else counts.other++;
      } catch (err) {
        counts.failed++;
        if (counts.failed <= 10) console.error(`line ${n}: save failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (n % 5000 === 0) console.error(`… ${n} lines`);
    }
    await stores.audit.record({ actor: "cli", action: "content.import", target: null, details: counts, ip: null });
  });
  console.error(`imported: ${counts.saved} saved, ${counts.duplicate} duplicates, ${counts.invalid} invalid, ${counts.other} skipped, ${counts.failed} failed`);
}

async function cmdMigrate(v: Values) {
  const { config, extras } = load(v);
  const { createBeamhop } = await import("./app");
  // core/admin/blossom migrations run during composition; plugin migrations need the plugin manager. Only
  // enabled plugins from the plugins dir / plugins.packages are migrated: npm auto-discovery would import (run)
  // every beamhop-plugin-* package in node_modules just to look at it. `extras` carries plugins enabled via
  // config / BEAMHOP_PLUGINS_ENABLED, so those count as enabled here just as they do at start.
  const bh = await createBeamhop(config, { autoDiscoverNpm: false, extras });
  let plugins = 0;
  try {
    plugins = await bh.plugins.migrate();
  } finally {
    await bh.stop();
  }
  const db = config.database.driver === "sqlite" ? config.database.sqlitePath : "postgres";
  console.log(`migrations up to date (${db}; checked ${plugins} enabled plugin(s) with migrations)`);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parse(argv);
  if (values.version) return void console.log(VERSION);
  const [cmd = "start", ...rest] = positionals;
  if (values.help || cmd === "help") return void console.log(HELP);
  switch (cmd) {
    case "start":
    case "serve":
      return cmdStart(values);
    case "init":
      return cmdInit(values);
    case "admin":
      return cmdAdmin(values, rest);
    case "user":
      return cmdUser(values, rest);
    case "export":
      return cmdExport(values);
    case "import":
      return cmdImport(values);
    case "migrate":
      return cmdMigrate(values);
    default:
      throw new Error(`unknown command "${cmd}" (see beamhop --help)`);
  }
}

const isMain = (() => {
  if ((globalThis as { __BEAMHOP_NO_AUTORUN__?: boolean }).__BEAMHOP_NO_AUTORUN__) return false;
  if ((import.meta as { main?: boolean }).main) return true;
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(arg)).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err) => {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
