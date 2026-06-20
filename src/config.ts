import type {
  NipId,
  PostgresConnectionConfig,
  RelayAdminConfig,
  RelayConfig,
  RelayLimits,
  RelayMetadata,
  StorageBackend,
  StorageConfig,
} from "./types";

const DEFAULT_LIMITS: RelayLimits = {
  maxMessageLength: 524_288,
  maxSubscriptions: 64,
  maxSubIdLength: 64,
  maxLimit: 1000,
  defaultLimit: 500,
  maxEventTags: 4000,
  maxContentLength: 1_000_000,
  authEventMaxAgeSeconds: 600,
};

const DEFAULT_RELAY: RelayMetadata = {
  name: "Beamhop Relay",
  description: "A Bun/TypeScript Nostr relay.",
  software: "https://github.com/nostr-protocol/nips",
  version: "0.1.0",
};

const DEFAULT_SQLITE_PATH = "beamhop-relay.sqlite";
const STORAGE_BACKENDS: StorageBackend[] = ["memory", "sqlite", "postgres"];

// Auto-discovered in the working directory when no --config is passed (ADR-0004). YAML first.
const AUTO_CONFIG_FILES = ["relay.yaml", "relay.config.yaml", "relay.yml", "relay.json"];

interface ConfigFile {
  host?: string;
  port?: number;
  relayUrl?: string;
  persistence?: string | boolean;
  storage?: Partial<StorageConfig>;
  admin?: Partial<RelayAdminConfig>;
  disabledNips?: NipId[];
  requireAuthForRead?: boolean;
  requireAuthForWrite?: boolean;
  acceptProtectedEvents?: boolean;
  managementAdminPubkeys?: string[];
  relay?: Partial<RelayMetadata>;
  limits?: Partial<RelayLimits>;
}

export async function loadConfig(argv = Bun.argv.slice(2)): Promise<RelayConfig> {
  const args = parseArgs(argv);
  const configPath = args.config ?? (await discoverConfigFile());
  const fileConfig = configPath ? await readConfigFile(configPath) : {};
  const storage = resolveStorage(args, fileConfig);
  const admin = resolveAdminConfig(args, fileConfig);
  const disabledNips = new Set<NipId>([...(fileConfig.disabledNips ?? []), ...args.disabledNips].map(normalizeNipId));
  const relay = { ...DEFAULT_RELAY, ...(fileConfig.relay ?? {}) };
  if (args.name) relay.name = args.name;
  if (args.description) relay.description = args.description;

  const config: RelayConfig = {
    host: args.host ?? process.env.HOST ?? fileConfig.host ?? "0.0.0.0",
    port: resolvePort(args, fileConfig),
    storage,
    admin,
    disabledNips,
    relay,
    limits: { ...DEFAULT_LIMITS, ...(fileConfig.limits ?? {}) },
    requireAuthForRead: args.requireAuthForRead ?? fileConfig.requireAuthForRead ?? false,
    requireAuthForWrite: args.requireAuthForWrite ?? fileConfig.requireAuthForWrite ?? false,
    acceptProtectedEvents: args.acceptProtectedEvents ?? fileConfig.acceptProtectedEvents ?? true,
    managementAdminPubkeys: new Set(fileConfig.managementAdminPubkeys ?? []),
  };
  const relayUrl = args.relayUrl ?? fileConfig.relayUrl;
  if (relayUrl) config.relayUrl = relayUrl;
  if (storage.backend === "sqlite" && storage.sqlitePath) config.persistence = storage.sqlitePath;
  return config;
}

