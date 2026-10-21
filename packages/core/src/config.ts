// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Canonical configuration schema. Single source of truth for validation,
 * generated UI forms, in-app ⓘ help (`describe()` texts), docs and JSON Schema.
 *
 * Conventions:
 * - Every field has `.describe()` in plain language (shown in simple view).
 * - Technical detail goes in `meta.technical` via `technical()` (shown in the technical lens).
 * - Module sections (e.g. `enterprise`) are NOT declared here; they live under
 *   `modules.<id>` and are validated by the module's own schema (isolation rule §12.0).
 */
import { z } from 'zod';

const technicalNotes = new WeakMap<object, string>();

/** Attach a technical-lens note (NIP numbers, kinds, raw semantics) to a schema node. */
export function technical<T extends z.ZodType>(schema: T, note: string): T {
  technicalNotes.set(schema, note);
  // Also key by the schema definition: zod clones (e.g. `.describe()`) share `_zod.def`,
  // so the note survives `technical(x, n).describe(...)`.
  technicalNotes.set(schema._zod.def, note);
  return schema;
}

export function technicalNote(schema: z.ZodType): string | undefined {
  return technicalNotes.get(schema) ?? technicalNotes.get(schema._zod.def);
}

const slider = (d: string) => z.number().int().min(0).max(100).describe(d);

/** Goals (§6.7). 0..100 sliders; the goals engine derives concrete limits. */
export const GoalsSchema = z
  .object({
    openness: slider('How open the relay is: 0 = very strict, 100 = anyone can post').default(70),
    spamTolerance: slider('0 = aggressive spam blocking, 100 = relaxed').default(40),
    storage: slider('0 = keep it lean (short retention), 100 = keep everything').default(60),
    media: slider('0 = basic media, 100 = rich media (resizing, video)').default(50),
    speedVsCost: slider('0 = cheapest to run, 100 = fastest').default(50),
  })
  .describe('Simple goals. Beamhop turns these into the exact settings for you.');
export type Goals = z.infer<typeof GoalsSchema>;

export const PersonaSchema = z
  .enum(['public-social', 'private-team', 'wot-community', 'media-host', 'organization'])
  .describe('What kind of relay this is. Sets sensible goals and defaults.');
export type Persona = z.infer<typeof PersonaSchema>;

export const AccessSchema = z
  .object({
    mode: technical(
      z.enum(['open', 'allowlist', 'wot']).default('open'),
      'open: any pubkey; allowlist: explicit pubkeys/invites; wot: follow graph of owner (kind 3) to N hops.',
    ).describe('Who can post'),
    authRequired: technical(
      z
        .object({
          read: z.boolean().default(false).describe('People must sign in to read'),
          write: z.boolean().default(false).describe('People must sign in to post'),
        })
        .prefault({}),
      'NIP-42 AUTH required for REQ (read) and/or EVENT (write).',
    ),
    wot: z
      .object({
        depth: z
          .number()
          .int()
          .min(1)
          .max(3)
          .default(2)
          .describe('How many follow hops count as trusted'),
        minFollowers: z
          .number()
          .int()
          .min(0)
          .default(1)
          .describe('Minimum trusted followers to be let in'),
        seeds: z
          .array(z.string())
          .default([])
          .describe('Extra trusted people (pubkeys) besides the owner'),
        refreshMinutes: z.number().int().min(5).default(360),
      })
      .prefault({}),
  })
  .prefault({});

export const TierSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().describe('Shown to admins and users, e.g. "Plus"'),
  eventsPerMinute: z.number().int().positive().optional(),
  maxEventBytes: z.number().int().positive().optional(),
  allowedKinds: z.array(z.number().int()).optional(),
  blobQuotaBytes: z.number().int().nonnegative().optional(),
  maxBlobBytes: z.number().int().positive().optional(),
  retentionDays: z.number().int().positive().optional(),
});
export type Tier = z.infer<typeof TierSchema>;

