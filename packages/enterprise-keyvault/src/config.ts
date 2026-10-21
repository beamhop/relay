// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `config.modules['enterprise-keyvault']` — absent by default (isolation §12.0).
 */
import { example, labels, recommend, technical } from '@beamhop/core';
import { z } from 'zod';

export const MODULE_ID = 'enterprise-keyvault';
export const SERVICE = 'enterprise.keyvault';

const LocalKek = z
  .object({
    provider: z.literal('local'),
    /** 32 bytes as base64 or hex. Usually injected from the environment by the runtime. */
    key: z.string().optional().describe('Master key (32 random bytes, base64 or hex)'),
    /** Name of an environment variable holding the key. */
    keyEnv: example(
      z.string().optional().describe('Environment variable that holds the master key'),
      'BEAMHOP_KEK',
    ),
    /** Path of a file holding the key (needs a runtime file reader). */
    keyFile: example(
      z.string().optional().describe('File that holds the master key'),
      '/etc/beamhop/kek',
    ),
  })
  .describe('A master key kept on this server');

const AwsKek = z
  .object({
    provider: z.literal('aws-kms'),
    region: example(z.string().describe('The AWS region where the key lives.'), 'eu-central-1'),
    keyId: z.string().describe('KMS key id or ARN'),
    accessKeyId: z.string().describe('The access key ID of an AWS user allowed to use the key.'),
    secretAccessKey: z.string().describe('The secret that goes with that access key.'),
    sessionToken: z
      .string()
      .optional()
      .describe('Only for temporary AWS credentials. Leave empty otherwise.'),
    endpoint: z
      .string()
      .url()
      .optional()
      .describe('Custom service address. Leave empty to use the normal AWS address.'),
  })
  .describe('Amazon Web Services key management');

const GcpKek = z
  .object({
    provider: z.literal('gcp-kms'),
    /** projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k> */
    keyName: example(
      technical(
        z.string().describe('Full name of the key in Google Cloud.'),
        'projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>',
      ),
      'projects/my-project/locations/europe/keyRings/beamhop/cryptoKeys/kek',
    ),
    clientEmail: z.string().describe('Email of the service account allowed to use the key.'),
    privateKey: z.string().describe('Service account private key (PEM, PKCS#8)'),
    tokenUri: z
      .string()
      .url()
      .default('https://oauth2.googleapis.com/token')
      .describe('Google sign-in address for the service account. Rarely changed.'),
    endpoint: z
      .string()
      .url()
      .default('https://cloudkms.googleapis.com')
      .describe('Google key service address. Rarely changed.'),
  })
  .describe('Google Cloud key management');

const AzureKek = z
  .object({
    provider: z.literal('azure-keyvault'),
    vaultUrl: example(
      z.string().url().describe('Address of your Azure Key Vault.'),
      'https://my-vault.vault.azure.net',
    ),
    keyName: z.string().describe('Name of the key in the vault.'),
    keyVersion: z
      .string()
      .optional()
      .describe('A specific key version. Empty = the latest version.'),
    tenantId: z.string().describe('Your Microsoft tenant (directory) id.'),
    clientId: z.string().describe('Application (client) id allowed to use the key.'),
    clientSecret: z.string().describe('Client secret of that application.'),
    algorithm: technical(
      labels(z.enum(['RSA-OAEP-256', 'RSA-OAEP', 'A256KW']).default('RSA-OAEP-256'), {
        'RSA-OAEP-256': 'RSA with SHA-256 (recommended)',
        'RSA-OAEP': 'RSA with SHA-1 (older keys)',
        A256KW: 'AES key wrap (managed HSM keys)',
      }),
      'Key Vault wrapKey/unwrapKey algorithm.',
    ).describe('How the key protects data. Keep the default unless your key type needs another.'),
    authority: z
      .string()
      .url()
      .default('https://login.microsoftonline.com')
      .describe('Microsoft sign-in address. Change only for government or national clouds.'),
    apiVersion: z.string().default('7.4').describe('Key Vault API version. Rarely changed.'),
  })
  .describe('Microsoft Azure Key Vault');

const VaultKek = z
  .object({
    provider: z.literal('vault-transit'),
    address: example(
      z.string().url().describe('Address of your HashiCorp Vault server.'),
      'https://vault.internal:8200',
    ),
    token: z.string().describe('A Vault token allowed to use the key.'),
    keyName: z.string().describe('Name of the key in Vault.'),
    mount: technical(
      z.string().default('transit').describe('Where the key engine is mounted in Vault.'),
      'Transit secrets engine mount path.',
    ),
    namespace: z
      .string()
      .optional()
      .describe('Vault namespace (Vault Enterprise only). Leave empty otherwise.'),
  })
  .describe('HashiCorp Vault');

