// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Boot configuration: defaults ← BEAMHOP_* env ← beamhop.yaml (the file wins on boot),
 * validated by core `parseConfig`. Also defines the on-disk data dir layout.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { type BeamhopConfig, parseConfig } from '@beamhop/core';

export type Env = Record<string, string | undefined>;

/** Env vars with a dedicated meaning that are not mapped into the config tree. */
const RESERVED_ENV = new Set([
  'BEAMHOP_CONFIG',
  'BEAMHOP_SAFE',
  'BEAMHOP_PWA_DIR',
  'BEAMHOP_TEAM_DIR',
  'BEAMHOP_SHARP_PATH',
  'BEAMHOP_VERSION',
  'BEAMHOP_LOG_LEVEL',
  'BEAMHOP_DOMAIN',
  'BEAMHOP_LISTEN',
  'BEAMHOP_DATA_DIR',
  'BEAMHOP_ACME_DIRECTORY',
  'BEAMHOP_ACME_HTTP_PORT',
]);

const snakeToCamel = (s: string) =>
  s.toLowerCase().replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

function parseEnvValue(v: string): unknown {
  const t = v.trim();
  if (t === 'true' || t === 'false' || t === 'null' || /^-?\d+(\.\d+)?$/.test(t)) {
    return JSON.parse(t);
  }
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
}

function setPath(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let cur = obj;
  for (const [i, key] of path.entries()) {
    if (i === path.length - 1) {
      cur[key] = value;
      return;
    }
    const next = cur[key];
    if (!next || typeof next !== 'object' || Array.isArray(next)) cur[key] = {};
    cur = cur[key] as Record<string, unknown>;
  }
}

/**
 * Map `BEAMHOP_*` env vars into a partial config.
 * `__` separates path segments; segments are SNAKE_CASE → camelCase.
 *   BEAMHOP_NODE__TRUST_PROXY=true          → node.trustProxy = true
 *   BEAMHOP_BLOB_STORAGE__ACCESS_KEY_ID=x   → blobStorage.accessKeyId = "x"
 * Shorthands: BEAMHOP_LISTEN, BEAMHOP_DATA_DIR, BEAMHOP_DOMAIN (single relay host).
 */
export function envToConfig(env: Env): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) {
    if (!k.startsWith('BEAMHOP_') || v === undefined || v === '' || RESERVED_ENV.has(k)) continue;
    const path = k.slice('BEAMHOP_'.length).split('__').filter(Boolean).map(snakeToCamel);
    if (path.length === 0) continue;
    setPath(out, path, parseEnvValue(v));
  }
  if (env.BEAMHOP_LISTEN) setPath(out, ['node', 'listen'], env.BEAMHOP_LISTEN);
  if (env.BEAMHOP_DATA_DIR) setPath(out, ['node', 'dataDir'], env.BEAMHOP_DATA_DIR);
  if (env.BEAMHOP_DOMAIN && !out.relays) {
    out.relays = [{ id: 'main', hosts: env.BEAMHOP_DOMAIN.split(',').map((h) => h.trim()) }];
  }
  return out;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Deep merge; arrays and scalars from `over` replace those in `base`. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v);
  return out;
}

export interface BootArgs {
  configPath?: string;
  dataDir?: string;
  safe: boolean;
  help: boolean;
  version: boolean;
  /** Probe the local /healthz and exit 0/1 (Docker HEALTHCHECK; no shell needed). */
  healthcheck: boolean;
  listen?: string;
}

export function parseArgs(argv: string[], env: Env = {}): BootArgs {
  const args: BootArgs = { safe: false, help: false, version: false, healthcheck: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    const [flag, inline] = a.includes('=')
      ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]
      : [a, undefined];
    const value = () => inline ?? argv[++i];
    switch (flag) {
      case '--safe':
        args.safe = true;
        break;
      case '--config':
      case '-c':
        args.configPath = value();
        break;
      case '--data-dir':
        args.dataDir = value();
        break;
      case '--listen':
        args.listen = value();
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      case '--version':
      case '-v':
        args.version = true;
        break;
      case '--healthcheck':
        args.healthcheck = true;
        break;
    }
  }
  if (!args.safe && /^(1|true|yes)$/i.test(env.BEAMHOP_SAFE ?? '')) args.safe = true;
  return args;
}

export interface LoadedConfig {
  config: BeamhopConfig;
  /** Path of the YAML file that was applied, if any. */
  file?: string;
  /** Raw (unvalidated) file contents; the config service may store it as a revision. */
  fileConfig?: Record<string, unknown>;
  /** Top-level config keys contributed by env. */
  envKeys: string[];
  /** True when no relays were configured and a default catch-all relay was added. */
  defaultRelay: boolean;
}

export interface LoadConfigOptions {
  env?: Env;
  args?: Partial<BootArgs>;
  cwd?: string;
}

export function readYamlFile(path: string): Record<string, unknown> {
  const text = readFileSync(path, 'utf8');
  const parsed = text.trim() ? Bun.YAML.parse(text) : {};
  if (parsed !== null && !isPlainObject(parsed)) {
    throw new Error(`${path}: expected a YAML mapping at the top level`);
  }
  return (parsed ?? {}) as Record<string, unknown>;
}

