// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `config.modules['enterprise-compliance']`. The module is only loaded when this
 * key exists (isolation rule §12.0); every section has safe defaults so `{}` works.
 */
import { example, labels, recommend, showWhen, technical } from '@beamhop/core';
import { z } from 'zod';

export const MODULE_ID = 'enterprise-compliance';

/** Gated by default (§12.9). Ids that are not registered on this node are ignored. */
export const DEFAULT_GATED_ACTIONS = [
  'escrow.decrypt-dm',
  'keyvault.destroy-key',
  'keyvault.rotate-kek',
  'compliance.release-hold',
  'moderation.bulk-delete',
  'enterprise.disconnect-idp',
  'backups.restore',
] as const;

const STREAM_LABELS = {
  audit: 'Admin activity log',
  auth: 'Sign-ins',
  signing: 'Key signing (managed keys)',
  escrow: 'Message archive access',
  config: 'Settings changes',
  deletion: 'Deletions',
  compliance: 'Legal holds, exports and approvals',
};

const SinkBase = {
  id: example(
    z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .describe('Short name for this destination'),
    'company-siem',
  ),
  enabled: z
    .boolean()
    .default(true)
    .describe('Send records to this destination. Turn off to pause it without deleting it.'),
  /** Which record streams go to this sink. */
  streams: z
    .array(
      labels(
        z.enum(['audit', 'auth', 'signing', 'escrow', 'config', 'deletion', 'compliance']),
        STREAM_LABELS,
      ),
    )
    .optional()
    .describe('Which kinds of records to send (all when empty)'),
};

export const SinkSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...SinkBase,
      type: z.literal('syslog'),
      host: example(z.string().describe('Syslog server host name'), 'syslog.example.com'),
      port: z
        .number()
        .int()
        .min(1)
        .max(65535)
        .default(6514)
        .describe('Port of the syslog server. Use what your log team gives you.'),
      transport: recommend(
        labels(
          technical(
            z.enum(['tls', 'tcp', 'udp']).default('tls'),
            'RFC 5424 over TLS (RFC 5425) / TCP (RFC 6587 octet counting) / UDP (RFC 5426). Bun only.',
          ),
          {
            tls: 'Encrypted (recommended)',
            tcp: 'Unencrypted, reliable',
            udp: 'Unencrypted, may lose records',
          },
        ),
        'tls',
        'Keeps the records private on the network.',
      ).describe('How to connect'),
      facility: technical(
        z
          .number()
          .int()
          .min(0)
          .max(23)
          .default(13)
          .describe(
            'Category number your log server uses to sort messages. Keep the default unless told otherwise.',
          ),
        'Syslog facility code (13 = log audit).',
      ),
      appName: z
        .string()
        .default('beamhop')
        .describe('Name the records are tagged with in your log server.'),
      caPem: showWhen(
        z.string().optional().describe('Company CA for the syslog server certificate'),
        { path: 'transport', equals: 'tls' },
      ),
    })
    .describe('Syslog server'),
  z
    .object({
      ...SinkBase,
      type: z.literal('splunk'),
      url: example(
        z.string().url().describe('Splunk HTTP Event Collector address'),
        'https://splunk.example.com:8088',
      ),
      token: technical(
        z.string().describe('The access token Splunk gave you for sending data.'),
        'HEC token',
      ),
      index: z
        .string()
        .optional()
        .describe('Splunk index to store records in. Empty = the token’s default index.'),
      sourcetype: z
        .string()
        .default('beamhop:audit')
        .describe(
          'Label Splunk uses to recognise these records. Keep the default unless told otherwise.',
        ),
    })
    .describe('Splunk'),
  z
    .object({
      ...SinkBase,
      type: z.literal('sentinel'),
      tenantId: technical(
        z.string().describe('Your Microsoft directory (tenant) ID.'),
        'Entra ID tenant id (GUID).',
      ),
      clientId: technical(
        z.string().describe('ID of the app registration allowed to send logs.'),
        'Entra app registration client id.',
      ),
      clientSecret: z.string().describe('Secret of that app registration. Stored privately.'),
      dceEndpoint: example(
        technical(
          z.string().url(),
          'Data Collection Endpoint ingestion URL (Logs Ingestion API)',
        ).describe('Azure data collection endpoint'),
        'https://my-dce.westeurope-1.ingest.monitor.azure.com',
      ),
      dcrImmutableId: technical(
        z.string().describe('ID of the data collection rule that receives the records.'),
        'DCR immutable id (dcr-…).',
      ),
      streamName: z
        .string()
        .default('Custom-Beamhop_CL')
        .describe('Name of the table stream in that rule. Keep the default unless you renamed it.'),
      authorityHost: z
        .string()
        .url()
        .default('https://login.microsoftonline.com')
        .describe('Microsoft sign-in address. Only change it for government clouds.'),
    })
    .describe('Microsoft Sentinel'),
  z
    .object({
      ...SinkBase,
      type: z.literal('chronicle'),
      customerId: technical(
        z.string().describe('Your Google Security Operations customer ID.'),
        'Chronicle customer id (GUID).',
      ),
      logType: z
        .string()
        .default('BEAMHOP')
        .describe('Log type the records are filed under. Keep the default unless told otherwise.'),
      region: example(
        z.string().default('us').describe('Region of your Google Security Operations instance.'),
        'europe',
      ),
      endpoint: technical(
        z
          .string()
          .url()
          .optional()
          .describe('Custom address to send to. Empty = chosen from the region.'),
        'Defaults to https://{region}-malachiteingestion-pa.googleapis.com (v2 unstructuredlogentries:batchCreate)',
      ),
      serviceAccount: z
        .object({
          clientEmail: example(
            z.string().describe('Email address of the Google service account.'),
            'beamhop@my-project.iam.gserviceaccount.com',
          ),
          privateKeyPem: z
            .string()
            .describe(
              'Private key of that service account (from its JSON key file). Stored privately.',
            ),
          tokenUri: z
            .string()
            .url()
            .default('https://oauth2.googleapis.com/token')
            .describe('Google sign-in address. Keep the default.'),
        })
        .describe('Google service account allowed to ingest'),
    })
    .describe('Google Security Operations (Chronicle)'),
  z
    .object({
      ...SinkBase,
      type: z.literal('webhook'),
      url: example(
        z.string().url().describe('Web address that receives batches of records.'),
        'https://logs.example.com/beamhop',
      ),
      secret: technical(
        z
          .string()
          .optional()
          .describe('Shared secret so the receiver can check records really came from here.'),
        'Signs each batch (HMAC-SHA256)',
      ),
      headers: example(
        z
          .record(z.string(), z.string())
          .default({})
          .describe('Extra headers sent with each request, e.g. an access key.'),
        { authorization: 'Bearer …' },
      ),
    })
    .describe('Web address (webhook)'),
]);
export type SinkConfig = z.infer<typeof SinkSchema>;