export const KekConfigSchema = technical(
  z.discriminatedUnion('provider', [LocalKek, AwsKek, GcpKek, AzureKek, VaultKek]),
  'Key-encryption key (KEK) that wraps per-tenant AES-256-GCM data keys (envelope encryption).',
);
export type KekConfig = z.infer<typeof KekConfigSchema>;

export const KeyvaultConfigSchema = z
  .object({
    kek: KekConfigSchema.describe('Where the master key lives'),
    /** Older KEKs still accepted for unwrapping until `keyvault.rotate-kek` re-wraps everything. */
    previousKeks: technical(
      z
        .array(KekConfigSchema)
        .default([])
        .describe('Old master keys, still accepted while everything is moved to the new one.'),
      'Accepted for unwrapping until keyvault.rotate-kek re-wraps every data key.',
    ),
    signing: z
      .object({
        perMinute: z.number().int().min(1).default(120).describe('Signatures per key per minute'),
        auditRetentionDays: z
          .number()
          .int()
          .min(1)
          .default(365)
          .describe('How many days the record of every signature is kept.'),
      })
      .prefault({})
      .describe('Signing limits and records'),
    destroyGraceDays: z
      .number()
      .int()
      .min(0)
      .default(30)
      .describe('Days before a scheduled key destruction happens'),
    bunker: technical(
      z
        .object({
          enabled: z.boolean().default(true).describe('Let apps sign through the built-in bunker'),
          /** Relay that hosts bunker traffic; defaults to the first relay. */
          relayId: z
            .string()
            .optional()
            .describe('Which relay carries the signing requests. Empty = the first relay.'),
          /** Public wss:// URL of that relay; derived from its first host when absent. */
          relayUrl: example(
            z
              .string()
              .optional()
              .describe('Public address of that relay. Empty = worked out from its domain.'),
            'wss://relay.company.com',
          ),
          /** Kinds a bunker session may never sign. */
          deniedKinds: technical(
            z
              .array(z.number().int())
              .default([])
              .describe('Types of posts apps may never sign through the bunker.'),
            'Event kinds a NIP-46 session may never sign.',
          ),
        })
        .prefault({})
        .describe('Remote signing for apps'),
      'NIP-46 remote signer.',
    ),
    escrow: technical(
      z
        .object({
          enabled: z.boolean().default(false).describe('Company can read managed-key DMs'),
          /** Relays where escrow applies; empty = all relays. */
          relays: z
            .array(z.string())
            .default([])
            .describe('Relays where this applies (their internal ids). Empty = all relays.'),
          /** Testing only: allow escrow decrypts when no approvals service exists. */
          allowWithoutApprovals: recommend(
            z
              .boolean()
              .default(false)
              .describe('Allow reading messages without a second approver. Testing only.'),
            false,
            'Reading private messages should always need two people.',
          ),
          notice: z
            .string()
            .default('Your messages on this workspace may be accessed for compliance.')
            .describe('The notice employees see about message access.'),
        })
        .prefault({})
        .describe('Company access to private messages of managed accounts'),
      'NIP-17 gift wraps (1059) addressed to managed keys can be unwrapped (NIP-59 seal → rumor).',
    ),
    migrate: z
      .object({
        /** Wrap the alerts module's relay DM key (`alerts.keys`/`nostr`) on start. */
        alertsKey: technical(
          z
            .boolean()
            .default(true)
            .describe('Protect the key used for alert messages with the master key.'),
          'Wraps alerts.keys/nostr on start.',
        ),
        /**
         * Wrap NIP-29 group signing keys (`relay.groups.key`) on start. The relay reads
         * the `{ pubkey, createdAt, wrapped, provider }` shape through `ports.keyWrapper`.
         */
        relayGroupKeys: technical(
          z
            .boolean()
            .default(true)
            .describe('Protect the keys of group chats with the master key.'),
          'Wraps NIP-29 group signing keys (relay.groups.key) on start.',
        ),
      })
      .prefault({})
      .describe('Protect existing keys with the master key'),
  })
  .describe('Company key custody: master key, signing limits, bunker and DM escrow');

export type KeyvaultConfig = z.infer<typeof KeyvaultConfigSchema>;