/** Advanced overrides; anything set here wins over goals-derived values and is shown as "overridden". */
export const LimitsOverrideSchema = z
  .object({
    maxEventBytes: z.number().int().positive(),
    maxSubscriptions: z.number().int().positive(),
    maxFilters: z.number().int().positive(),
    maxLimit: z.number().int().positive(),
    eventsPerMinute: z.number().int().positive(),
    reqPerMinute: z.number().int().positive(),
    minPowDifficulty: technical(z.number().int().min(0).max(40), 'NIP-13 leading zero bits'),
    newKeyPowDifficulty: z.number().int().min(0).max(40),
    maxCreatedAtFutureSeconds: z.number().int().nonnegative(),
    maxCreatedAtPastSeconds: z.number().int().nonnegative(),
    allowedKinds: z.array(z.number().int()),
    blockedKinds: z.array(z.number().int()),
  })
  .partial()
  .prefault({});
export type LimitsOverride = z.infer<typeof LimitsOverrideSchema>;

export const RetentionRuleSchema = z.object({
  kinds: z.array(z.number().int()).optional(),
  days: z.number().int().positive(),
});

export const BlossomSchema = z
  .object({
    enabled: z.boolean().default(true).describe('Host media (images, video, files) for your users'),
    maxBlobBytes: z.number().int().positive().optional(),
    defaultQuotaBytes: z.number().int().nonnegative().optional(),
    allowedTypes: z.array(z.string()).optional().describe('Allowed file types, e.g. image/*'),
    requireAuth: technical(z.boolean().default(true), 'BUD-02 kind 24242 auth required for upload'),
    mirror: z.boolean().default(true).describe('Allow copying files from other media servers'),
    optimize: z
      .object({
        stripMetadata: z
          .boolean()
          .default(true)
          .describe('Remove location/camera info from photos'),
        thumbnails: z.boolean().default(true),
        resize: z.boolean().default(true),
        transcode: z.boolean().default(false),
      })
      .prefault({}),
    scanning: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .describe('Check uploads against known-abuse image lists'),
        lists: z.array(z.string()).default([]),
      })
      .prefault({}),
  })
  .prefault({});

export const RelayInfoSchema = z
  .object({
    name: z.string().default('Beamhop Relay'),
    description: z.string().default(''),
    icon: z.string().url().optional(),
    banner: z.string().url().optional(),
    contact: z.string().optional(),
    pubkey: z.string().optional().describe("Owner's public key"),
    rules: z.string().optional().describe('Community rules, shown on your landing page'),
  })
  .prefault({});

export const PublicPagesSchema = z
  .object({
    landing: z.boolean().default(true),
    portal: z.boolean().default(true),
    status: z.boolean().default(true),
  })
  .prefault({});

export const RelaySchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .describe('Internal id of this virtual relay'),
  hosts: z.array(z.string()).min(1).describe('Domain names this relay answers on'),
  pathPrefix: z.string().optional(),
  persona: PersonaSchema.default('public-social'),
  goals: GoalsSchema.prefault({}),
  info: RelayInfoSchema,
  access: AccessSchema,
  tiers: z.array(TierSchema).default([{ id: 'default', name: 'Default' }]),
  defaultTier: z.string().default('default'),
  limits: LimitsOverrideSchema,
  retention: z.array(RetentionRuleSchema).default([]),
  blossom: BlossomSchema,
  public: PublicPagesSchema,
});
export type RelayConfig = z.infer<typeof RelaySchema>;

export const StorageSchema = z
  .object({
    driver: z.enum(['sqlite', 'postgres', 'd1', 'memory']).default('sqlite'),
    url: z.string().optional().describe('Database file path or connection URL'),
  })
  .prefault({});

export const BlobStorageSchema = z
  .object({
    driver: z.enum(['fs', 's3', 'r2', 'gcs', 'memory']).default('fs'),
    path: z.string().optional(),
    bucket: z.string().optional(),
    endpoint: z.string().optional(),
    region: z.string().optional(),
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
  })
  .prefault({});

