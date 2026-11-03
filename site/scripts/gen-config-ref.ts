/**
 * Writes site/src/content/docs/config/reference.md from the real schemas:
 *   - ConfigSchema / RuntimeSettingsSchema (packages/sdk/src/config.ts) give every key, type, range and default
 *   - the BEAMHOP_* table in packages/server/src/config.ts gives the env vars; each one is run through the
 *     server's own envToConfig() to find the key it sets
 * Descriptions are written below by hand. The script fails if a schema key has no description (or a description
 * names a key that no longer exists), so the page can't silently drift from the code.
 *
 * Run from the repo root: bun site/scripts/gen-config-ref.ts   (or: cd site && bun run gen:config)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const sdkConfigPath = resolve(repo, "packages/sdk/src/config.ts");
const serverConfigPath = resolve(repo, "packages/server/src/config.ts");
const outPath = resolve(repo, "site/src/content/docs/config/reference.md");

const { ConfigSchema, RuntimeSettingsSchema, WordFilterSchema, RetentionRuleSchema } = await import(sdkConfigPath);
const { envToConfig } = await import(serverConfigPath);
// the zod the schemas were built with (resolved from the sdk package, not from site/)
const { z } = await import(Bun.resolveSync("zod", dirname(sdkConfigPath)));

type JS = {
  type?: string | string[];
  properties?: Record<string, JS>;
  additionalProperties?: JS | boolean;
  items?: JS;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  required?: string[];
  anyOf?: JS[];
};
const toJson = (schema: unknown): JS => z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JS;

// ---------------------------------------------------------------------------------------------------------------
// Hand-written descriptions (from reading how each key is used)
// ---------------------------------------------------------------------------------------------------------------

const SECTIONS: Record<string, { title: string; intro: string }> = {
  server: { title: "server", intro: "Where beamhop listens, the address people reach it at, and how it treats a reverse proxy in front of it." },
  database: { title: "database", intro: "Where events, users, settings and everything else are stored." },
  relaySecretKey: { title: "relaySecretKey", intro: "The relay's own Nostr identity." },
  blossom: { title: "blossom", intro: "The Blossom media server: where uploaded files live and the abuse limits on uploads and mirrors. Who may upload, size limits and quotas are admin-panel settings (see below)." },
  metrics: { title: "metrics", intro: "Built-in metrics history, OpenTelemetry export and GeoIP lookups." },
  admin: { title: "admin", intro: "The admin panel and admin API." },
  plugins: { title: "plugins", intro: "Where plugins are loaded from." },
  logLevel: { title: "Logging", intro: "What beamhop writes to its log, and in which format." },
};

const CONFIG_DESC: Record<string, string> = {
  "server.host": "Address to listen on. `0.0.0.0` listens on every interface; use `127.0.0.1` to accept only local connections (for example when a reverse proxy runs on the same machine).",
  "server.port": "Port to listen on. Also used for the default `publicUrl`.",
  "server.publicUrl":
    "The address people use to reach your relay, such as `https://relay.example.com`. It goes into NIP-42 AUTH checks, NIP-98 checks and Blossom blob URLs, so set it to the real public URL. If you don't set it, it follows the port (`http://localhost:<port>`). A trailing slash is removed.",
  "server.trustProxy":
    "Turn on when a reverse proxy (nginx, Caddy, Traefik, a CDN) sits in front of beamhop. beamhop then reads the client's IP from the proxy's header (see `proxyIpHeader`), so per-IP limits apply to real clients instead of to the proxy. Only peers listed in `trustedProxies` are believed.",
  "server.proxyIpHeader":
    "The header your proxy puts the client IP in. With `x-forwarded-for` the rightmost entry is used. You can also name a single-address header the proxy sets, such as `x-real-ip` or `cf-connecting-ip`.",
  "server.trustedProxies":
    "Addresses or CIDR ranges whose client-IP header is believed when `trustProxy` is on. Anyone else is identified by their own socket address, so a client that reaches the port directly can't fake its IP. The default covers loopback and private networks. In env vars, separate entries with commas. An entry that isn't an address or range stops beamhop at boot.",
  "server.shutdownTimeoutMs":
    "How long a graceful shutdown may take, in milliseconds. In-flight requests and queued events get up to half of it (at most 5 seconds), then services close in order. When the time runs out the process exits anyway.",
  "server.verifyWorkers":
    "Worker threads that check event signatures off the main thread. `0` (the default) checks them on the main thread. Worth raising only when many connections publish at once (above roughly 5,000 events per second on one core).",
  "database.driver": "`sqlite` keeps everything in one local file. `postgres` uses a PostgreSQL server (set `postgresUrl`).",
  "database.sqlitePath": "The SQLite database file. A relative path is resolved against the config file's folder (or the working directory when there is no file). `:memory:` keeps the database in memory only.",
  "database.postgresUrl": "PostgreSQL connection URL, such as `postgres://user:password@host:5432/beamhop`. Required when `driver` is `postgres`.",
  relaySecretKey:
    "The relay's own secret key, as hex or `nsec`. It signs NIP-29 group metadata and is published as `self` in the NIP-11 document. If you leave it out, beamhop generates one on first start and keeps it in the database.",
  "blossom.enabled": "Turn the Blossom media server on or off.",
  "blossom.driver": "`fs` stores files on local disk (`fsPath`). `s3` stores them in an S3-compatible bucket (fill in `blossom.s3`).",
  "blossom.fsPath": "Folder for uploaded files when `driver` is `fs`. A relative path is resolved against the config file's folder.",
  "blossom.s3.endpoint": "S3 endpoint URL, for example your MinIO, R2 or other S3-compatible service.",
  "blossom.s3.region": "S3 region. Many S3-compatible services accept `auto`.",
  "blossom.s3.bucket": "Bucket name.",
  "blossom.s3.accessKeyId": "Access key ID for the bucket.",
  "blossom.s3.secretAccessKey": "Secret access key for the bucket.",
  "blossom.s3.publicUrl": "Optional public base URL of the bucket (for example a CDN). When set, downloads of approved files are redirected to `<publicUrl>/<sha256>` instead of being streamed through beamhop.",
  "blossom.limits.uploadsPerMinutePerIp": "Uploads and mirrors per minute from one client IP (IPv6: per /64). `0` means unlimited.",
  "blossom.limits.uploadsPerMinutePerPubkey": "Uploads and mirrors per minute from one pubkey. `0` means unlimited.",
  "blossom.limits.maxConcurrentUploads": "How many uploads are processed (type check, metadata stripping, thumbnails, storing) at the same time.",
  "blossom.limits.maxQueuedUploads": "Received uploads that may wait for a processing slot. Beyond that, new uploads get a 503 and can retry.",
  "blossom.limits.maxBufferedUploadBytes": "Total bytes of upload and mirror bodies held in memory at once. Never lower than twice the maximum upload size.",
  "blossom.limits.maxConcurrentUploadsPerIp": "Uploads being received at the same time from one client IP (IPv6: per /64). `0` means unlimited.",
  "blossom.limits.uploadStallMs": "An upload that sends nothing for this many milliseconds is dropped.",
  "blossom.limits.minUploadBytesPerSec": "After the first 30 seconds, uploads averaging less than this many bytes per second are dropped. `0` turns the check off.",
  "blossom.limits.mirrorPorts": "Ports that BUD-04 mirroring may connect to on other servers. In env vars, separate ports with commas; the list can't be empty.",
  "blossom.limits.mirrorTimeoutMs": "Time allowed for a whole BUD-04 mirror download (connect, redirects and body), in milliseconds.",
  "metrics.otel.enabled": "Send metrics to an OpenTelemetry collector over OTLP/HTTP.",
  "metrics.otel.endpoint": "The collector's OTLP/HTTP metrics URL.",
  "metrics.otel.headers": "Extra HTTP headers sent with each export, for example an API key. In the env var, write `key=value` pairs separated by commas (values may be percent-encoded, so `%2C` carries a comma).",
  "metrics.otel.intervalMs": "How often metrics are exported, in milliseconds.",
  "metrics.geoipDbPath": "Path to a GeoLite2-City or DB-IP city-lite `.mmdb` file. With it, the dashboard shows where connections come from; without it, geo stats are off.",
  "metrics.retentionDays": "How many days of metrics history the dashboard keeps. Older rows are pruned.",
  "admin.enabled": "Serve the admin panel (`/admin`), the admin API and NIP-86 relay management. Turn off for a relay you manage only from the command line.",
  "admin.owners": "Pubkeys (npub or hex) that always have the `owner` role. In the env var, separate them with commas. You can also add admins later with `beamhop admin add`.",
  "admin.sessionSecret": "Deprecated and ignored: admin sessions are random server-side IDs now. Still accepted so old config files keep loading.",
  "admin.uiDir": "Folder of the built admin panel. Normally you don't need this: beamhop finds the built panel on its own (the Docker image sets it for you).",
  "admin.vapid.publicKey": "Web Push (VAPID) public key for admin-panel notifications. If you leave `vapid` out, beamhop generates a key pair once and keeps it in the database.",
  "admin.vapid.privateKey": "Web Push (VAPID) private key.",
  "admin.vapid.subject": "Web Push contact, usually a `mailto:` address.",
  "plugins.dir": "Local folder of plugins (each one a folder with a `package.json` or `index.ts`). A relative path is resolved against the config file's folder.",
  "plugins.packages": "npm package names or paths of extra plugins to load. Paths starting with `.` are resolved against the config file's folder. In the env var, separate them with commas.",
  "plugins.autoDiscoverNpm":
    "Also load every `beamhop-plugin-NAME` or `@scope/beamhop-plugin-NAME` package found in `node_modules`. Off by default, because discovered packages run code at startup, so a stray dependency with such a name would run inside your relay.",
  logLevel: "How chatty the log is: `debug`, `info`, `warn` or `error`.",
  logFormat: "`text` is easy to read in a terminal. `json` writes one JSON object per line, for log shippers.",
};

/** Built-in values for optional keys without a schema default (the schema leaves them unset; the code falls back). */
const BUILT_IN_DEFAULTS: Record<string, string> = {
  "blossom.limits.uploadsPerMinutePerIp": "`60`",
  "blossom.limits.uploadsPerMinutePerPubkey": "`60`",
  "blossom.limits.maxConcurrentUploads": "`8`",
  "blossom.limits.maxQueuedUploads": "`32`",
  "blossom.limits.maxBufferedUploadBytes": "`268435456` (256 MiB)",
  "blossom.limits.maxConcurrentUploadsPerIp": "`4`",
  "blossom.limits.uploadStallMs": "`15000`",
  "blossom.limits.minUploadBytesPerSec": "`4096`",
  "blossom.limits.mirrorPorts": "`[80, 443]`",
  "blossom.limits.mirrorTimeoutMs": "`30000`",
  "server.publicUrl": "`http://localhost:<port>`",
  relaySecretKey: "generated on first start",
  "admin.vapid.publicKey": "generated on first start",
  "admin.vapid.privateKey": "generated on first start",
};