function parseArgs(argv: string[]) {
  const parsed: {
    config?: string;
    host?: string;
    port?: number;
    relayUrl?: string;
    persistence?: string | true;
    storageBackend?: StorageBackend;
    postgresUrl?: string;
    disabledNips: NipId[];
    web?: boolean;
    password?: string;
    name?: string;
    description?: string;
    requireAuthForRead?: boolean;
    requireAuthForWrite?: boolean;
    acceptProtectedEvents?: boolean;
  } = { disabledNips: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    const next = argv[i + 1];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--config" && next) {
      parsed.config = next;
      i += 1;
    } else if (arg === "--host" && next) {
      parsed.host = next;
      i += 1;
    } else if (arg === "--port" && next) {
      parsed.port = Number.parseInt(next, 10);
      i += 1;
    } else if (arg === "--relay-url" && next) {
      parsed.relayUrl = next;
      i += 1;
    } else if (arg === "--storage" && next) {
      parsed.storageBackend = assertBackend(next);
      i += 1;
    } else if (arg === "--postgres-url" && next) {
      parsed.postgresUrl = next;
      i += 1;
    } else if (arg === "--web" || arg === "-w") {
      parsed.web = true;
      if (next && !next.startsWith("-")) {
        parsed.password = next;
        i += 1;
      }
    } else if ((arg === "--password" || arg === "--admin-password") && next) {
      parsed.password = next;
      i += 1;
    } else if (arg === "--persistence" || arg === "-p") {
      if (next && !next.startsWith("-")) {
        parsed.persistence = next;
        i += 1;
      } else {
        parsed.persistence = true;
      }
    } else if ((arg === "--disable-nip" || arg === "--disable-plugin") && next) {
      parsed.disabledNips.push(...next.split(","));
      i += 1;
    } else if (arg === "--name" && next) {
      parsed.name = next;
      i += 1;
    } else if (arg === "--description" && next) {
      parsed.description = next;
      i += 1;
    } else if (arg === "--require-auth-read") {
      parsed.requireAuthForRead = true;
    } else if (arg === "--require-auth-write") {
      parsed.requireAuthForWrite = true;
    } else if (arg === "--reject-protected-events") {
      parsed.acceptProtectedEvents = false;
    }
  }
  return parsed;
}

async function discoverConfigFile(): Promise<string | undefined> {
  for (const name of AUTO_CONFIG_FILES) {
    if (await Bun.file(name).exists()) return name;
  }
  return undefined;
}

async function readConfigFile(path: string): Promise<ConfigFile> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`config file not found: ${path}`);
  // YAML is a superset of JSON, so a single parser reads both .yaml and .json (ADR-0004).
  const parsed = Bun.YAML.parse(await file.text());
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`config file must be a mapping: ${path}`);
  }
  return parsed as ConfigFile;
}

function resolvePort(args: ReturnType<typeof parseArgs>, fileConfig: ConfigFile): number {
  // Precedence: CLI > env > file > default (ADR-0004).
  if (args.port !== undefined) return args.port;
  if (process.env.PORT !== undefined) return Number.parseInt(process.env.PORT, 10);
  if (fileConfig.port !== undefined) return fileConfig.port;
  return 7777;
}

function resolveStorage(args: ReturnType<typeof parseArgs>, fileConfig: ConfigFile): StorageConfig {
  const fileStorage = fileConfig.storage ?? {};
  const envBackend = process.env.RELAY_STORAGE_BACKEND ? assertBackend(process.env.RELAY_STORAGE_BACKEND) : undefined;
  const sqlitePath = resolveSqlitePath(args, fileConfig, fileStorage);

  // Precedence: CLI > env > file > (legacy --persistence implies sqlite) > memory.
  // A CLI --postgres-url is explicit intent to use postgres; env DATABASE_URL is not.
  const backend: StorageBackend =
    args.storageBackend ??
    (args.postgresUrl ? "postgres" : undefined) ??
    envBackend ??
    (fileStorage.backend ? assertBackend(fileStorage.backend) : undefined) ??
    (hasPersistenceFlag(args, fileConfig) ? "sqlite" : undefined) ??
    "memory";

  if (backend === "sqlite") return { backend, sqlitePath };
  if (backend === "postgres") return { backend, postgres: resolvePostgres(args, fileStorage.postgres) };
  return { backend };
}

function hasPersistenceFlag(args: ReturnType<typeof parseArgs>, fileConfig: ConfigFile): boolean {
  return args.persistence !== undefined || process.env.RELAY_SQLITE_PATH !== undefined || fileConfig.persistence !== undefined;
}

