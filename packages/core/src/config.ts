// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Canonical configuration schema. Single source of truth for validation,
 * generated UI forms, in-app ⓘ help (`describe()` texts), docs and JSON Schema.
 *
 * Conventions:
 * - Every field has `.describe()` in plain language (shown in simple view): what it does and
 *   when you would change it, 1–2 sentences, no jargon.
 * - Technical detail goes in `technical()` (shown in the technical lens).
 * - Enums get `labels()` for every value; conditional fields get `showWhen()`; URLs/hosts get
 *   `example()`; fields with a sensible choice get `recommend()`.
 * - Module sections (e.g. `enterprise`) are NOT declared here; they live under
 *   `modules.<id>` and are validated by the module's own schema (isolation rule §12.0).
 *
 * Form/help metadata is published by admin-api's `/config/schema` (JSON Schema) as
 * extension keywords on the node the helper was applied to:
 *
 *   x-technical    string                              technical-lens note        technical()
 *   x-enumLabels   { [value: string]: string }         plain label per enum value labels()
 *   x-showWhen     { path: string, equals: unknown[] } show only when the sibling showWhen()
 *                  at `path` (dot path relative to the object that contains this field) equals
 *                  one of `equals` (always an array in JSON, even if a single value was given)
 *   x-example      unknown                             example value (placeholder) example()
 *   x-recommended  { value: unknown, why: string }     suggested value + reason   recommend()
 *
 * All helpers return the schema they were given, so they compose with `.describe()`,
 * `.default()` etc. in any order (metadata is also keyed by the zod definition, which zod
 * clones share).
 */
import { z } from 'zod';

/** Form/help metadata attached to a schema node (see the table above). */
export interface FieldHelp {
  technical?: string;
  enumLabels?: Record<string, string>;
  showWhen?: { path: string; equals: unknown[] };
  example?: unknown;
  recommended?: { value: unknown; why: string };
}

/** The JSON Schema extension keyword for each `FieldHelp` entry (consumed by the PWA). */
export const FIELD_HELP_KEYWORDS = {
  technical: 'x-technical',
  enumLabels: 'x-enumLabels',
  showWhen: 'x-showWhen',
  example: 'x-example',
  recommended: 'x-recommended',
} as const satisfies Record<keyof FieldHelp, string>;

const helpStore = new WeakMap<object, FieldHelp>();

function setHelp<T extends z.ZodType>(schema: T, patch: FieldHelp): T {
  // Keyed by the schema and by its definition: zod clones (e.g. `.describe()`) share
  // `_zod.def`, so the metadata survives `helper(x, …).describe(...)`.
  for (const key of [schema, schema._zod.def] as object[]) {
    helpStore.set(key, { ...helpStore.get(key), ...patch });
  }
  return schema;
}

/** All form/help metadata of a schema node (empty object when none). */
export function fieldHelp(schema: z.ZodType): FieldHelp {
  return { ...helpStore.get(schema._zod.def), ...helpStore.get(schema) };
}

/** Attach a technical-lens note (NIP numbers, kinds, raw semantics) to a schema node. */
export function technical<T extends z.ZodType>(schema: T, note: string): T {
  return setHelp(schema, { technical: note });
}

export function technicalNote(schema: z.ZodType): string | undefined {
  return fieldHelp(schema).technical;
}

/** Plain-language label for every value of an enum (e.g. `fs` → "This server's disk"). */
export function labels<T extends z.ZodType>(schema: T, enumLabels: Record<string, string>): T {
  return setHelp(schema, { enumLabels });
}

/**
 * Show this field only when the sibling at `path` (dot path relative to the containing
 * object) equals `equals` (or one of them, for an array).
 */
export function showWhen<T extends z.ZodType>(
  schema: T,
  rule: { path: string; equals: unknown },
): T {
  const equals = Array.isArray(rule.equals) ? [...rule.equals] : [rule.equals];
  return setHelp(schema, { showWhen: { path: rule.path, equals } });
}

/** An example value, shown as a placeholder (URLs, hosts, paths, keys). */
export function example<T extends z.ZodType>(schema: T, value: unknown): T {
  return setHelp(schema, { example: value });
}

