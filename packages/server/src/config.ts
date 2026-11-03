import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { nip19 } from "nostr-tools";
import { ConfigSchema, type BeamhopConfig } from "@beamhop/sdk";
import { deepMerge } from "@beamhop/sdk/util";
import { proxyMatcher } from "./runtime/common";

type Json = Record<string, unknown>;

/** Server-level options that are not part of the sdk ConfigSchema. */
export interface ServerExtras {
  /** plugin names enabled on first boot (until toggled in the admin panel) */
  pluginsEnabled: string[];
  /** bearer token required for GET /metrics (unset = only loopback clients reaching beamhop directly, and only without server.trustProxy) */
  metricsToken?: string;
  /** expose /metrics Prometheus endpoint */
  prometheus: boolean;
}

export interface LoadedConfig {
  config: BeamhopConfig;
  extras: ServerExtras;
  /** absolute path of the config file that was read, if any */
  configPath?: string;
  /** unknown config file keys / BEAMHOP_* variables (already passed to `warn`) */
  warnings: string[];
}

export interface LoadConfigOptions {
  /** explicit config path (from --config) */
  configPath?: string;
  env?: Record<string, string | undefined>;
  cwd?: string;
  /** highest-precedence overrides (CLI flags), deep-merged */
  overrides?: Json;
  /** where boot-time warnings go (default: stderr) */
  warn?: (message: string) => void;
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

export { deepMerge };

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
  // Number("") / Number("  ") is 0, which for a limit means "unlimited": never let blank input get there
  if (!v.trim()) throw new Error(`${name} must be a number (got "${v}")`);
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number (got "${v}")`);
  return n;
};
const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
/**
 * "k=v,k2=v2" → record (OTLP-style; values are percent-decoded so `%2C` can carry a comma).
 * Entries without `=` are rejected instead of silently mangled.
 */
const kvList = (v: string, name: string) =>
  Object.fromEntries(
    list(v).map((p) => {
      const i = p.indexOf("=");
      if (i <= 0) throw new Error(`${name}: expected key=value pairs (got "${p}")`);
      const dec = (s: string) => {
        try {
          return decodeURIComponent(s.trim());
        } catch {
          return s.trim();
        }
      };
      return [dec(p.slice(0, i)), dec(p.slice(i + 1))];
    }),
  );

/** Example/placeholder values that must never protect a real endpoint. */
export function isPlaceholderToken(token: string): boolean {
  const t = token.trim().toLowerCase();
  return t === "change-me" || t === "changeme" || t.startsWith("replace-with") || t === "secret" || t === "token";
}

type EnvSpec = [envName: string, path: string, parse: (v: string, name: string) => unknown];
const ENV: EnvSpec[] = [
  ["BEAMHOP_HOST", "server.host", (v) => v],
  ["BEAMHOP_PORT", "server.port", (v, n) => num(n, v)],
  ["PORT", "server.port", (v, n) => num(n, v)],
  ["BEAMHOP_PUBLIC_URL", "server.publicUrl", (v) => v.replace(/\/+$/, "")],
  ["BEAMHOP_TRUST_PROXY", "server.trustProxy", bool],
  ["BEAMHOP_PROXY_IP_HEADER", "server.proxyIpHeader", (v) => v.trim().toLowerCase()],
  ["BEAMHOP_TRUSTED_PROXIES", "server.trustedProxies", list],
  ["BEAMHOP_SHUTDOWN_TIMEOUT_MS", "server.shutdownTimeoutMs", (v, n) => num(n, v)],
  ["BEAMHOP_VERIFY_WORKERS", "server.verifyWorkers", (v, n) => num(n, v)],
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
  ["BEAMHOP_BLOSSOM_UPLOADS_PER_MINUTE_PER_IP", "blossom.limits.uploadsPerMinutePerIp", (v, n) => num(n, v)],
  ["BEAMHOP_BLOSSOM_UPLOADS_PER_MINUTE_PER_PUBKEY", "blossom.limits.uploadsPerMinutePerPubkey", (v, n) => num(n, v)],
  ["BEAMHOP_BLOSSOM_MAX_CONCURRENT_UPLOADS", "blossom.limits.maxConcurrentUploads", (v, n) => num(n, v)],
  ["BEAMHOP_BLOSSOM_MAX_QUEUED_UPLOADS", "blossom.limits.maxQueuedUploads", (v, n) => num(n, v)],
  ["BEAMHOP_BLOSSOM_MAX_BUFFERED_UPLOAD_BYTES", "blossom.limits.maxBufferedUploadBytes", (v, n) => num(n, v)],
  ["BEAMHOP_BLOSSOM_MAX_UPLOADS_PER_IP", "blossom.limits.maxConcurrentUploadsPerIp", (v, n) => num(n, v)],
  ["BEAMHOP_BLOSSOM_UPLOAD_STALL_MS", "blossom.limits.uploadStallMs", (v, n) => num(n, v)],
  ["BEAMHOP_BLOSSOM_MIN_UPLOAD_BYTES_PER_SEC", "blossom.limits.minUploadBytesPerSec", (v, n) => num(n, v)],
  [
    "BEAMHOP_BLOSSOM_MIRROR_PORTS",
    "blossom.limits.mirrorPorts",
    (v, n) => {
      const ports = list(v).map((x) => num(n, x));
      // an empty list would silently disable mirroring
      if (!ports.length) throw new Error(`${n} must list at least one port (got "${v}")`);
      return ports;
    },
  ],
  ["BEAMHOP_BLOSSOM_MIRROR_TIMEOUT_MS", "blossom.limits.mirrorTimeoutMs", (v, n) => num(n, v)],
  ["BEAMHOP_OTEL_ENABLED", "metrics.otel.enabled", bool],
  ["BEAMHOP_OTEL_ENDPOINT", "metrics.otel.endpoint", (v) => v],
  ["BEAMHOP_OTEL_HEADERS", "metrics.otel.headers", (v, n) => kvList(v, n)],
  ["BEAMHOP_OTEL_INTERVAL_MS", "metrics.otel.intervalMs", (v, n) => num(n, v)],
  ["BEAMHOP_GEOIP_DB", "metrics.geoipDbPath", (v) => v],
  ["BEAMHOP_METRICS_RETENTION_DAYS", "metrics.retentionDays", (v, n) => num(n, v)],
  ["BEAMHOP_ADMIN_ENABLED", "admin.enabled", bool],
  ["BEAMHOP_OWNERS", "admin.owners", (v) => list(v).map(toHexPubkey)],
  // BEAMHOP_SESSION_SECRET / admin.sessionSecret: deprecated and ignored (sessions are random server-side ids)
  ["BEAMHOP_ADMIN_UI_DIR", "admin.uiDir", (v) => v],
  ["BEAMHOP_VAPID_PUBLIC_KEY", "admin.vapid.publicKey", (v) => v],
  ["BEAMHOP_VAPID_PRIVATE_KEY", "admin.vapid.privateKey", (v) => v],
  ["BEAMHOP_VAPID_SUBJECT", "admin.vapid.subject", (v) => v],
  ["BEAMHOP_PLUGINS_DIR", "plugins.dir", (v) => v],
  ["BEAMHOP_PLUGINS", "plugins.packages", list],
  ["BEAMHOP_PLUGINS_AUTO_DISCOVER", "plugins.autoDiscoverNpm", bool],
  ["BEAMHOP_LOG_LEVEL", "logLevel", (v) => v.toLowerCase()],
  ["BEAMHOP_LOG_FORMAT", "logFormat", (v) => v.toLowerCase()],
];

/** BEAMHOP_* variables read outside the ENV table (or deliberately ignored), so they don't trip the unknown-variable warning. */
const OTHER_ENV = new Set([
  "BEAMHOP_CONFIG",
  "BEAMHOP_PLUGINS_ENABLED",
  "BEAMHOP_METRICS_TOKEN",
  "BEAMHOP_PROMETHEUS",
  "BEAMHOP_SESSION_SECRET", // deprecated, ignored
  "BEAMHOP_MEMORY_LIMIT", // @beamhop/metrics
  "BEAMHOP_UI_DIST", // build scripts
  "BEAMHOP_BINARY_OUT",
  "BEAMHOP_BINARY_TARGET",
  "BEAMHOP_TEST_PG", // test suites (e2e/harness/backend.ts)
  "BEAMHOP_E2E_DB",
  "BEAMHOP_E2E_BLOBS",
  "BEAMHOP_E2E_PG_URL",
  "BEAMHOP_E2E_PG",
  "BEAMHOP_E2E_S3_ENDPOINT",
  "BEAMHOP_E2E_S3_REGION",
  "BEAMHOP_E2E_S3_BUCKET",
  "BEAMHOP_E2E_S3_ACCESS_KEY_ID",
  "BEAMHOP_E2E_S3_SECRET_ACCESS_KEY",
  "BEAMHOP_E2E_S3_DRIVER_BUCKET", // e2e/relay/blossom-drivers.test.ts
]);
const KNOWN_ENV = new Set([...ENV.map(([name]) => name), ...OTHER_ENV]);

/** Config file keys read outside ConfigSchema (they become ServerExtras). */
const FILE_EXTRAS = new Set(["server.metricsToken", "server.prometheus", "plugins.enabled"]);

type SchemaNode = { _zod: { def: { type: string; innerType?: SchemaNode; shape?: Record<string, SchemaNode> } } };

/**
 * Dotted paths in `json` that the schema doesn't know (zod silently strips them, so a typo like `blosom` or
 * `server.trustProxies` would otherwise just fall back to the default). Records and arrays are not descended into.
 */
export function unknownKeys(json: Json, schema: SchemaNode = ConfigSchema as unknown as SchemaNode, prefix = ""): string[] {
  let def = schema._zod.def;
  while (def.innerType) def = def.innerType._zod.def; // optional / default / prefault / nullable wrappers
  if (def.type !== "object" || !def.shape) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(json)) {
    const path = prefix + k;
    const child = def.shape[k];
    if (!child) {
      if (!FILE_EXTRAS.has(path)) out.push(path);
    } else if (isObj(v)) out.push(...unknownKeys(v, child, `${path}.`));
  }
  return out;
}

/** BEAMHOP_* variables beamhop doesn't read (blank ones included: compose often sets the whole list). */
export function unknownEnv(env: Record<string, string | undefined>): string[] {
  return Object.keys(env).filter((k) => k.startsWith("BEAMHOP_") && !KNOWN_ENV.has(k));
}

export function envToConfig(env: Record<string, string | undefined>): Json {
  const out: Json = {};
  for (const [name, path, parse] of ENV) {
    const v = env[name];
    // blank (incl. whitespace-only, e.g. compose's `${VAR:-}` with stray spaces) = unset, like every other var
    if (v === undefined || v.trim() === "") continue;
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
  const warn = opts.warn ?? ((m: string) => console.error(`beamhop: warning: ${m}`));
  const warnings: string[] = [];
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
    // warn, don't fail: an old or hand-edited file should still boot
    for (const k of unknownKeys(fileJson)) warnings.push(`unknown key "${k}" in ${configPath} (ignored)`);
  }
  for (const k of unknownEnv(env)) warnings.push(`unknown environment variable ${k} (ignored)`);
  for (const w of warnings) warn(w);
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
  proxyMatcher(config.server.trustedProxies); // fail at boot on an entry that isn't an address or range

  // resolve relative file paths against the config file location (or cwd)
  const base = configPath ? dirname(configPath) : (opts.cwd ?? process.cwd());
  const abs = (p: string) => (p === ":memory:" ? p : resolve(base, p));
  config.database.sqlitePath = abs(config.database.sqlitePath);
  config.blossom.fsPath = abs(config.blossom.fsPath);
  config.plugins.dir = abs(config.plugins.dir);
  // explicit plugin paths are relative to the config file like every other path (bare names stay npm specifiers)
  config.plugins.packages = config.plugins.packages.map((p) => (p.startsWith(".") ? abs(p) : p));
  if (config.metrics.geoipDbPath) config.metrics.geoipDbPath = abs(config.metrics.geoipDbPath);
  if (config.admin.uiDir) config.admin.uiDir = abs(config.admin.uiDir);
  config.server.publicUrl = config.server.publicUrl.replace(/\/+$/, "");

  const filePlugins = (fileJson.plugins as Json | undefined)?.enabled;
  const fileServer = fileJson.server as Json | undefined;
  // like every other BEAMHOP_* variable, an empty value (compose `${VAR:-}`) means "unset"
  const pluginsEnv = env.BEAMHOP_PLUGINS_ENABLED || undefined;
  const prometheusEnv = env.BEAMHOP_PROMETHEUS || undefined;
  const extras: ServerExtras = {
    pluginsEnabled: pluginsEnv !== undefined ? list(pluginsEnv) : Array.isArray(filePlugins) ? filePlugins.map(String) : [],
    metricsToken: env.BEAMHOP_METRICS_TOKEN || (typeof fileServer?.metricsToken === "string" ? fileServer.metricsToken : undefined),
    prometheus: prometheusEnv !== undefined ? bool(prometheusEnv) : fileServer?.prometheus !== false,
  };
  if (extras.metricsToken !== undefined && isPlaceholderToken(extras.metricsToken)) {
    // refusing to boot would crash-loop deployments that copied the old example; serving /metrics behind a
    // well-known token would be worse than public — so turn the endpoint off and say why
    console.error(
      "beamhop: server.metricsToken / BEAMHOP_METRICS_TOKEN is still the example placeholder; /metrics is DISABLED. Set a long random token (e.g. `openssl rand -hex 32`) to enable it.",
    );
    extras.metricsToken = undefined;
    extras.prometheus = false;
  }
  return { config, extras, configPath, warnings };
}