/** Locate beamhop.yaml: --config, BEAMHOP_CONFIG, ./beamhop.yaml, <dataDir>/beamhop.yaml. */
export function findConfigFile(
  args: Partial<BootArgs>,
  env: Env,
  cwd: string,
  dataDir: string,
): string | undefined {
  const explicit = args.configPath ?? env.BEAMHOP_CONFIG;
  if (explicit) {
    const p = resolve(cwd, explicit);
    if (!existsSync(p)) throw new Error(`config file not found: ${p}`);
    return p;
  }
  for (const name of ['beamhop.yaml', 'beamhop.yml']) {
    const p = resolve(cwd, name);
    if (existsSync(p)) return p;
  }
  const inData = resolve(cwd, dataDir, 'beamhop.yaml');
  return existsSync(inData) ? inData : undefined;
}

export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const env = opts.env ?? (process.env as Env);
  const args = opts.args ?? {};
  const cwd = opts.cwd ?? process.cwd();

  const fromEnv = envToConfig(env);
  if (args.dataDir) setPath(fromEnv, ['node', 'dataDir'], args.dataDir);
  const envNode = (fromEnv.node ?? {}) as { dataDir?: string };
  const file = findConfigFile(args, env, cwd, envNode.dataDir ?? './data');
  const fileConfig = file ? readYamlFile(file) : undefined;

  let merged = deepMerge(fromEnv, fileConfig ?? {}) as Record<string, unknown>;
  // CLI flags are explicit operator intent for this boot only.
  if (args.listen) merged = deepMerge(merged, { node: { listen: args.listen } }) as typeof merged;
  if (args.dataDir)
    merged = deepMerge(merged, { node: { dataDir: args.dataDir } }) as typeof merged;

  let defaultRelay = false;
  if (!Array.isArray(merged.relays) || merged.relays.length === 0) {
    merged.relays = [{ id: 'main', hosts: ['*'] }];
    defaultRelay = true;
  }

  const config = parseConfig(merged);
  const dataDir = isAbsolute(config.node.dataDir)
    ? config.node.dataDir
    : resolve(cwd, config.node.dataDir);
  return {
    config: { ...config, node: { ...config.node, dataDir } },
    file,
    fileConfig,
    envKeys: Object.keys(fromEnv),
    defaultRelay,
  };
}

// ───────────────────────────── Data dir layout ─────────────────────────────

/**
 * <dataDir>/
 *   beamhop.yaml       optional config file (also looked up in cwd)
 *   state.json         node state (first boot time)
 *   db/beamhop.sqlite  default SQLite database (+ -wal/-shm; Litestream replicates this)
 *   blobs/             default fs blob store
 *   tls/               ACME account key, certificate, private key
 *   secrets/           node secrets (IP-hash salt secret), mode 0700
 *   backups/           local backups
 */
export interface DataLayout {
  root: string;
  stateFile: string;
  dbDir: string;
  sqlitePath: string;
  blobsDir: string;
  tlsDir: string;
  secretsDir: string;
  backupsDir: string;
}

export function dataLayout(root: string): DataLayout {
  return {
    root,
    stateFile: join(root, 'state.json'),
    dbDir: join(root, 'db'),
    sqlitePath: join(root, 'db', 'beamhop.sqlite'),
    blobsDir: join(root, 'blobs'),
    tlsDir: join(root, 'tls'),
    secretsDir: join(root, 'secrets'),
    backupsDir: join(root, 'backups'),
  };
}

export function ensureDataDir(root: string): DataLayout {
  const l = dataLayout(root);
  for (const d of [l.root, l.dbDir, l.blobsDir, l.tlsDir, l.backupsDir]) {
    mkdirSync(d, { recursive: true });
  }
  mkdirSync(l.secretsDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(l.secretsDir, 0o700);
    chmodSync(l.tlsDir, 0o700);
  } catch {
    // Non-POSIX filesystems: best effort.
  }
  return l;
}

/** Fill storage paths that default to the data dir. */
export function withDataDirDefaults(config: BeamhopConfig, layout: DataLayout): BeamhopConfig {
  const storage = { ...config.storage };
  if (storage.driver === 'sqlite' && !storage.url) storage.url = layout.sqlitePath;
  const blobStorage = { ...config.blobStorage };
  if (blobStorage.driver === 'fs' && !blobStorage.path) blobStorage.path = layout.blobsDir;
  return { ...config, storage, blobStorage };
}

/** Parse `host:port`, `[v6]:port` or `:port`. */
export function parseListen(listen: string): { hostname: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:]*)):(\d+)$/.exec(listen.trim());
  if (!m) {
    if (/^\d+$/.test(listen.trim())) return { hostname: '0.0.0.0', port: Number(listen) };
    throw new Error(`invalid listen address: ${listen}`);
  }
  return { hostname: m[1] ?? (m[2] || '0.0.0.0'), port: Number(m[3]) };
}