/** A recommended value and why (shown as a hint; never applied automatically). */
export function recommend<T extends z.ZodType>(schema: T, value: unknown, why: string): T {
  return setHelp(schema, { recommended: { value, why } });
}

/**
 * Lint a settings JSON Schema (as served by admin-api `/config/schema`) for missing help:
 * every leaf setting needs a `description`, and every enum needs an `x-enumLabels` entry for
 * each value. Fixed values (`const`) are exempt. Returns one message per problem (empty when
 * complete). `skip` lists dot paths that are documented elsewhere (e.g. `modules`).
 */
export function auditSchemaHelp(
  jsonSchema: unknown,
  opts: { root?: string; skip?: string[] } = {},
): string[] {
  type Node = Record<string, unknown>;
  const problems: string[] = [];
  const top = jsonSchema as Node;
  const resolve = (n: Node): Node => {
    const ref = n.$ref;
    if (typeof ref !== 'string' || !ref.startsWith('#/')) return n;
    let cur: unknown = top;
    for (const seg of ref.slice(2).split('/')) cur = (cur as Node | undefined)?.[seg];
    return { ...((cur as Node) ?? {}), ...n, $ref: undefined };
  };
  const visit = (raw: unknown, path: string, depth: number): void => {
    if (!raw || typeof raw !== 'object' || depth > 40) return;
    if (opts.skip?.includes(path)) return;
    const n = resolve(raw as Node);
    const label = path || '(root)';
    const variants = (n.anyOf ?? n.oneOf) as unknown[] | undefined;
    if (Array.isArray(variants) && !n.properties) {
      const real = variants.filter((v) => (v as Node)?.type !== 'null');
      real.forEach((v, i) => visit(v, real.length > 1 ? `${path}<${i}>` : path, depth + 1));
      return;
    }
    const props = n.properties as Record<string, unknown> | undefined;
    if (props) {
      for (const [k, v] of Object.entries(props)) visit(v, path ? `${path}.${k}` : k, depth + 1);
      return;
    }
    if ('const' in n) return;
    if (!n.description) problems.push(`${label}: missing description`);
    if (Array.isArray(n.enum)) {
      const labelsOf = (n['x-enumLabels'] ?? {}) as Record<string, unknown>;
      const missing = n.enum.filter((v) => typeof labelsOf[String(v)] !== 'string');
      if (missing.length) problems.push(`${label}: no x-enumLabels for ${missing.join(', ')}`);
    }
    const items = n.items as Node | undefined;
    if (items && typeof items === 'object') {
      const it = resolve(items);
      if (it.properties || it.anyOf || it.oneOf) visit(it, `${path}[]`, depth + 1);
      else if (Array.isArray(it.enum)) {
        const labelsOf = (it['x-enumLabels'] ?? n['x-enumLabels'] ?? {}) as Record<string, unknown>;
        const missing = it.enum.filter((v) => typeof labelsOf[String(v)] !== 'string');
        if (missing.length) problems.push(`${label}[]: no x-enumLabels for ${missing.join(', ')}`);
      }
    }
    const extra = n.additionalProperties as Node | undefined;
    if (extra && typeof extra === 'object') {
      const ex = resolve(extra);
      if (ex.properties || ex.anyOf || ex.oneOf) visit(ex, `${path}.*`, depth + 1);
    }
  };
  visit(jsonSchema, opts.root ?? '', 0);
  return problems;
}

const slider = (d: string) => z.number().int().min(0).max(100).describe(d);

/** Plain labels for storage-style drivers (blob storage and backup targets). */
const BLOB_DRIVER_LABELS = {
  fs: "This server's disk",
  s3: 'Amazon S3 or compatible (MinIO, Wasabi…)',
  r2: 'Cloudflare R2',
  gcs: 'Google Cloud Storage',
  memory: 'Memory only (testing — lost on restart)',
};
const CLOUD_BLOB_DRIVERS = ['s3', 'r2', 'gcs'];