export const NodeSchema = z
  .object({
    id: z.string().default('local'),
    listen: z.string().default('0.0.0.0:3334'),
    dataDir: z.string().default('./data'),
    tls: z
      .object({
        mode: z.enum(['auto', 'acme', 'proxy', 'off']).default('auto'),
        email: z.string().email().optional(),
      })
      .prefault({}),
    trustProxy: z.boolean().default(false),
    countryHeader: technical(
      z.string().optional(),
      'Header set by the trusted reverse proxy with the ISO 3166 country of the client (e.g. cf-ipcountry). Read only when trustProxy is on; never derived from IPs.',
    ),
  })
  .prefault({});

export const AlertChannelSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('webpush'), id: z.string() }),
  z.object({ type: z.literal('nostr-dm'), id: z.string(), pubkey: z.string() }),
  z.object({
    type: z.literal('telegram'),
    id: z.string(),
    botToken: z.string(),
    chatId: z.string(),
  }),
  z.object({ type: z.literal('discord'), id: z.string(), webhookUrl: z.string().url() }),
  z.object({ type: z.literal('slack'), id: z.string(), webhookUrl: z.string().url() }),
  z.object({
    type: z.literal('email'),
    id: z.string(),
    to: z.string().email(),
    smtpUrl: z.string(),
  }),
]);

export const AlertsSchema = z
  .object({
    channels: z.array(AlertChannelSchema).default([]),
    digest: z.enum(['off', 'daily', 'weekly']).default('daily'),
  })
  .prefault({});

export const AiSchema = z
  .object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().url().optional().describe('OpenAI-compatible endpoint, e.g. Ollama'),
    model: z.string().optional(),
    apiKey: z.string().optional(),
  })
  .prefault({});

export const BackupSchema = z
  .object({
    enabled: z.boolean().default(false),
    schedule: z.enum(['hourly', 'daily', 'weekly']).default('daily'),
    target: BlobStorageSchema.optional(),
    keep: z.number().int().positive().default(14),
  })
  .prefault({});

export const PrivacySchema = z
  .object({
    ipLogging: z.enum(['hashed', 'truncated', 'off']).default('hashed'),
  })
  .prefault({});

export const ConfigSchema = z.object({
  version: z.literal(1).default(1),
  node: NodeSchema,
  storage: StorageSchema,
  blobStorage: BlobStorageSchema,
  relays: z.array(RelaySchema).default([]),
  alerts: AlertsSchema,
  ai: AiSchema,
  backups: BackupSchema,
  privacy: PrivacySchema,
  plugins: z
    .array(z.object({ id: z.string(), enabled: z.boolean().default(true), config: z.unknown() }))
    .default([]),
  /** Module sections keyed by module id. Absent unless the module is enabled. */
  modules: z.record(z.string(), z.unknown()).prefault({}),
});
export type BeamhopConfig = z.infer<typeof ConfigSchema>;

export function parseConfig(input: unknown): BeamhopConfig {
  return ConfigSchema.parse(input ?? {});
}

/** Effective, fully-resolved limits for a relay after goals + tier + overrides. */
export interface EffectiveLimits {
  maxEventBytes: number;
  maxSubscriptions: number;
  maxFilters: number;
  maxLimit: number;
  eventsPerMinute: number;
  reqPerMinute: number;
  minPowDifficulty: number;
  newKeyPowDifficulty: number;
  maxCreatedAtFutureSeconds: number;
  maxCreatedAtPastSeconds: number;
  allowedKinds?: number[];
  blockedKinds: number[];
  spamThreshold: number;
  defaultRetentionDays?: number;
  maxBlobBytes: number;
  defaultBlobQuotaBytes: number;
  /** Which fields came from an override (shown as "overridden" in the UI). */
  overridden: Array<keyof LimitsOverride>;
}
