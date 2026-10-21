// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `config.modules['enterprise-compliance']`. The module is only loaded when this
 * key exists (isolation rule §12.0); every section has safe defaults so `{}` works.
 */
import { technical } from '@beamhop/core';
import { z } from 'zod';

export const MODULE_ID = 'enterprise-compliance';

/** Gated by default (§12.9). Ids that are not registered on this node are ignored. */
export const DEFAULT_GATED_ACTIONS = [
  'keyvault.escrow-decrypt',
  'keyvault.destroy-key',
  'keyvault.rotate-kek',
  'compliance.release-hold',
  'moderation.bulk-delete',
  'enterprise.disconnect-idp',
  'backups.restore',
] as const;

const SinkBase = {
  id: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .describe('Short name for this destination'),
  enabled: z.boolean().default(true),
  /** Which record streams go to this sink. */
  streams: z
    .array(z.enum(['audit', 'auth', 'signing', 'escrow', 'config', 'deletion', 'compliance']))
    .optional()
    .describe('Which kinds of records to send (all when empty)'),
};

export const SinkSchema = z.discriminatedUnion('type', [
  z.object({
    ...SinkBase,
    type: z.literal('syslog'),
    host: z.string().describe('Syslog server host name'),
    port: z.number().int().min(1).max(65535).default(6514),
    transport: technical(
      z.enum(['tls', 'tcp', 'udp']).default('tls'),
      'RFC 5424 over TLS (RFC 5425) / TCP (RFC 6587 octet counting) / UDP (RFC 5426). Bun only.',
    ).describe('How to connect'),
    facility: z.number().int().min(0).max(23).default(13),
    appName: z.string().default('beamhop'),
    caPem: z.string().optional().describe('Company CA for the syslog server certificate'),
  }),
  z.object({
    ...SinkBase,
    type: z.literal('splunk'),
    url: z.string().url().describe('Splunk HTTP Event Collector address'),
    token: z.string().describe('HEC token'),
    index: z.string().optional(),
    sourcetype: z.string().default('beamhop:audit'),
  }),
  z.object({
    ...SinkBase,
    type: z.literal('sentinel'),
    tenantId: z.string(),
    clientId: z.string(),
    clientSecret: z.string(),
    dceEndpoint: technical(
      z.string().url(),
      'Data Collection Endpoint ingestion URL (Logs Ingestion API)',
    ).describe('Azure data collection endpoint'),
    dcrImmutableId: z.string(),
    streamName: z.string().default('Custom-Beamhop_CL'),
    authorityHost: z.string().url().default('https://login.microsoftonline.com'),
  }),
  z.object({
    ...SinkBase,
    type: z.literal('chronicle'),
    customerId: z.string(),
    logType: z.string().default('BEAMHOP'),
    region: z.string().default('us'),
    endpoint: technical(
      z.string().url().optional(),
      'Defaults to https://{region}-malachiteingestion-pa.googleapis.com (v2 unstructuredlogentries:batchCreate)',
    ),
    serviceAccount: z
      .object({
        clientEmail: z.string(),
        privateKeyPem: z.string(),
        tokenUri: z.string().url().default('https://oauth2.googleapis.com/token'),
      })
      .describe('Google service account allowed to ingest'),
  }),
  z.object({
    ...SinkBase,
    type: z.literal('webhook'),
    url: z.string().url(),
    secret: z.string().optional().describe('Signs each batch (HMAC-SHA256)'),
    headers: z.record(z.string(), z.string()).default({}),
  }),
]);
export type SinkConfig = z.infer<typeof SinkSchema>;

export const ComplianceConfigSchema = z
  .object({
    approvals: z
      .object({
        enabled: z.boolean().default(true).describe('Require a second admin for risky actions'),
        gatedActions: z
          .array(z.string())
          .default([...DEFAULT_GATED_ACTIONS])
          .describe('Actions that need a second admin'),
        gateAllSensitive: technical(
          z.boolean().default(true),
          'Also gate every action whose ActionDef has `sensitive: true`.',
        ).describe('Also require approval for every action marked risky'),
        requestTtlMinutes: z
          .number()
          .int()
          .min(5)
          .max(7 * 24 * 60)
          .default(24 * 60)
          .describe('How long a request waits for approval'),
        executeWithinMinutes: z
          .number()
          .int()
          .min(1)
          .max(24 * 60)
          .default(60)
          .describe('How long an approval stays usable'),
      })
      .prefault({}),
    siem: z
      .object({
        sinks: z.array(SinkSchema).default([]),
        intervalSeconds: z.number().int().min(5).max(3600).default(15),
        batchSize: z.number().int().min(1).max(5000).default(200),
        maxBatchesPerTick: z.number().int().min(1).max(100).default(10),
        maxOutbox: technical(
          z.number().int().min(100).default(100_000),
          'Bounded outbox: when full, the oldest non-audit records are dropped and counted.',
        ),
        authEvents: z.boolean().default(true).describe('Send relay sign-ins'),
        deletionEvents: z.boolean().default(true).describe('Send deletions'),
      })
      .prefault({}),
    holds: z
      .object({
        archiveOnDelete: technical(
          z.boolean().default(true),
          'Copies held events to compliance.hold-archive before NIP-09/62/admin deletion.',
        ).describe('Keep a copy of held posts that people delete'),
        refreshSeconds: z.number().int().min(10).default(60),
      })
      .prefault({}),
    ediscovery: z
      .object({
        maxEvents: z.number().int().min(1).max(5_000_000).default(500_000),
        includeBlobs: z.boolean().default(true),
      })
      .prefault({}),
    retention: z
      .object({
        groups: z
          .array(z.object({ group: z.string(), days: z.number().int().positive() }))
          .default([])
          .describe('Keep posts by members of a group for this many days'),
        defaultDays: z.number().int().positive().optional(),
      })
      .prefault({}),
    residency: z
      .object({
        databaseRegion: z.string().optional().describe('Where the database is hosted'),
        relays: z
          .record(z.string(), z.object({ region: z.string() }))
          .default({})
          .describe('Region each relay’s data must stay in'),
      })
      .prefault({}),
    reports: z
      .object({
        monthly: z.boolean().default(true).describe('Make a usage report every month'),
      })
      .prefault({}),
    encryption: z
      .object({
        blobs: technical(
          z.boolean().default(false),
          'Per-blob AES-256-GCM data keys wrapped by ports.keyWrapper (KMS/Vault/local KEK). Existing plaintext blobs stay readable.',
        ).describe('Encrypt stored media with your company key'),
      })
      .prefault({}),
  })
  .prefault({});
export type ComplianceConfig = z.infer<typeof ComplianceConfigSchema>;

/** DocStore collections owned by enterprise-compliance. */
export const COL = {
  approvals: 'compliance.approvals',
  outbox: 'compliance.siem-outbox',
  outboxHead: 'compliance.siem-head',
  sinkState: 'compliance.siem-state',
  holds: 'compliance.holds',
  holdArchive: 'compliance.hold-archive',
  heldBlobs: 'compliance.held-blobs',
  exports: 'compliance.exports',
  keys: 'compliance.keys',
  encMeta: 'compliance.enc-blob-meta',
  reports: 'compliance.reports',
} as const;