/** Goals (§6.7). 0..100 sliders; the goals engine derives concrete limits. */
export const GoalsSchema = z
  .object({
    openness: slider(
      'How open the relay is: 0 = very strict, 100 = anyone can post. Move it down if strangers cause trouble.',
    ).default(70),
    spamTolerance: slider(
      '0 = aggressive spam blocking, 100 = relaxed. Lower it during a spam wave; raise it if real posts get blocked.',
    ).default(40),
    storage: slider(
      '0 = keep it lean (short retention), 100 = keep everything. Lower it when the disk fills up.',
    ).default(60),
    media: slider(
      '0 = basic media, 100 = rich media (resizing, video). Higher uses more disk and processing.',
    ).default(50),
    speedVsCost: slider(
      '0 = cheapest to run, 100 = fastest. Raise it if the relay feels slow and you can afford more resources.',
    ).default(50),
  })
  .describe('Simple goals. Beamhop turns these into the exact settings for you.');
export type Goals = z.infer<typeof GoalsSchema>;

export const PersonaSchema = labels(
  z.enum(['public-social', 'private-team', 'wot-community', 'media-host', 'organization']),
  {
    'public-social': 'Public social relay (anyone can join)',
    'private-team': 'Private team (only invited people)',
    'wot-community': 'Community of people you trust (friends of friends)',
    'media-host': 'Media host (photos, video, files)',
    organization: 'Organization (company or institution)',
  },
).describe('What kind of relay this is. Sets sensible goals and defaults.');
export type Persona = z.infer<typeof PersonaSchema>;

export const AccessSchema = z
  .object({
    mode: labels(
      technical(
        z.enum(['open', 'allowlist', 'wot']).default('open'),
        'open: any pubkey; allowlist: explicit pubkeys/invites; wot: follow graph of owner (kind 3) to N hops.',
      ),
      {
        open: 'Anyone',
        allowlist: 'Only people I add or invite',
        wot: 'People my network trusts (friends of friends)',
      },
    ).describe('Who can post'),
    authRequired: technical(
      z
        .object({
          read: z
            .boolean()
            .default(false)
            .describe('People must sign in to read. Turn on for private relays.'),
          write: z
            .boolean()
            .default(false)
            .describe(
              'People must sign in to post. Needed for invite-only or trust-based access to work reliably.',
            ),
        })
        .prefault({})
        .describe('Whether people have to sign in with their key first'),
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
          .describe(
            'How many follow hops count as trusted: 1 = people you follow, 2 = also people they follow.',
          ),
        minFollowers: z
          .number()
          .int()
          .min(0)
          .default(1)
          .describe(
            'Minimum trusted followers to be let in. Raise it to make it harder for strangers to slip in.',
          ),
        seeds: technical(
          z
            .array(z.string())
            .default([])
            .describe(
              'Extra trusted people besides the owner. Their follows count as trusted too.',
            ),
          'Hex pubkeys used as additional roots of the follow graph.',
        ),
        refreshMinutes: technical(
          z
            .number()
            .int()
            .min(5)
            .default(360)
            .describe(
              'How often the list of trusted people is rebuilt, in minutes. Lower means new follows count sooner.',
            ),
          'Interval for re-fetching contact lists (kind 3) and recomputing the trust graph.',
        ),
      })
      .prefault({})
      .describe('Settings for "people my network trusts" access'),
  })
  .prefault({})
  .describe('Who can read and post on this relay');

export const TierSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .describe('Short internal name (lowercase letters, digits, dashes), e.g. "plus".'),
    name: z.string().describe('Shown to admins and users, e.g. "Plus"'),
    eventsPerMinute: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('How many posts per minute people in this tier may send. Empty = relay default.'),
    maxEventBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Largest single post allowed, in bytes. Empty = relay default.'),
    allowedKinds: technical(
      z
        .array(z.number().int())
        .optional()
        .describe('Only these types of posts are allowed for this tier. Empty = all types.'),
      'Event kinds accepted for members of this tier.',
    ),
    blobQuotaBytes: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Total storage for uploaded files per person, in bytes. Empty = relay default.'),
    maxBlobBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Largest single file upload, in bytes. Empty = relay default.'),
    retentionDays: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Posts from this tier are kept for this many days. Empty = relay default.'),
  })
  .describe('A membership level with its own limits');