/** Keys read from the config file outside ConfigSchema (packages/server/src/config.ts FILE_EXTRAS). */
const FILE_EXTRAS: { key: string; type: string; def: string; env: string; desc: string }[] = [
  {
    key: "server.metricsToken",
    type: "string",
    def: "unset",
    env: "BEAMHOP_METRICS_TOKEN",
    desc: "Bearer token required to read `/metrics`. Without one, `/metrics` is only served to clients on the same machine talking to beamhop directly, and not at all when `trustProxy` is on. Use a long random value (for example `openssl rand -hex 32`); a placeholder like the one in the example file turns `/metrics` off.",
  },
  {
    key: "server.prometheus",
    type: "boolean",
    def: "`true`",
    env: "BEAMHOP_PROMETHEUS",
    desc: "Serve the Prometheus scrape endpoint at `/metrics`.",
  },
  {
    key: "plugins.enabled",
    type: "string[]",
    def: "`[]`",
    env: "BEAMHOP_PLUGINS_ENABLED",
    desc: "Plugin names switched on until someone toggles them in the admin panel. Once a plugin has been toggled there, the panel's choice wins. In the env var, separate names with commas.",
  },
];

/** BEAMHOP_* (and PORT) variables read outside the ENV table that operators may set. */
const OTHER_ENV: { name: string; desc: string }[] = [
  { name: "BEAMHOP_CONFIG", desc: "Path of the config file to read (same as `--config`). Startup fails if the file doesn't exist." },
  { name: "PORT", desc: "Listen port, for hosting platforms that set `PORT`. Ignored when `BEAMHOP_PORT` is set." },
  { name: "BEAMHOP_MEMORY_LIMIT", desc: "Memory limit in bytes that the memory alert compares against. Without it, beamhop uses the container (cgroup) limit, or else the machine's total memory." },
  { name: "BEAMHOP_SESSION_SECRET", desc: "Deprecated and ignored (see `admin.sessionSecret`)." },
];

