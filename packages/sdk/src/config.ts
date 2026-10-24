import { z } from "zod";

/** Static, boot-time configuration (file `beamhop.config.json` + env BEAMHOP_*). Restart required to change. */
export const ConfigSchema = z.object({
  server: z
    .object({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().default(3334),
      /** public base URL e.g. https://relay.example.com — used for NIP-42 relay tag, NIP-98, Blossom URLs */
      publicUrl: z.string().default("http://localhost:3334"),
      /** trust X-Forwarded-For / X-Real-IP */
      trustProxy: z.boolean().default(false),
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
      /** HMAC secret for sessions; generated + persisted to KV if absent */
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
      /** npm package names to load in addition to auto-discovered beamhop-plugin-NAME and @scope/beamhop-plugin-NAME */
      packages: z.array(z.string()).default([]),
    })
    .prefault({}),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});
export type BeamhopConfig = z.infer<typeof ConfigSchema>;

export const AccessModeSchema = z.enum(["public", "whitelist", "invite", "auth-required"]);
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

/**
 * Runtime settings — stored in KV (namespace "settings", key "runtime"), editable live from admin panel.
 * Every package reads these through `SettingsService`.
 */
export const RuntimeSettingsSchema = z.object({
  info: z
    .object({
      name: z.string().default("beamhop relay"),
      description: z.string().default("A beamhop nostr relay"),
      icon: z.string().default(""),
      banner: z.string().default(""),
      contact: z.string().default(""),
      /** operator pubkey for NIP-11 */
      pubkey: z.string().default(""),
      termsOfService: z.string().default(""),
      postingPolicy: z.string().default(""),
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