export type Tier = z.infer<typeof TierSchema>;

/** Advanced overrides; anything set here wins over goals-derived values and is shown as "overridden". */
export const LimitsOverrideSchema = z
  .object({
    maxEventBytes: z
      .number()
      .int()
      .positive()
      .describe('Largest single post allowed, in bytes. Leave empty to follow your goals.'),
    maxSubscriptions: technical(
      z
        .number()
        .int()
        .positive()
        .describe('How many live feeds one app connection may keep open at once.'),
      'Max concurrent REQ subscriptions per connection (NIP-11 max_subscriptions).',
    ),
    maxFilters: technical(
      z.number().int().positive().describe('How many search conditions one feed request may use.'),
      'Max filters per REQ (NIP-11 max_filters).',
    ),
    maxLimit: technical(
      z.number().int().positive().describe('Most posts returned for one request.'),
      'Upper bound for a filter `limit` (NIP-11 max_limit).',
    ),
    eventsPerMinute: z
      .number()
      .int()
      .positive()
      .describe('How many posts per minute one person may send.'),
    reqPerMinute: technical(
      z.number().int().positive().describe('How many feed requests per minute one app may make.'),
      'REQ messages per minute per connection.',
    ),
    minPowDifficulty: technical(
      z
        .number()
        .int()
        .min(0)
        .max(40)
        .describe(
          'Extra computing work every post must prove before it is accepted. Higher stops spam bots but slows posting. 0 = off.',
        ),
      'NIP-13 leading zero bits',
    ),
    newKeyPowDifficulty: technical(
      z
        .number()
        .int()
        .min(0)
        .max(40)
        .describe(
          'Like the above, but only for brand-new accounts. Raise it during a spam wave from fresh accounts.',
        ),
      'NIP-13 leading zero bits required from pubkeys first seen recently.',
    ),
    maxCreatedAtFutureSeconds: technical(
      z
        .number()
        .int()
        .nonnegative()
        .describe('How far in the future a post may be dated, in seconds.'),
      'Reject events with created_at more than this many seconds ahead of now.',
    ),
    maxCreatedAtPastSeconds: technical(
      z
        .number()
        .int()
        .nonnegative()
        .describe('How old a newly sent post may be dated, in seconds.'),
      'Reject events with created_at more than this many seconds before now.',
    ),
    allowedKinds: technical(
      z
        .array(z.number().int())
        .describe('Only accept these types of posts. Leave empty to accept every type.'),
      'Event kind allowlist.',
    ),
    blockedKinds: technical(
      z.array(z.number().int()).describe('Never accept these types of posts.'),
      'Event kind denylist.',
    ),
  })
  .partial()
  .prefault({})
  .describe(
    'Exact numbers that override what your goals chose. Leave empty unless you need a specific value.',
  );
export type LimitsOverride = z.infer<typeof LimitsOverrideSchema>;

export const RetentionRuleSchema = z
  .object({
    kinds: technical(
      z
        .array(z.number().int())
        .optional()
        .describe('Which types of posts this rule is for. Empty = all posts.'),
      'Event kinds this rule applies to.',
    ),
    days: z.number().int().positive().describe('Delete matching posts after this many days.'),
  })
  .describe('How long to keep a type of post');