function resolveSqlitePath(args: ReturnType<typeof parseArgs>, fileConfig: ConfigFile, fileStorage: Partial<StorageConfig>): string {
  if (typeof args.persistence === "string") return args.persistence;
  if (process.env.RELAY_SQLITE_PATH) return process.env.RELAY_SQLITE_PATH;
  if (fileStorage.sqlitePath) return fileStorage.sqlitePath;
  if (typeof fileConfig.persistence === "string") return fileConfig.persistence;
  return DEFAULT_SQLITE_PATH;
}

function resolvePostgres(args: ReturnType<typeof parseArgs>, filePostgres: PostgresConnectionConfig | undefined): PostgresConnectionConfig {
  const base = filePostgres ?? {};
  const env = process.env;
  const url = args.postgresUrl ?? env.RELAY_POSTGRES_URL ?? env.DATABASE_URL ?? base.url;
  const result: PostgresConnectionConfig = { ...base };
  if (url) result.url = url;
  if (env.RELAY_POSTGRES_HOST) result.host = env.RELAY_POSTGRES_HOST;
  if (env.RELAY_POSTGRES_PORT) result.port = Number.parseInt(env.RELAY_POSTGRES_PORT, 10);
  if (env.RELAY_POSTGRES_DB) result.database = env.RELAY_POSTGRES_DB;
  if (env.RELAY_POSTGRES_USER) result.user = env.RELAY_POSTGRES_USER;
  if (env.RELAY_POSTGRES_PASSWORD) result.password = env.RELAY_POSTGRES_PASSWORD;
  if (env.RELAY_POSTGRES_SCHEMA) result.schema = env.RELAY_POSTGRES_SCHEMA;
  return result;
}

function assertBackend(value: string): StorageBackend {
  if ((STORAGE_BACKENDS as string[]).includes(value)) return value as StorageBackend;
  throw new Error(`invalid storage backend: ${value} (expected one of ${STORAGE_BACKENDS.join(", ")})`);
}

function resolveAdminConfig(args: ReturnType<typeof parseArgs>, fileConfig: ConfigFile): RelayAdminConfig {
  const web = args.web ?? fileConfig.admin?.web ?? false;
  const password = args.password ?? process.env.RELAY_PASSWORD ?? fileConfig.admin?.password;
  if (web && !password) throw new Error("admin web interface requires --password, --admin-password, --web <password>, -w <password>, or RELAY_PASSWORD");
  return password ? { web, password } : { web };
}

export function normalizeNipId(nip: NipId): NipId {
  const trimmed = String(nip).trim().toUpperCase();
  if (/^\d$/.test(trimmed)) return `0${trimmed}`;
  return trimmed;
}

function printHelp(): void {
  console.log(`beamhop-relay

Usage:
  bun run start -- [options]

Options:
  --host <host>                 Host to bind (default: 0.0.0.0)
  --port <port>                 Port to bind (default: 7777)
  --relay-url <url>             Public relay URL used by AUTH validation
  --storage <backend>           Storage backend: memory | sqlite | postgres
  --postgres-url <url>          Postgres connection string (selects the postgres backend)
  -w, --web [password]          Enable password-protected browser admin panel
  --password <password>         Password for the browser admin panel
  --admin-password <password>   Alias for --password
  -p, --persistence [path]      Enable SQLite persistence (default path: ${DEFAULT_SQLITE_PATH})
  --config <path>               Read a YAML or JSON config file
  --disable-nip <id[,id]>       Disable implemented NIP plugins
  --require-auth-read           Require NIP-42 auth before REQ/COUNT
  --require-auth-write          Require NIP-42 auth before EVENT
  --reject-protected-events     Reject NIP-70 protected events instead of accepting authenticated authors

Config is auto-discovered from relay.yaml / relay.config.yaml / relay.json in the working
directory. Precedence: CLI flags > environment variables > config file > defaults.
`);
}