export const ComplianceConfigSchema = z
  .object({
    approvals: z
      .object({
        enabled: recommend(
          z.boolean().default(true).describe('Require a second admin for risky actions'),
          true,
          'Stops one person (or one stolen login) from doing irreversible damage alone.',
        ),
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
          .describe('How long a request waits for approval, in minutes'),
        executeWithinMinutes: z
          .number()
          .int()
          .min(1)
          .max(24 * 60)
          .default(60)
          .describe('How long an approval stays usable, in minutes'),
      })
      .prefault({})
      .describe('Second-admin approval for risky actions'),
    siem: z
      .object({
        sinks: z
          .array(SinkSchema)
          .default([])
          .describe('Security log systems that get a copy of audit and sign-in records.'),
        intervalSeconds: z
          .number()
          .int()
          .min(5)
          .max(3600)
          .default(15)
          .describe('How often waiting records are sent, in seconds.'),
        batchSize: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(200)
          .describe(
            'How many records are sent in one go. Lower it if your log system rejects large requests.',
          ),
        maxBatchesPerTick: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(10)
          .describe('Most batches sent each time. Raise it if records pile up.'),
        maxOutbox: technical(
          z
            .number()
            .int()
            .min(100)
            .default(100_000)
            .describe('Most records kept waiting while a destination is unreachable.'),
          'Bounded outbox: when full, the oldest non-audit records are dropped and counted.',
        ),
        authEvents: z.boolean().default(true).describe('Send relay sign-ins'),
        deletionEvents: z.boolean().default(true).describe('Send deletions'),
      })
      .prefault({})
      .describe('Forwarding records to your security log system (SIEM)'),
    holds: z
      .object({
        archiveOnDelete: technical(
          z.boolean().default(true),
          'Copies held events to compliance.hold-archive before NIP-09/62/admin deletion.',
        ).describe('Keep a copy of held posts that people delete'),
        refreshSeconds: z
          .number()
          .int()
          .min(10)
          .default(60)
          .describe('How quickly holds changed on another server take effect here, in seconds.'),
      })
      .prefault({})
      .describe('Legal holds'),
    ediscovery: z
      .object({
        maxEvents: z
          .number()
          .int()
          .min(1)
          .max(5_000_000)
          .default(500_000)
          .describe('Most posts included in one legal export.'),
        includeBlobs: z
          .boolean()
          .default(true)
          .describe('Include the list of uploaded files in legal exports.'),
      })
      .prefault({})
      .describe('Legal exports (eDiscovery)'),
    retention: z
      .object({
        groups: z
          .array(
            z
              .object({
                group: z.string().describe('Name of the company group.'),
                days: z
                  .number()
                  .int()
                  .positive()
                  .describe('Keep posts by its members for this many days.'),
              })
              .describe('Retention for one group'),
          )
          .default([])
          .describe('Keep posts by members of a group for this many days'),
        defaultDays: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            'How long to keep posts of people in none of these groups. Empty = relay default.',
          ),
      })
      .prefault({})
      .describe('Retention by company group'),
    residency: z
      .object({
        databaseRegion: example(
          z.string().optional().describe('Where the database is hosted'),
          'eu-central-1',
        ),
        relays: z
          .record(
            z.string(),
            z.object({
              region: example(
                z.string().describe('Region this relay’s data must stay in.'),
                'eu-central-1',
              ),
            }),
          )
          .default({})
          .describe('Region each relay’s data must stay in'),
      })
      .prefault({})
      .describe('Data residency checks'),
    reports: z
      .object({
        monthly: z.boolean().default(true).describe('Make a usage report every month'),
      })
      .prefault({})
      .describe('Compliance reports'),
    encryption: z
      .object({
        blobs: technical(
          z.boolean().default(false),
          'Per-blob AES-256-GCM data keys wrapped by ports.keyWrapper (KMS/Vault/local KEK). Existing plaintext blobs stay readable.',
        ).describe('Encrypt stored media with your company key'),
      })
      .prefault({})
      .describe('Encryption of stored files'),
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
