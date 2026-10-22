import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { nip19 } from "nostr-tools";
import { ConfigSchema, type BeamhopConfig } from "@beamhop/sdk";

type Json = Record<string, unknown>;

/** Server-level options that are not part of the sdk ConfigSchema. */
export interface ServerExtras {
  /** plugin names enabled on first boot (until toggled in the admin panel) */
  pluginsEnabled: string[];
  /** bearer token required for GET /metrics (unset = public) */
  metricsToken?: string;
  /** expose /metrics Prometheus endpoint */
  prometheus: boolean;
}

export interface LoadedConfig {
  config: BeamhopConfig;
  extras: ServerExtras;
  /** absolute path of the config file that was read, if any */
  configPath?: string;
}

export interface LoadConfigOptions {
  /** explicit config path (from --config) */
  configPath?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** highest-precedence overrides (CLI flags), deep-merged */
  overrides?: Json;
}

/** Accepts npub or 64-char hex; returns lowercase hex. Throws on invalid input. */
export function toHexPubkey(input: string): string {
  const s = input.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  try {
    if (s.startsWith("npub1")) {
      const d = nip19.decode(s);
      if (d.type === "npub") return d.data as string;
    }
    if (s.startsWith("nprofile1")) {
      const d = nip19.decode(s);
      if (d.type === "nprofile") return (d.data as { pubkey: string }).pubkey;
    }
  } catch {
    /* invalid bech32 */
  }
  throw new Error(`invalid pubkey: ${input}`);
}

/** Accepts nsec or 64-char hex secret key; returns hex. */
export function toHexSecretKey(input: string): string {
  const s = input.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();
  if (s.startsWith("nsec1")) {
    const d = nip19.decode(s);
    if (d.type === "nsec") return Buffer.from(d.data as Uint8Array).toString("hex");
  }
  throw new Error("invalid relay secret key (expected hex or nsec)");
}

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export function deepMerge(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Json, v) : v;
  }
  return out;
}

function setPath(obj: Json, path: string, value: unknown) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts.slice(0, -1)) {
    if (!isObj(cur[p])) cur[p] = {};
    cur = cur[p] as Json;
  }
  cur[parts[parts.length - 1]] = value;
}

