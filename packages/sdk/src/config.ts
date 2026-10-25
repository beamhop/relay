import { z } from "zod";

/** Loopback and private networks: a reverse proxy on the same host, a container network or a LAN. */
export const DEFAULT_TRUSTED_PROXIES = ["127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"] as const;

/** Static, boot-time configuration (file `beamhop.config.json` + env BEAMHOP_*). Restart required to change. */
export const ConfigSchema = z.object({
  server: z
    .object({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().default(3334),
      /** public base URL e.g. https://relay.example.com — used for NIP-42 relay tag, NIP-98, Blossom URLs */
      publicUrl: z.string().default("http://localhost:3334"),
      /** trust the reverse proxy's client-IP header (see proxyIpHeader) */
      trustProxy: z.boolean().default(false),
      /**
       * header the trusted proxy puts the client IP in: "x-forwarded-for" (rightmost entry; default) or a
       * single-address header the proxy *sets* such as "x-real-ip" / "cf-connecting-ip"
       */
      proxyIpHeader: z.string().default("x-forwarded-for"),
      /**
       * peers (addresses or CIDR ranges) whose client-IP header is believed when trustProxy is on; anyone else
       * is identified by their own socket address, so a client that reaches the port directly can't spoof it
       */
      trustedProxies: z.array(z.string()).default([...DEFAULT_TRUSTED_PROXIES]),
      /**
       * graceful shutdown budget (ms): in-flight requests and queued EVENTs get up to half of it (at most 5 s), then
       * services close in order; the process is forced out when it runs out
       */
      shutdownTimeoutMs: z.number().int().min(1_000).max(600_000).default(10_000),
      /**
       * worker threads verifying EVENT signatures off the event loop (0: on the main thread, the default). Spreads
       * verification over cores when many connections publish at once (above ~5k events/s on one core). Each EVENT
       * then waits a round trip to a worker, so a connection sending over 100 EVENTs in one go reaches the
       * awaiting-OK limit sooner.
       */
      verifyWorkers: z.number().int().min(0).max(64).default(0),
    })
    .prefault({}),
  database: z
    .object({
      driver: z.enum(["sqlite", "postgres"]).default("sqlite"),
      sqlitePath: z.string().default("./data/beamhop.db"),
      postgresUrl: z.string().optional(),
    })
    .prefault({}),
  /** hex secret key of the relay itself (NIP-29 group metadata signing, NIP-11 `self`). Generated + persisted to KV if absent. */
  relaySecretKey: z.string().optional(),
  blossom: z
    .object({
      enabled: z.boolean().default(true),
      driver: z.enum(["fs", "s3"]).default("fs"),
      fsPath: z.string().default("./data/blobs"),
      s3: z
        .object({
          endpoint: z.string(),
          region: z.string().default("auto"),
          bucket: z.string(),
          accessKeyId: z.string(),
          secretAccessKey: z.string(),
          /** optional public base URL to redirect GETs to */
          publicUrl: z.string().optional(),
        })
        .optional(),
      /** upload/mirror abuse limits; unset fields keep the built-in defaults (see the blossom README) */
      limits: z
        .object({
          /** PUT /upload + PUT /mirror per minute per client IP (IPv6: /64); 0 = unlimited (default 60) */
          uploadsPerMinutePerIp: z.number().int().min(0).optional(),
          /** PUT /upload + PUT /mirror per minute per pubkey; 0 = unlimited (default 60) */
          uploadsPerMinutePerPubkey: z.number().int().min(0).optional(),
          /** ingests (sniffing, stripping, thumbnails, storing) running at once (default 8) */
          maxConcurrentUploads: z.number().int().min(1).optional(),
          /** received bodies waiting for an ingest slot before 503 (default 32) */
          maxQueuedUploads: z.number().int().min(0).optional(),
          /** upload/mirror bodies held in memory at once, bytes (default 256 MiB; never below 2 × maxUploadBytes) */
          maxBufferedUploadBytes: z.number().int().min(1).optional(),
          /** bodies being received at once per client IP (IPv6: /64); 0 = unlimited (default 4) */
          maxConcurrentUploadsPerIp: z.number().int().min(0).optional(),
          /** abort an upload body that sends nothing for this long, ms (default 15000) */
          uploadStallMs: z.number().int().min(1000).optional(),
          /** after the first 30 s, abort bodies averaging below this many bytes/s; 0 = off (default 4096) */
          minUploadBytesPerSec: z.number().int().min(0).optional(),
          /** destination ports BUD-04 mirroring may connect to (default [80, 443]) */
          mirrorPorts: z.array(z.number().int().min(1).max(65535)).optional(),
          /** whole BUD-04 mirror transfer (connect, redirects, body), ms (default 30000) */
          mirrorTimeoutMs: z.number().int().min(1000).optional(),
        })
        .optional(),
    })
    .prefault({}),
  metrics: z
    .object({
      otel: z
        .object({
          enabled: z.boolean().default(false),
          endpoint: z.string().default("http://localhost:4318/v1/metrics"),
          headers: z.record(z.string(), z.string()).default({}),
          intervalMs: z.number().default(15000),
        })
        .prefault({}),
      /** path to a GeoLite2-City / DB-IP city-lite .mmdb file; geo stats disabled if absent */
      geoipDbPath: z.string().optional(),
      /** retention of rolled-up metrics in days */
      retentionDays: z.number().default(30),
    })
    .prefault({}),
  admin: z
    .object({
      enabled: z.boolean().default(true),
      /** pubkeys (hex) that are always `owner` */
      owners: z.array(z.string()).default([]),
      /** @deprecated unused (admin sessions are random server-side ids); still accepted so old configs load */
      sessionSecret: z.string().optional(),
      /** directory of the built admin-ui (defaults to packages/admin-ui/dist or embedded) */
      uiDir: z.string().optional(),
      vapid: z.object({ publicKey: z.string(), privateKey: z.string(), subject: z.string() }).optional(),
    })
    .prefault({}),
  plugins: z
    .object({
      /** local folder of plugins (each a folder with package.json / index.ts) */
      dir: z.string().default("./plugins"),
      /** npm package names (or paths) to load */
      packages: z.array(z.string()).default([]),
      /**
       * also load every beamhop-plugin-NAME / @scope/beamhop-plugin-NAME package found in node_modules. Off by default:
       * discovered modules are imported (their top-level code runs) at boot, so a transitive dependency or typosquat
       * with such a name would run inside the relay
       */
      autoDiscoverNpm: z.boolean().default(false),
    })
    .prefault({}),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});
