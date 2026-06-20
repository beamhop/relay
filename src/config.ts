import type { NipId, RelayAdminConfig, RelayConfig, RelayLimits, RelayMetadata } from "./types";

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

interface ConfigFile {
  host?: string;
  port?: number;
  relayUrl?: string;
  persistence?: string | boolean;
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
  const fileConfig = args.config ? await readConfigFile(args.config) : {};
  const persistence = resolvePersistence(args, fileConfig);
  const admin = resolveAdminConfig(args, fileConfig);
  const disabledNips = new Set<NipId>([...(fileConfig.disabledNips ?? []), ...args.disabledNips].map(normalizeNipId));
  const relay = { ...DEFAULT_RELAY, ...(fileConfig.relay ?? {}) };
  if (args.name) relay.name = args.name;
  if (args.description) relay.description = args.description;

  const config: RelayConfig = {
    host: args.host ?? fileConfig.host ?? "0.0.0.0",
    port: resolvePort(args, fileConfig),
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
  if (persistence) config.persistence = persistence;
  return config;
}

function parseArgs(argv: string[]) {
  const parsed: {
    config?: string;
    host?: string;
    port?: number;
    relayUrl?: string;
    persistence?: string | true;
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

async function readConfigFile(path: string): Promise<ConfigFile> {
  const file = Bun.file(path);
  if (!(await file.exists())) throw new Error(`config file not found: ${path}`);
  return (await file.json()) as ConfigFile;
}

function resolvePort(args: ReturnType<typeof parseArgs>, fileConfig: ConfigFile): number {
  if (args.port !== undefined) return args.port;
  if (fileConfig.port !== undefined) return fileConfig.port;
  if (process.env.PORT !== undefined) return Number.parseInt(process.env.PORT, 10);
  return 7777;
}

function resolvePersistence(args: ReturnType<typeof parseArgs>, fileConfig: ConfigFile): string | undefined {
  if (typeof args.persistence === "string") return args.persistence;
  if (args.persistence === true) return "beamhop-relay.sqlite";
  if (typeof fileConfig.persistence === "string") return fileConfig.persistence;
  if (fileConfig.persistence === true) return "beamhop-relay.sqlite";
  return undefined;
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
  -w, --web [password]          Enable password-protected browser admin panel
  --password <password>         Password for the browser admin panel
  --admin-password <password>   Alias for --password
  -p, --persistence [path]      Enable SQLite persistence (default path: beamhop-relay.sqlite)
  --config <path>               Read JSON config
  --disable-nip <id[,id]>       Disable implemented NIP plugins
  --require-auth-read           Require NIP-42 auth before REQ/COUNT
  --require-auth-write          Require NIP-42 auth before EVENT
  --reject-protected-events     Reject NIP-70 protected events instead of accepting authenticated authors
`);
}