export const BlossomSchema = z
  .object({
    enabled: z.boolean().default(true).describe('Host media (images, video, files) for your users'),
    maxBlobBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Largest single file upload, in bytes. Empty = follow your media goal.'),
    defaultQuotaBytes: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Total storage each person gets for uploads, in bytes. Empty = follow your goals.'),
    allowedTypes: example(
      z
        .array(z.string())
        .optional()
        .describe('Allowed file types, e.g. image/*. Empty = all types.'),
      ['image/*', 'video/mp4'],
    ),
    requireAuth: recommend(
      technical(
        z
          .boolean()
          .default(true)
          .describe(
            'People must sign in with their key to upload. Turning this off lets anyone upload anonymously.',
          ),
        'BUD-02 kind 24242 auth required for upload',
      ),
      true,
      'Without it, anyone on the internet can fill your storage.',
    ),
    mirror: technical(
      z.boolean().default(true).describe('Allow copying files from other media servers'),
      'BUD-04 PUT /mirror',
    ),
    optimize: z
      .object({
        stripMetadata: recommend(
          z.boolean().default(true).describe('Remove location/camera info from photos'),
          true,
          'Protects people from accidentally sharing where they live.',
        ),
        thumbnails: z
          .boolean()
          .default(true)
          .describe('Make small preview images so feeds load faster.'),
        resize: z
          .boolean()
          .default(true)
          .describe('Shrink very large photos to save space and data.'),
        transcode: z
          .boolean()
          .default(false)
          .describe(
            'Convert videos to a widely playable format. Uses a lot of processing power; needs ffmpeg.',
          ),
      })
      .prefault({})
      .describe('Automatic processing of uploaded photos and videos'),
    scanning: z
      .object({
        enabled: z
          .boolean()
          .default(true)
          .describe('Check uploads against known-abuse image lists'),
        lists: technical(
          z
            .array(z.string())
            .default([])
            .describe(
              'Where the known-abuse lists come from (file paths or web addresses). Scanning does nothing until at least one is added.',
            ),
          'Perceptual-hash (pHash/dHash) lists, local paths or http(s) URLs.',
        ),
      })
      .prefault({})
      .describe('Abuse scanning of uploaded images'),
  })
  .prefault({})
  .describe('Media hosting (photos, video, files)');

export const RelayInfoSchema = z
  .object({
    name: z
      .string()
      .default('Beamhop Relay')
      .describe('The name people see in their apps and on your landing page.'),
    description: z.string().default('').describe('A sentence or two about what this relay is for.'),
    icon: example(
      z.string().url().optional().describe('Web address of a square logo shown in apps.'),
      'https://example.com/logo.png',
    ),
    banner: example(
      z.string().url().optional().describe('Web address of a wide banner image for your page.'),
      'https://example.com/banner.jpg',
    ),
    contact: example(
      z.string().optional().describe('How people can reach the admin (email or web address).'),
      'mailto:admin@example.com',
    ),
    pubkey: technical(
      z.string().optional().describe("Owner's public key"),
      'NIP-11 `pubkey` (hex); also the root of the trust graph.',
    ),
    rules: z.string().optional().describe('Community rules, shown on your landing page'),
  })
  .prefault({})
  .describe('How your relay presents itself');

export const PublicPagesSchema = z
  .object({
    landing: z
      .boolean()
      .default(true)
      .describe('Show a public welcome page with your relay name, description and rules.'),
    portal: z
      .boolean()
      .default(true)
      .describe('Let members sign in to a self-service page to see their account and uploads.'),
    status: z
      .boolean()
      .default(true)
      .describe('Show a public page with uptime and current health.'),
  })
  .prefault({})
  .describe('Public web pages for this relay');

export const RelaySchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .describe('Internal id of this virtual relay'),
  hosts: example(
    z
      .array(z.string())
      .min(1)
      .describe('Domain names this relay answers on. Point these names at this server first.'),
    ['relay.example.com'],
  ),
  pathPrefix: example(
    z
      .string()
      .optional()
      .describe(
        'Serve this relay under a path instead of the whole domain. Only needed to run several relays on one domain.',
      ),
    '/team',
  ),
  persona: PersonaSchema.default('public-social'),
  goals: GoalsSchema.prefault({}),
  info: RelayInfoSchema,
  access: AccessSchema,
  tiers: z
    .array(TierSchema)
    .default([{ id: 'default', name: 'Default' }])
    .describe('Membership levels with their own limits, e.g. a paid "Plus" level.'),
  defaultTier: z
    .string()
    .default('default')
    .describe('The membership level new people get (its short internal name).'),
  limits: LimitsOverrideSchema,
  retention: z
    .array(RetentionRuleSchema)
    .default([])
    .describe('Delete some types of posts after a while. Empty = follow your storage goal.'),
  blossom: BlossomSchema,
  public: PublicPagesSchema,
});
export type RelayConfig = z.infer<typeof RelaySchema>;