const RUNTIME_SECTIONS: Record<string, { title: string; intro: string }> = {
  info: { title: "Relay info", intro: "What your relay says about itself in its NIP-11 document and on its public landing page." },
  access: { title: "Access", intro: "Who can read from and write to the relay." },
  limits: { title: "Limits", intro: "Message sizes, subscription limits and rate limits." },
  moderation: { title: "Moderation", intro: "Kind filters, word filters and automatic bans." },
  retention: { title: "Retention", intro: "Pruning old events and audit log entries automatically." },
  nip05: { title: "NIP-05", intro: "`name@domain` identifiers served from `/.well-known/nostr.json`." },
  groups: { title: "Groups", intro: "NIP-29 relay-based groups." },
  blossom: { title: "Blossom", intro: "Who may upload media, how much, and what kinds of files." },
};

const RUNTIME_DESC: Record<string, string> = {
  "info.name": "Relay name, shown in NIP-11 and on the landing page.",
  "info.description": "A short description of your relay.",
  "info.icon": "URL of an icon image (an `http(s)` URL, or empty).",
  "info.banner": "URL of a banner image (an `http(s)` URL, or empty).",
  "info.contact": "How to reach the operator, for example an email address.",
  "info.pubkey": "The operator's pubkey for NIP-11. It is also served as `_@domain` by NIP-05.",
  "info.termsOfService": "URL of your terms of service (an `http(s)` URL, or empty).",
  "info.postingPolicy": "URL of your posting policy (an `http(s)` URL, or empty).",
  "access.mode":
    "`public`: anyone may publish. `whitelist`: only members (users you allow in the admin panel, plus staff) may publish. `invite`: like `whitelist`, but people join by redeeming an invite code. `auth-required`: anyone may publish after NIP-42 AUTH, and only events they signed themselves (gift wraps excepted, since those are signed by throwaway keys).",
  "access.authForRead": "Clients must authenticate with NIP-42 before they can read (REQ). Also implied by `auth-required` mode.",
  "access.authForWrite": "Clients must authenticate with NIP-42 before they can publish (EVENT).",
  "access.allowInboundToMembers":
    "On `whitelist` and `invite` relays, let non-members send a member things addressed to them (notes and replies, DMs, reposts, reactions, gift wraps, comments) when the event p-tags that member. Other kinds still need membership.",
  "limits.maxMessageBytes": "Largest WebSocket message accepted, in bytes.",
  "limits.maxEventBytes": "Largest event accepted, in bytes.",
  "limits.maxSubscriptions": "Open subscriptions per connection.",
  "limits.maxFilters": "Filters in one REQ.",
  "limits.maxLimit": "Most events returned for one filter, whatever `limit` the client asks for.",
  "limits.defaultLimit": "Events returned for a filter that has no `limit`.",
  "limits.maxEventTags": "Tags in one event.",
  "limits.maxContentLength": "Characters in an event's `content`.",
  "limits.minPowDifficulty": "Minimum NIP-13 proof-of-work difficulty. `0` turns it off.",
  "limits.createdAtUpperSec": "Events dated more than this many seconds in the future are rejected.",
  "limits.createdAtLowerSec": "Events older than this many seconds are rejected. `0` turns it off.",
  "limits.eventsPerMinute": "Events one client may publish per minute. Can be raised or lowered per user in the admin panel.",
  "limits.reqPerMinute": "REQs one client may send per minute. Can be raised or lowered per user in the admin panel.",
  "limits.connectionsPerIp": "Open connections from one IP address.",
  "limits.connectionsPerIpv6Site": "Open connections from one IPv6 /48 (all its addresses together). Unset means 16 times `connectionsPerIp`; `0` means unlimited.",
  "limits.maxConnections": "Open connections across the whole relay. `0` means unlimited. Allow-listed IPs don't count.",
  "limits.maxTotalFilterWeight": "Filter values held by all open subscriptions together, relay-wide. Keeps live matching fast. `0` means unlimited.",
  "moderation.kindAllowlist": "If not empty, only these event kinds are accepted.",
  "moderation.kindBlocklist": "Event kinds that are always rejected.",
  "moderation.kindExplicitlyAllowed": "Kinds marked as allowed through NIP-86 while the allow-list is empty. Only reported back to NIP-86 clients; nothing is enforced.",
  "moderation.wordFilters": "Word and pattern filters on event content. Each entry is described in the next table.",
  "moderation.autoBanReportThreshold": "Ban a pubkey automatically after this many NIP-56 reports from different members. `0` turns it off.",
  "retention.rules": "Rules for deleting old events. Each entry is described in the table below.",
  "retention.intervalMinutes": "How often the retention rules run, in minutes.",
  "retention.auditLogDays": "Delete admin audit log entries older than this many days (checked daily). `0` keeps them forever.",
  "nip05.enabled": "Serve `/.well-known/nostr.json`, so users with a NIP-05 name get a `name@domain` identifier.",
  "nip05.domain": "The domain for identifiers. Empty means the host of `server.publicUrl`.",
  "nip05.relays": "Extra relays (`ws://` or `wss://` URLs) advertised in `nostr.json` next to this one.",
  "groups.enabled": "Turn NIP-29 relay-based groups on or off.",
  "groups.creation": "Who can create groups: `anyone`, `members` or `admins`. On a `public` relay everyone counts as a member.",
  "blossom.maxUploadBytes": "Largest file accepted, in bytes.",
  "blossom.defaultQuotaBytes": "Storage each user may use, in bytes. `0` means unlimited. Can be changed per user in the admin panel.",
  "blossom.allowedMimeTypes": "File types accepted. Wildcards like `image/*` work.",
  "blossom.uploadAccess": "Who may upload: `anyone`, `members` or `admins`. On a `public` relay everyone counts as a member.",
  "blossom.stripExif":
    "Remove EXIF/XMP metadata (such as location and camera data) from uploaded images. Off by default: the Blossom spec says servers must not modify files, and stripping changes the file's hash.",
  "blossom.thumbnails": "Generate thumbnails for uploaded images.",
  "blossom.requireApproval": "New uploads stay hidden until a moderator approves them.",
};