export type BeamhopConfig = z.infer<typeof ConfigSchema>;

export const AccessModeSchema = z.enum(["public", "whitelist", "invite", "auth-required"]);
/** Part of the plugin SDK contract (unused inside beamhop itself). */
export type AccessMode = z.infer<typeof AccessModeSchema>;

export const RetentionRuleSchema = z.object({
  id: z.string(),
  enabled: z.boolean().default(true),
  kinds: z.array(z.number()).optional(),
  /** delete events older than N days */
  maxAgeDays: z.number().optional(),
  /** keep at most N events per pubkey for these kinds */
  maxPerPubkey: z.number().optional(),
  /** pubkeys exempt from this rule */
  exemptPubkeys: z.array(z.string()).default([]),
});
export type RetentionRule = z.infer<typeof RetentionRuleSchema>;

export const WordFilterSchema = z.object({
  id: z.string(),
  pattern: z.string(),
  isRegex: z.boolean().default(false),
  /** apply to these kinds only (empty = all) */
  kinds: z.array(z.number()).default([]),
  action: z.enum(["reject", "shadow", "report"]).default("reject"),
  enabled: z.boolean().default(true),
});
export type WordFilter = z.infer<typeof WordFilterSchema>;

/** "" or an absolute http(s) URL — these render as links/images on the public landing page and in NIP-11. */
const HttpUrlOrEmpty = z
  .string()
  .refine((v) => {
    if (v === "") return true;
    try {
      const u = new URL(v);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL")
  .default("");

/**
 * Runtime settings — stored in KV (namespace "settings", key "runtime"), editable live from admin panel.
 * Every package reads these through `SettingsService`.
 */
export const RuntimeSettingsSchema = z.object({
  info: z
    .object({
      name: z.string().default("beamhop relay"),
      description: z.string().default("A beamhop nostr relay"),
      icon: HttpUrlOrEmpty,
      banner: HttpUrlOrEmpty,
      contact: z.string().default(""),
      /** operator pubkey for NIP-11 */
      pubkey: z.string().default(""),
      termsOfService: HttpUrlOrEmpty,
      postingPolicy: HttpUrlOrEmpty,
    })
    .prefault({}),
  access: z
    .object({
      mode: AccessModeSchema.default("public"),
      /** require NIP-42 AUTH before REQ */
      authForRead: z.boolean().default(false),
      /** require NIP-42 AUTH before EVENT */
      authForWrite: z.boolean().default(false),
      /** allow events authored by non-members if they p-tag a member (inbox behaviour) */
      allowInboundToMembers: z.boolean().default(true),
    })
    .prefault({}),
  limits: z
    .object({
      maxMessageBytes: z.number().int().min(1).default(131072),
      maxEventBytes: z.number().int().min(1).default(65536),
      maxSubscriptions: z.number().int().min(1).default(30),
      maxFilters: z.number().int().min(1).default(10),
      maxLimit: z.number().int().min(1).default(500),
      defaultLimit: z.number().int().min(1).default(100),
      maxEventTags: z.number().int().min(0).default(2000),
      maxContentLength: z.number().int().min(0).default(65536),
      minPowDifficulty: z.number().int().min(0).max(256).default(0),
      /** reject events with created_at more than N seconds in the future */
      createdAtUpperSec: z.number().int().min(0).default(900),
      /** reject events older than N seconds (0 = disabled) */
      createdAtLowerSec: z.number().int().min(0).default(0),
      eventsPerMinute: z.number().int().min(0).default(120),
      reqPerMinute: z.number().int().min(0).default(240),
      connectionsPerIp: z.number().int().min(0).default(20),
      /** open connections from one IPv6 /48 (a site), all its addresses together; unset = 16 × connectionsPerIp, 0 = unlimited */
      connectionsPerIpv6Site: z.number().int().min(0).optional(),
      /** open connections relay-wide (0 = unlimited); allow-listed IPs are exempt */
      maxConnections: z.number().int().min(0).default(0),
      /** filter values held by all open subscriptions together (live fan-out index), relay-wide; 0 = unlimited */
      maxTotalFilterWeight: z.number().int().min(0).default(5_000_000),
    })
    .prefault({}),
  moderation: z
    .object({
      /** if non-empty, only these kinds accepted */
      kindAllowlist: z.array(z.number()).default([]),
      kindBlocklist: z.array(z.number()).default([]),
      wordFilters: z.array(WordFilterSchema).default([]),
      /** auto-ban pubkey after N reports (NIP-56) from distinct members (0 = off) */
      autoBanReportThreshold: z.number().default(0),
    })
    .prefault({}),
  retention: z
    .object({
      rules: z.array(RetentionRuleSchema).default([]),
      /** how often retention job runs (minutes) */
      intervalMinutes: z.number().default(60),
      /** delete admin audit log entries older than N days (checked daily); 0 = keep forever */
      auditLogDays: z.number().int().min(0).default(0),
    })
    .prefault({}),
  nip05: z
    .object({
      enabled: z.boolean().default(true),
      /** domain served; defaults to host of publicUrl */
      domain: z.string().default(""),
      /** extra relays advertised in nostr.json */
      relays: z.array(z.string()).default([]),
    })
    .prefault({}),
  groups: z
    .object({
      /** NIP-29 */
      enabled: z.boolean().default(true),
      /** who can create groups */
      creation: z.enum(["anyone", "members", "admins"]).default("members"),
    })
    .prefault({}),
  blossom: z
    .object({
      maxUploadBytes: z.number().default(100 * 1024 * 1024),
      /** default per-user quota in bytes (0 = unlimited) */
      defaultQuotaBytes: z.number().default(1024 * 1024 * 1024),
      allowedMimeTypes: z.array(z.string()).default(["image/*", "video/*", "audio/*", "application/pdf"]),
      /** who may upload */
      uploadAccess: z.enum(["anyone", "members", "admins"]).default("members"),
      /**
       * strip EXIF/XMP metadata from uploaded images. Off by default: BUD-02 says servers MUST NOT modify blobs, and
       * stripping changes the stored hash (the descriptor's `ox` tag carries the original).
       */
      stripExif: z.boolean().default(false),
      thumbnails: z.boolean().default(true),
      /** require admin approval before blobs are publicly served */
      requireApproval: z.boolean().default(false),
    })
    .prefault({}),
});
export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>;

/** Deep partial patch type for settings updates. */
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] };

export interface SettingsService {
  get(): RuntimeSettings;
  update(patch: DeepPartial<RuntimeSettings>, actor: string): Promise<RuntimeSettings>;
  onChange(fn: (s: RuntimeSettings) => void): () => void;
}