export const StorageSchema = z
  .object({
    driver: recommend(
      labels(z.enum(['sqlite', 'postgres', 'd1', 'memory']).default('sqlite'), {
        sqlite: 'A database file on this server (simplest)',
        postgres: 'PostgreSQL server',
        d1: 'Cloudflare D1',
        memory: 'Memory only (testing — lost on restart)',
      }),
      'sqlite',
      'Fast and needs no extra software for a single server.',
    ).describe(
      'Where posts and settings are stored. Change it only when moving to a separate database server or to Cloudflare.',
    ),
    url: showWhen(
      example(
        z.string().optional().describe('Database file path or connection URL'),
        'postgres://beamhop:secret@db.internal:5432/beamhop',
      ),
      { path: 'driver', equals: ['sqlite', 'postgres'] },
    ),
  })
  .prefault({})
  .describe('The database for posts and settings');

export const BlobStorageSchema = z
  .object({
    driver: labels(
      z.enum(['fs', 's3', 'r2', 'gcs', 'memory']).default('fs'),
      BLOB_DRIVER_LABELS,
    ).describe(
      "Which storage service to use. Pick cloud storage when this server's disk is too small or you want copies kept elsewhere.",
    ),
    path: showWhen(
      example(
        z
          .string()
          .optional()
          .describe(
            'Folder on this server where the files go. Empty = a folder inside the data folder.',
          ),
        '/var/lib/beamhop/blobs',
      ),
      { path: 'driver', equals: ['fs'] },
    ),
    bucket: showWhen(
      example(
        z
          .string()
          .optional()
          .describe('Name of the storage bucket you created with your provider.'),
        'my-relay-media',
      ),
      { path: 'driver', equals: CLOUD_BLOB_DRIVERS },
    ),
    endpoint: showWhen(
      example(
        technical(
          z
            .string()
            .optional()
            .describe(
              "Your provider's storage address. Leave empty for Amazon S3 and Google Cloud; needed for R2, MinIO and others.",
            ),
          'S3 API endpoint (path-style). Defaults: https://s3.<region>.amazonaws.com, https://storage.googleapis.com.',
        ),
        'https://<account-id>.r2.cloudflarestorage.com',
      ),
      { path: 'driver', equals: CLOUD_BLOB_DRIVERS },
    ),
    region: showWhen(
      example(
        technical(
          z
            .string()
            .optional()
            .describe(
              'Data-center region of the bucket. Empty = us-east-1 for S3, auto otherwise.',
            ),
          'SigV4 signing region.',
        ),
        'eu-central-1',
      ),
      { path: 'driver', equals: CLOUD_BLOB_DRIVERS },
    ),
    accessKeyId: showWhen(
      z.string().optional().describe('The access key ID from your storage provider.'),
      { path: 'driver', equals: CLOUD_BLOB_DRIVERS },
    ),
    secretAccessKey: showWhen(
      z
        .string()
        .optional()
        .describe('The secret that goes with the access key. Stored privately, never shown again.'),
      { path: 'driver', equals: CLOUD_BLOB_DRIVERS },
    ),
  })
  .prefault({})
  .describe('A place to keep files: this server or a cloud storage service');