const RUNTIME_LABELS: Record<string, string> = {
  "info.name": "Name", "info.contact": "Contact", "info.description": "Description", "info.icon": "Icon URL", "info.banner": "Banner URL",
  "info.termsOfService": "Terms of service URL", "info.postingPolicy": "Posting policy URL",
  "access.authForRead": "Require AUTH to read", "access.authForWrite": "Require AUTH to write", "access.allowInboundToMembers": "Accept inbound events for members",
  "limits.maxMessageBytes": "Max message size", "limits.maxEventBytes": "Max event size", "limits.maxContentLength": "Max content length",
  "limits.maxEventTags": "Max tags per event", "limits.minPowDifficulty": "Min PoW difficulty", "limits.createdAtUpperSec": "Max future skew",
  "limits.createdAtLowerSec": "Max event age", "limits.maxSubscriptions": "Max subscriptions", "limits.maxFilters": "Max filters per REQ",
  "limits.maxLimit": "Max limit", "limits.defaultLimit": "Default limit", "limits.eventsPerMinute": "Events / minute", "limits.reqPerMinute": "REQs / minute",
  "limits.connectionsPerIp": "Connections per IP", "limits.maxConnections": "Max connections", "limits.maxTotalFilterWeight": "Max total filter weight",
  "moderation.kindAllowlist": "Kind allow-list", "moderation.kindBlocklist": "Kind block-list", "moderation.autoBanReportThreshold": "Auto-ban after N reports",
  "retention.intervalMinutes": "Run every", "retention.auditLogDays": "Keep audit log",
  "nip05.enabled": "Serve /.well-known/nostr.json", "nip05.domain": "Domain", "nip05.relays": "Advertised relays",
  "groups.enabled": "Enable NIP-29 groups", "groups.creation": "Who can create groups",
  "blossom.maxUploadBytes": "Max upload size", "blossom.defaultQuotaBytes": "Default quota per user", "blossom.uploadAccess": "Who can upload",
  "blossom.allowedMimeTypes": "Allowed MIME types", "blossom.stripExif": "Strip EXIF metadata", "blossom.thumbnails": "Generate thumbnails",
  "blossom.requireApproval": "Require approval",
};