const bool = (v: string) => /^(1|true|yes|on)$/i.test(v.trim());
const num = (name: string, v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got "${v}")`);
  return n;
};
const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
/** "k=v,k2=v2" → record */
const kvList = (v: string) => Object.fromEntries(list(v).map((p) => { const i = p.indexOf("="); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));

type EnvSpec = [envName: string, path: string, parse: (v: string, name: string) => unknown];
const ENV: EnvSpec[] = [
  ["BEAMHOP_HOST", "server.host", (v) => v],
  ["BEAMHOP_PORT", "server.port", (v, n) => num(n, v)],
  ["PORT", "server.port", (v, n) => num(n, v)],
  ["BEAMHOP_PUBLIC_URL", "server.publicUrl", (v) => v.replace(/\/+$/, "")],
  ["BEAMHOP_TRUST_PROXY", "server.trustProxy", bool],
  ["BEAMHOP_DB_DRIVER", "database.driver", (v) => v],
  ["BEAMHOP_SQLITE_PATH", "database.sqlitePath", (v) => v],
  ["BEAMHOP_DATABASE_URL", "database.postgresUrl", (v) => v],
  ["BEAMHOP_RELAY_SECRET_KEY", "relaySecretKey", (v) => toHexSecretKey(v)],
  ["BEAMHOP_BLOSSOM_ENABLED", "blossom.enabled", bool],
  ["BEAMHOP_BLOSSOM_DRIVER", "blossom.driver", (v) => v],
  ["BEAMHOP_BLOSSOM_FS_PATH", "blossom.fsPath", (v) => v],
  ["BEAMHOP_S3_ENDPOINT", "blossom.s3.endpoint", (v) => v],
  ["BEAMHOP_S3_REGION", "blossom.s3.region", (v) => v],
  ["BEAMHOP_S3_BUCKET", "blossom.s3.bucket", (v) => v],
  ["BEAMHOP_S3_ACCESS_KEY_ID", "blossom.s3.accessKeyId", (v) => v],
  ["BEAMHOP_S3_SECRET_ACCESS_KEY", "blossom.s3.secretAccessKey", (v) => v],
  ["BEAMHOP_S3_PUBLIC_URL", "blossom.s3.publicUrl", (v) => v],
  ["BEAMHOP_OTEL_ENABLED", "metrics.otel.enabled", bool],
  ["BEAMHOP_OTEL_ENDPOINT", "metrics.otel.endpoint", (v) => v],
  ["BEAMHOP_OTEL_HEADERS", "metrics.otel.headers", kvList],
  ["BEAMHOP_OTEL_INTERVAL_MS", "metrics.otel.intervalMs", (v, n) => num(n, v)],
  ["BEAMHOP_GEOIP_DB", "metrics.geoipDbPath", (v) => v],
  ["BEAMHOP_METRICS_RETENTION_DAYS", "metrics.retentionDays", (v, n) => num(n, v)],
  ["BEAMHOP_ADMIN_ENABLED", "admin.enabled", bool],
  ["BEAMHOP_OWNERS", "admin.owners", (v) => list(v).map(toHexPubkey)],
  ["BEAMHOP_SESSION_SECRET", "admin.sessionSecret", (v) => v],
  ["BEAMHOP_ADMIN_UI_DIR", "admin.uiDir", (v) => v],
  ["BEAMHOP_VAPID_PUBLIC_KEY", "admin.vapid.publicKey", (v) => v],
  ["BEAMHOP_VAPID_PRIVATE_KEY", "admin.vapid.privateKey", (v) => v],
  ["BEAMHOP_VAPID_SUBJECT", "admin.vapid.subject", (v) => v],
  ["BEAMHOP_PLUGINS_DIR", "plugins.dir", (v) => v],
  ["BEAMHOP_PLUGINS", "plugins.packages", list],
  ["BEAMHOP_LOG_LEVEL", "logLevel", (v) => v.toLowerCase()],
];

export function envToConfig(env: Record<string, string | undefined>): Json {
  const out: Json = {};
  for (const [name, path, parse] of ENV) {
    const v = env[name];
    if (v === undefined || v === "") continue;
    if (name === "PORT" && env.BEAMHOP_PORT) continue;
    setPath(out, path, parse(v, name));
  }
  return out;
}

export function findConfigFile(opts: { configPath?: string; env?: Record<string, string | undefined>; cwd?: string }): string | undefined {
  const cwd = opts.cwd ?? process.cwd();
  const explicit = opts.configPath ?? opts.env?.BEAMHOP_CONFIG;
  if (explicit) {
    const p = resolve(cwd, explicit);
    if (!existsSync(p)) throw new Error(`config file not found: ${p}`);
    return p;
  }
  const def = resolve(cwd, "beamhop.config.json");
  return existsSync(def) ? def : undefined;
}

/** defaults ← beamhop.config.json ← env (BEAMHOP_*) ← overrides (CLI flags) */
export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const env = opts.env ?? process.env;
  const configPath = findConfigFile({ configPath: opts.configPath, env, cwd: opts.cwd });
  let fileJson: Json = {};
  if (configPath) {
    try {
      fileJson = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (err) {
      throw new Error(`failed to parse ${configPath}: ${(err as Error).message}`);
    }
    if (!isObj(fileJson)) throw new Error(`${configPath} must contain a JSON object`);
    delete fileJson.$schema;
  }
  // owners in the file may be npubs
  const fileOwners = (fileJson.admin as Json | undefined)?.owners;
  if (Array.isArray(fileOwners)) (fileJson.admin as Json).owners = fileOwners.map((o) => toHexPubkey(String(o)));
  if (typeof fileJson.relaySecretKey === "string") fileJson.relaySecretKey = toHexSecretKey(fileJson.relaySecretKey);

  const merged = deepMerge(deepMerge(fileJson, envToConfig(env)), opts.overrides ?? {});
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`invalid configuration${configPath ? ` (${configPath})` : ""}:\n${issues}`);
  }
  const config = parsed.data;
  // no explicit public URL: follow the configured port
  const mergedServer = (merged as Json).server as Json | undefined;
  if (typeof mergedServer?.publicUrl !== "string") config.server.publicUrl = `http://localhost:${config.server.port}`;
  if (config.blossom.driver === "s3" && !config.blossom.s3) throw new Error("blossom.driver is s3 but blossom.s3 is not configured (BEAMHOP_S3_*)");
  if (config.database.driver === "postgres" && !config.database.postgresUrl) throw new Error("database.driver is postgres but no database.postgresUrl / BEAMHOP_DATABASE_URL given");

  // resolve relative file paths against the config file location (or cwd)
  const base = configPath ? dirname(configPath) : (opts.cwd ?? process.cwd());
  const abs = (p: string) => (p === ":memory:" ? p : resolve(base, p));
  config.database.sqlitePath = abs(config.database.sqlitePath);
  config.blossom.fsPath = abs(config.blossom.fsPath);
  config.plugins.dir = abs(config.plugins.dir);
  if (config.metrics.geoipDbPath) config.metrics.geoipDbPath = abs(config.metrics.geoipDbPath);
  if (config.admin.uiDir) config.admin.uiDir = abs(config.admin.uiDir);
  config.server.publicUrl = config.server.publicUrl.replace(/\/+$/, "");

  const filePlugins = (fileJson.plugins as Json | undefined)?.enabled;
  const fileServer = fileJson.server as Json | undefined;
  const ov = opts.overrides as { plugins?: { enabled?: string[] } } | undefined;
  const extras: ServerExtras = {
    pluginsEnabled: ov?.plugins?.enabled ?? (env.BEAMHOP_PLUGINS_ENABLED !== undefined ? list(env.BEAMHOP_PLUGINS_ENABLED) : Array.isArray(filePlugins) ? filePlugins.map(String) : []),
    metricsToken: env.BEAMHOP_METRICS_TOKEN || (typeof fileServer?.metricsToken === "string" ? fileServer.metricsToken : undefined),
    prometheus: env.BEAMHOP_PROMETHEUS !== undefined ? bool(env.BEAMHOP_PROMETHEUS) : fileServer?.prometheus !== false,
  };
  return { config, extras, configPath };
}