export const NodeSchema = z
  .object({
    id: z
      .string()
      .default('local')
      .describe('A name for this server. Only matters when you run more than one.'),
    listen: technical(
      example(
        z
          .string()
          .default('0.0.0.0:3334')
          .describe(
            'Network address and port the server listens on. Change it if the port is taken.',
          ),
        '0.0.0.0:443',
      ),
      'host:port to bind; 443 with a public IP enables automatic certificates in `auto` mode.',
    ),
    dataDir: example(
      z
        .string()
        .default('./data')
        .describe('Folder where the database, uploads and keys are kept. Back this folder up.'),
      '/var/lib/beamhop',
    ),
    tls: z
      .object({
        mode: recommend(
          technical(
            labels(z.enum(['auto', 'acme', 'proxy', 'off']).default('auto'), {
              auto: 'Automatic (recommended)',
              acme: "Always get free certificates (Let's Encrypt)",
              proxy: 'Another server in front handles it',
              off: 'Off (no encryption — testing only)',
            }),
            'auto: ACME on :443 with a public IP and configured hosts, otherwise proxy. acme: HTTP-01 via ACME. proxy: plain HTTP behind a TLS-terminating reverse proxy. off: no TLS (ws:// URLs).',
          ),
          'auto',
          'Picks the right option for most setups.',
        ).describe('How secure connections (https/wss) are set up.'),
        email: showWhen(
          example(
            z
              .string()
              .email()
              .optional()
              .describe('Email for certificate expiry notices. Optional but helpful.'),
            'admin@example.com',
          ),
          { path: 'mode', equals: ['auto', 'acme'] },
        ),
      })
      .prefault({})
      .describe('Secure connections (certificates)'),
    trustProxy: technical(
      z
        .boolean()
        .default(false)
        .describe(
          'Turn on only if a reverse proxy or CDN (e.g. Caddy, nginx, Cloudflare) sits in front of this server.',
        ),
      'Trust X-Forwarded-For / X-Forwarded-Proto and the country header from the proxy.',
    ),
    countryHeader: showWhen(
      example(
        technical(
          z
            .string()
            .optional()
            .describe(
              'Name of the header your proxy uses to say which country a visitor is from. Used for country statistics.',
            ),
          'Header set by the trusted reverse proxy with the ISO 3166 country of the client (e.g. cf-ipcountry). Read only when trustProxy is on; never derived from IPs.',
        ),
        'cf-ipcountry',
      ),
      { path: 'trustProxy', equals: true },
    ),
    verifyWorkers: technical(
      z
        .number()
        .int()
        .min(0)
        .max(256)
        .optional()
        .describe(
          'Signature checking threads: how many background threads check that incoming posts are really signed by their author. Leave empty to pick automatically; 0 checks them on the main thread.',
        ),
      'Size of the Schnorr (BIP-340) verification worker pool on Bun. Default: CPU cores − 1 (min 1). 0 disables the pool (inline verification). Ignored on Cloudflare. CLI: --verify-workers <n>.',
    ),
  })
  .prefault({})
  .describe('This server');

const channelId = z.string().describe('A short name for this channel, used to refer to it.');

export const AlertChannelSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('webpush'), id: channelId }).describe('Push to the admin app'),
  z
    .object({
      type: z.literal('nostr-dm'),
      id: channelId,
      pubkey: technical(
        z.string().describe('Public key of the person who should get the private messages.'),
        'Recipient pubkey for NIP-17 direct messages.',
      ),
    })
    .describe('Private Nostr message'),
  z
    .object({
      type: z.literal('telegram'),
      id: channelId,
      botToken: z.string().describe('The token Telegram gave you when you created your bot.'),
      chatId: z.string().describe('The Telegram chat the bot should write to.'),
    })
    .describe('Telegram'),
  z
    .object({
      type: z.literal('discord'),
      id: channelId,
      webhookUrl: example(
        z.string().url().describe('The webhook address from your Discord channel settings.'),
        'https://discord.com/api/webhooks/…',
      ),
    })
    .describe('Discord'),
  z
    .object({
      type: z.literal('slack'),
      id: channelId,
      webhookUrl: example(
        z.string().url().describe('The incoming-webhook address from your Slack app.'),
        'https://hooks.slack.com/services/…',
      ),
    })
    .describe('Slack'),
  z
    .object({
      type: z.literal('email'),
      id: channelId,
      to: example(z.string().email().describe('Who gets the alert emails.'), 'admin@example.com'),
      smtpUrl: example(
        z.string().describe('The mail server used to send, including login.'),
        'smtps://user:password@smtp.example.com:465',
      ),
    })
    .describe('Email'),
]);