const WORD_FILTER_DESC: Record<string, string> = {
  id: "Your own identifier for the filter (shown in logs and reports).",
  pattern: "The word or pattern to look for.",
  isRegex: "Treat `pattern` as a regular expression instead of plain text.",
  kinds: "Only check these event kinds. Empty means all kinds.",
  action: "`reject` refuses the event. `shadow` tells the client it was accepted but doesn't store it. `report` stores it and flags it for moderators.",
  enabled: "Turn this filter on or off.",
};

const RETENTION_RULE_DESC: Record<string, string> = {
  id: "Your own identifier for the rule.",
  enabled: "Turn this rule on or off.",
  kinds: "Event kinds the rule applies to. Leave out for all kinds.",
  maxAgeDays: "Delete events older than this many days.",
  maxPerPubkey: "Keep at most this many events per pubkey (for these kinds).",
  exemptPubkeys: "Pubkeys this rule never touches.",
};

// ---------------------------------------------------------------------------------------------------------------
// Schema walking
// ---------------------------------------------------------------------------------------------------------------

interface Leaf {
  path: string;
  node: JS;
  /** required inside an optional object (e.g. blossom.s3.bucket) */
  requiredIn?: string;
}

const typeOf = (n: JS): string[] => (Array.isArray(n.type) ? n.type : n.type ? [n.type] : []);
const isObjectGroup = (n: JS) => typeOf(n).includes("object") && !!n.properties && n.additionalProperties !== true && !isRecord(n);
const isRecord = (n: JS) => typeOf(n).includes("object") && !n.properties && !!n.additionalProperties;

function leaves(node: JS, prefix = "", requiredIn?: string): Leaf[] {
  const out: Leaf[] = [];
  for (const [k, child] of Object.entries(node.properties ?? {})) {
    const path = prefix + k;
    if (isObjectGroup(child)) {
      // an object section with no default of its own is optional as a whole; its required fields are "required in" it
      const optionalSection = child.default === undefined && !(node.required ?? []).includes(k);
      out.push(...leaves(child, `${path}.`, optionalSection ? path : requiredIn));
    } else {
      out.push({ path, node: child, requiredIn: (node.required ?? []).includes(k) ? requiredIn : undefined });
    }
  }
  return out;
}

const SAFE = 9007199254740991;
function typeLabel(n: JS): string {
  if (n.enum) return n.enum.map((v) => `\`${v}\``).join(" \\| ");
  const t = typeOf(n);
  if (t.includes("array")) return `${n.items ? typeLabel(n.items).replace(/ \\\| /g, "|") : "any"}[]`;
  if (isRecord(n)) return "object (string → string)";
  let label = t.join(" \\| ") || "any";
  const lo = n.minimum !== undefined && n.minimum > -SAFE ? n.minimum : undefined;
  const hi = n.maximum !== undefined && n.maximum < SAFE ? n.maximum : undefined;
  if (lo !== undefined && hi !== undefined) label += `, ${lo}–${hi}`;
  else if (lo !== undefined) label += `, ≥ ${lo}`;
  else if (hi !== undefined) label += `, ≤ ${hi}`;
  return label;
}

function fmt(v: unknown): string {
  if (v === undefined) return "";
  if (Array.isArray(v) && v.length > 3 && v.every((x) => typeof x === "string")) return v.map((x) => `\`${x}\``).join("<br>");
  const s = JSON.stringify(v);
  return `\`${s.replace(/\|/g, "\\|")}\``;
}

function bytesNote(path: string, v: unknown): string {
  if (typeof v !== "number" || v < 1024 * 1024 || !/bytes/i.test(path)) return "";
  const mib = v / (1024 * 1024);
  return mib >= 1024 ? ` (${mib / 1024} GiB)` : ` (${mib} MiB)`;
}

const cell = (s: string) => s.replace(/\n/g, " ").replace(/(?<!\\)\|/g, "\\|");

// ---------------------------------------------------------------------------------------------------------------
// Env vars: names from the server's ENV table, keys found by running each through envToConfig()
// ---------------------------------------------------------------------------------------------------------------

const serverSrc = readFileSync(serverConfigPath, "utf8");
const envTable = serverSrc.slice(serverSrc.indexOf("const ENV: EnvSpec[]"), serverSrc.indexOf("const OTHER_ENV"));
const envNames = [...envTable.matchAll(/\[\s*"([A-Z0-9_]+)",\s*"[a-zA-Z.]+"/g)].map((m) => m[1]);
if (envNames.length < 40) throw new Error(`only found ${envNames.length} env vars in ${serverConfigPath}: has the ENV table moved?`);

const flatten = (o: Record<string, unknown>, prefix = ""): string[] =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" && !Array.isArray(v) && !(prefix + k).endsWith("headers") ? flatten(v as Record<string, unknown>, `${prefix}${k}.`) : [prefix + k]));

const PROBES = ["1", "a=b", "0".repeat(63) + "1"];
const envByKey = new Map<string, string[]>();
for (const name of envNames) {
  let path: string | undefined;
  for (const probe of PROBES) {
    try {
      const keys = flatten(envToConfig({ [name]: probe }));
      if (keys.length === 1) {
        path = keys[0];
        break;
      }
    } catch {
      /* try the next probe value */
    }
  }
  if (!path) throw new Error(`could not work out which key ${name} sets`);
  envByKey.set(path, [...(envByKey.get(path) ?? []), name]);
}
// PORT is a fallback for BEAMHOP_PORT: listed with the env-only variables instead
envByKey.set("server.port", (envByKey.get("server.port") ?? []).filter((n) => n !== "PORT"));

// FILE_EXTRAS / OTHER_ENV must still exist in the server's code
for (const x of FILE_EXTRAS) if (!serverSrc.includes(`"${x.key}"`)) throw new Error(`${x.key} is no longer a config file extra`);
for (const x of [...FILE_EXTRAS.map((f) => f.env), ...OTHER_ENV.map((o) => o.name)]) {
  if (x === "BEAMHOP_MEMORY_LIMIT") {
    if (!readFileSync(resolve(repo, "packages/metrics/src/process.ts"), "utf8").includes(x)) throw new Error(`${x} is no longer read`);
  } else if (!serverSrc.includes(`"${x}"`) && !serverSrc.includes(`.${x}`)) throw new Error(`${x} is no longer read by the server`);
}

// ---------------------------------------------------------------------------------------------------------------
// Checks: every key described, every description a real key
// ---------------------------------------------------------------------------------------------------------------

function checkDescribed(paths: string[], desc: Record<string, string>, what: string) {
  const missing = paths.filter((p) => !desc[p]);
  const stale = Object.keys(desc).filter((p) => !paths.includes(p));
  if (missing.length || stale.length) {
    throw new Error(`${what}: ${missing.length ? `no description for ${missing.join(", ")}` : ""}${stale.length ? ` descriptions for unknown keys ${stale.join(", ")}` : ""}`);
  }
}

const configLeaves = leaves(toJson(ConfigSchema));
checkDescribed(configLeaves.map((l) => l.path), CONFIG_DESC, "ConfigSchema");
const runtimeLeaves = leaves(toJson(RuntimeSettingsSchema));
checkDescribed(runtimeLeaves.map((l) => l.path), RUNTIME_DESC, "RuntimeSettingsSchema");
const wfLeaves = leaves(toJson(WordFilterSchema));
checkDescribed(wfLeaves.map((l) => l.path), WORD_FILTER_DESC, "WordFilterSchema");
const rrLeaves = leaves(toJson(RetentionRuleSchema));
checkDescribed(rrLeaves.map((l) => l.path), RETENTION_RULE_DESC, "RetentionRuleSchema");
for (const k of envByKey.keys()) if (!CONFIG_DESC[k]) throw new Error(`env var ${envByKey.get(k)} sets ${k}, which is not in ConfigSchema`);

// ---------------------------------------------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------------------------------------------

const lines: string[] = [];
const push = (...s: string[]) => lines.push(...s);

function defaultCell(l: Leaf): string {
  if (BUILT_IN_DEFAULTS[l.path]) return BUILT_IN_DEFAULTS[l.path];
  if (l.node.default !== undefined) return fmt(l.node.default) + bytesNote(l.path, l.node.default);
  if (l.requiredIn) return `required when \`${l.requiredIn}\` is set`;
  return "unset";
}

function configTable(rows: Leaf[]) {
  push("| Key | Default | Description |", "| --- | --- | --- |");
  for (const l of rows) {
    const env = (envByKey.get(l.path) ?? []).map((e) => `\`${e}\``).join(", ");
    const key = `\`${l.path}\`<br>${typeLabel(l.node)}${env ? `<br>env: ${env}` : ""}`;
    push(`| ${cell(key)} | ${cell(defaultCell(l))} | ${cell(CONFIG_DESC[l.path])} |`);
  }
  push("");
}

push(
  "---",
  "title: Configuration reference",
  "description: Every beamhop config key, environment variable and admin-panel setting, with its type, default and what it does.",
  "sidebar:",
  "  order: 2",
  "---",
  "",
  "<!-- Generated by site/scripts/gen-config-ref.ts from packages/sdk/src/config.ts and packages/server/src/config.ts. Don't edit by hand: run `bun run gen:config` in site/. -->",
  "",
  "This page lists every setting beamhop knows about. It is generated from the code, so it always matches the version it was built from. For how the pieces fit together, start with the [configuration overview](/relay/config/overview/).",
  "",
  "There are two kinds of settings:",
  "",
  "- **[Startup config](#startup-config)** comes from `beamhop.config.json`, `BEAMHOP_*` environment variables and command-line flags. It is read once at startup, so changes need a restart.",
  "- **[Admin-panel settings](#admin-panel-settings)** live in the database and are changed in the admin panel (Settings). They apply right away, no restart needed.",
  "",
  "## Startup config",
  "",
  "Keys are written as dotted paths: `server.port` means `{ \"server\": { \"port\": … } }` in the config file. When a key has an environment variable, it is shown under the key; the variable wins over the file.",
  "",
  "How environment variables are read:",
  "",
  "- **true/false**: `1`, `true`, `yes` or `on` (any case) mean true; anything else means false.",
  "- **Lists**: comma-separated, for example `BEAMHOP_OWNERS=npub1…,npub1…`.",
  "- **Numbers**: must be a number; a non-numeric value stops startup with an error.",
  "- **Empty values** count as not set, so `BEAMHOP_X=` in a compose file falls back to the file or the default.",
  "",
);

const topOrder = ["server", "database", "relaySecretKey", "blossom", "metrics", "admin", "plugins", "logLevel"];
const groupOf = (p: string) => (p === "logFormat" ? "logLevel" : p.split(".")[0]);
for (const g of [...new Set(configLeaves.map((l) => groupOf(l.path)))]) if (!topOrder.includes(g)) throw new Error(`no section for ${g}`);
for (const g of topOrder) {
  const rows = configLeaves.filter((l) => groupOf(l.path) === g);
  if (!rows.length) continue;
  const s = SECTIONS[g];
  push(`### ${s.title}`, "", s.intro, "");
  if (g === "blossom") {
    // split the long blossom group: storage, S3, limits
    const storage = rows.filter((r) => !r.path.startsWith("blossom.s3.") && !r.path.startsWith("blossom.limits."));
    const s3 = rows.filter((r) => r.path.startsWith("blossom.s3."));
    const limits = rows.filter((r) => r.path.startsWith("blossom.limits."));
    configTable(storage);
    push("#### blossom.s3", "", "Only needed when `blossom.driver` is `s3`. Leave the whole `s3` object out otherwise.", "");
    configTable(s3);
    push("#### blossom.limits", "", "Abuse limits for uploads and mirrors. Every field is optional; an unset field keeps the built-in value shown here.", "");
    configTable(limits);
  } else if (g === "admin") {
    configTable(rows.filter((r) => !r.path.startsWith("admin.vapid.")));
    push("#### admin.vapid", "", "Optional. Give all three to use your own Web Push keys, or leave `vapid` out and beamhop makes a pair for you.", "");
    configTable(rows.filter((r) => r.path.startsWith("admin.vapid.")));
  } else {
    configTable(rows);
  }
}

push(
  "### Other config file keys",
  "",
  "These are read from the config file too, but handled outside the main schema.",
  "",
  "| Key | Default | Description |",
  "| --- | --- | --- |",
  ...FILE_EXTRAS.map((x) => `| ${cell(`\`${x.key}\`<br>${x.type}<br>env: \`${x.env}\``)} | ${cell(x.def)} | ${cell(x.desc)} |`),
  "",
  "### Environment-only variables",
  "",
  "| Variable | Description |",
  "| --- | --- |",
  ...OTHER_ENV.map((o) => `| \`${o.name}\` | ${cell(o.desc)} |`),
  "",
  "### Command-line flags",
  "",
  "`beamhop` accepts a few flags that override both the file and the environment:",
  "",
  "| Flag | Sets |",
  "| --- | --- |",
);