export const AlertsSchema = z
  .object({
    channels: z
      .array(AlertChannelSchema)
      .default([])
      .describe('Where urgent alerts are sent (app push, Nostr message, chat apps, email).'),
    digest: recommend(
      labels(z.enum(['off', 'daily', 'weekly']).default('daily'), {
        off: 'Off',
        daily: 'Every day',
        weekly: 'Every week',
      }),
      'daily',
      'A short daily summary catches problems early without being noisy.',
    ).describe('How often you get a summary of how the relay is doing.'),
  })
  .prefault({})
  .describe('Alerts and summaries');

export const AiSchema = z
  .object({
    enabled: z
      .boolean()
      .default(false)
      .describe(
        'Turn on the assistant that answers questions and suggests changes. Off by default.',
      ),
    baseUrl: example(
      technical(
        z.string().url().optional().describe('OpenAI-compatible endpoint, e.g. Ollama'),
        'Base URL of an OpenAI-compatible chat completions API.',
      ),
      'http://127.0.0.1:11434/v1',
    ),
    model: example(
      z.string().optional().describe('Name of the AI model to use, as your provider calls it.'),
      'llama3.1',
    ),
    apiKey: z
      .string()
      .optional()
      .describe('Key for your AI provider. Leave empty for local models like Ollama.'),
  })
  .prefault({})
  .describe('AI assistant');

export const BackupSchema = z
  .object({
    enabled: recommend(
      z.boolean().default(false).describe('Make automatic backups of your relay.'),
      true,
      'Backups let you recover from a broken disk or a mistake.',
    ),
    schedule: labels(z.enum(['hourly', 'daily', 'weekly']).default('daily'), {
      hourly: 'Every hour',
      daily: 'Every day',
      weekly: 'Every week',
    }).describe('How often a backup is made. More often means less to lose.'),
    target: BlobStorageSchema.optional().describe(
      'Where backups are stored. Somewhere other than this server is safest.',
    ),
    keep: recommend(
      z
        .number()
        .int()
        .positive()
        .default(14)
        .describe('How many backups to keep before the oldest is deleted.'),
      14,
      'Two weeks of daily backups is a good balance of safety and space.',
    ),
  })
  .prefault({})
  .describe('Automatic backups');

export const PrivacySchema = z
  .object({
    ipLogging: recommend(
      technical(
        labels(z.enum(['hashed', 'truncated', 'off']).default('hashed'), {
          hashed: 'Scrambled (recommended)',
          truncated: 'Scrambled, neighbourhood only',
          off: 'Not recorded at all',
        }),
        'hashed: salted SHA-256 of the IP, salt rotates daily; truncated: same, of the /24 (IPv4) or /48 (IPv6) network; off: constant placeholder. Raw IPs are never stored.',
      ),
      'hashed',
      'Lets rate limits and abuse protection work without storing real addresses.',
    ).describe(
      'How visitor network addresses are recorded. Addresses are never stored as-is; "off" weakens abuse protection.',
    ),
  })
  .prefault({})
  .describe('Privacy');

export const ConfigSchema = z.object({
  version: z.literal(1).default(1).describe('Settings format version.'),
  node: NodeSchema,
  storage: StorageSchema,
  blobStorage: BlobStorageSchema.describe('Where uploaded files (photos, video) are stored'),
  relays: z
    .array(RelaySchema)
    .default([])
    .describe('The relays this server runs. Each has its own domain, rules and members.'),
  alerts: AlertsSchema,
  ai: AiSchema,
  backups: BackupSchema,
  privacy: PrivacySchema,
  plugins: z
    .array(
      z
        .object({
          id: z.string().describe('Which plugin this is.'),
          enabled: z.boolean().default(true).describe('Turn the plugin on or off.'),
          config: z.unknown().describe("The plugin's own settings."),
        })
        .describe('An installed plugin'),
    )
    .default([])
    .describe('Installed plugins that add extra rules or features.'),
  /** Module sections keyed by module id. Absent unless the module is enabled. */
  modules: z
    .record(z.string(), z.unknown())
    .prefault({})
    .describe('Settings of optional features, one section per feature.'),
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