// flags: parsed from the CLI's own help text, so they can't drift either
const cliSrc = readFileSync(resolve(repo, "packages/server/src/cli.ts"), "utf8");
const optionsBlock = cliSrc.slice(cliSrc.indexOf("Options:"), cliSrc.indexOf("-v, --version"));
const FLAG_KEYS: Record<string, string> = {
  "--config": "which config file to read (`BEAMHOP_CONFIG`)",
  "--port": "`server.port`",
  "--host": "`server.host`",
  "--public-url": "`server.publicUrl`",
  "--db": "`database.driver`",
  "--sqlite-path": "`database.sqlitePath`",
  "--database-url": "`database.postgresUrl`",
  "--plugins-dir": "`plugins.dir`",
  "--owner": "adds to `admin.owners` (repeatable)",
  "--log-level": "`logLevel`",
  "--trust-proxy": "`server.trustProxy` = true",
  "--runtime": "force the `bun` or `node` HTTP adapter (default: the runtime beamhop runs on)",
};
const flags = [...optionsBlock.matchAll(/^\s+(?:(-\w), )?(--[a-z-]+)( <[^>]+>)?/gm)];
for (const [, short, long, arg] of flags) {
  if (!FLAG_KEYS[long]) throw new Error(`no description for CLI flag ${long}`);
  push(`| ${cell(`\`${short ? `${short}, ` : ""}${long}${arg ?? ""}\``)} | ${cell(FLAG_KEYS[long])} |`);
}
for (const k of Object.keys(FLAG_KEYS)) if (!flags.some((f) => f[2] === k)) throw new Error(`CLI flag ${k} no longer exists`);
push("");

push(
  "## Admin-panel settings",
  "",
  "These live in the database and are edited in the admin panel under **Settings**. Changes apply immediately, without a restart. They can't be set from the config file or environment variables; a fresh relay starts with the defaults below.",
  "",
  "If a stored setting ever turns out to be invalid (for example after an upgrade renames something), beamhop drops just that field and raises an alert. Invalid access settings are not reset to `public`: they lock down instead (`whitelist` with AUTH required), so a relay never opens up by accident.",
  "",
);

const runtimeGroups = [...new Set(runtimeLeaves.map((l) => l.path.split(".")[0]))];
for (const g of runtimeGroups) {
  const s = RUNTIME_SECTIONS[g];
  if (!s) throw new Error(`no section text for runtime settings group ${g}`);
  push(`### ${s.title}`, "", s.intro, "", "| Setting | Default | Description |", "| --- | --- | --- |");
  for (const l of runtimeLeaves.filter((r) => r.path.startsWith(`${g}.`))) {
    const label = RUNTIME_LABELS[l.path];
    const type = l.path === "moderation.wordFilters" || l.path === "retention.rules" ? "object[]" : typeLabel(l.node);
    const key = `\`${l.path}\`<br>${type}${label ? `<br>panel: “${label}”` : ""}`;
    push(`| ${cell(key)} | ${cell(defaultCell(l))} | ${cell(RUNTIME_DESC[l.path])} |`);
  }
  push("");
  const sub = g === "moderation" ? { title: "Word filter fields", rows: wfLeaves, desc: WORD_FILTER_DESC } : g === "retention" ? { title: "Retention rule fields", rows: rrLeaves, desc: RETENTION_RULE_DESC } : undefined;
  if (sub) {
    push(`#### ${sub.title}`, "", "| Field | Default | Description |", "| --- | --- | --- |");
    for (const l of sub.rows) push(`| ${cell(`\`${l.path}\`<br>${typeLabel(l.node)}`)} | ${cell(l.node.default !== undefined ? fmt(l.node.default) : (toJson(g === "moderation" ? WordFilterSchema : RetentionRuleSchema).required ?? []).includes(l.path) ? "required" : "unset")} | ${cell(sub.desc[l.path])} |`);
    push("");
  }
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, lines.join("\n"));
console.log(`wrote ${outPath} (${configLeaves.length} config keys, ${envNames.length} env vars, ${runtimeLeaves.length} admin-panel settings)`);
