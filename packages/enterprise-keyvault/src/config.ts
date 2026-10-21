// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `config.modules['enterprise-keyvault']` — absent by default (isolation §12.0).
 */
import { technical } from '@beamhop/core';
import { z } from 'zod';

export const MODULE_ID = 'enterprise-keyvault';
export const SERVICE = 'enterprise.keyvault';

const LocalKek = z.object({
  provider: z.literal('local'),
  /** 32 bytes as base64 or hex. Usually injected from the environment by the runtime. */
  key: z.string().optional().describe('Master key (32 random bytes, base64 or hex)'),
  /** Name of an environment variable holding the key. */
  keyEnv: z.string().optional().describe('Environment variable that holds the master key'),
  /** Path of a file holding the key (needs a runtime file reader). */
  keyFile: z.string().optional().describe('File that holds the master key'),
});

const AwsKek = z.object({
  provider: z.literal('aws-kms'),
  region: z.string(),
  keyId: z.string().describe('KMS key id or ARN'),
  accessKeyId: z.string(),
  secretAccessKey: z.string(),
  sessionToken: z.string().optional(),
  endpoint: z.string().url().optional(),
});

const GcpKek = z.object({
  provider: z.literal('gcp-kms'),
  /** projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k> */
  keyName: z.string(),
  clientEmail: z.string(),
  privateKey: z.string().describe('Service account private key (PEM, PKCS#8)'),
  tokenUri: z.string().url().default('https://oauth2.googleapis.com/token'),
  endpoint: z.string().url().default('https://cloudkms.googleapis.com'),
});

const AzureKek = z.object({
  provider: z.literal('azure-keyvault'),
  vaultUrl: z.string().url().describe('e.g. https://my-vault.vault.azure.net'),
  keyName: z.string(),
  keyVersion: z.string().optional(),
  tenantId: z.string(),
  clientId: z.string(),
  clientSecret: z.string(),
  algorithm: z.enum(['RSA-OAEP-256', 'RSA-OAEP', 'A256KW']).default('RSA-OAEP-256'),
  authority: z.string().url().default('https://login.microsoftonline.com'),
  apiVersion: z.string().default('7.4'),
});

const VaultKek = z.object({
  provider: z.literal('vault-transit'),
  address: z.string().url().describe('e.g. https://vault.internal:8200'),
  token: z.string(),
  keyName: z.string(),
  mount: z.string().default('transit'),
  namespace: z.string().optional(),
});

export const KekConfigSchema = technical(
  z.discriminatedUnion('provider', [LocalKek, AwsKek, GcpKek, AzureKek, VaultKek]),
  'Key-encryption key (KEK) that wraps per-tenant AES-256-GCM data keys (envelope encryption).',
);
export type KekConfig = z.infer<typeof KekConfigSchema>;

export const KeyvaultConfigSchema = z
  .object({
    kek: KekConfigSchema.describe('Where the master key lives'),
    /** Older KEKs still accepted for unwrapping until `keyvault.rotate-kek` re-wraps everything. */
    previousKeks: z.array(KekConfigSchema).default([]),
    signing: z
      .object({
        perMinute: z.number().int().min(1).default(120).describe('Signatures per key per minute'),
        auditRetentionDays: z.number().int().min(1).default(365),
      })
      .prefault({}),
    destroyGraceDays: z
      .number()
      .int()
      .min(0)
      .default(30)
      .describe('Days before a scheduled key destruction happens'),
    bunker: z
      .object({
        enabled: z.boolean().default(true).describe('Let apps sign through the built-in bunker'),
        /** Relay that hosts bunker traffic; defaults to the first relay. */
        relayId: z.string().optional(),
        /** Public wss:// URL of that relay; derived from its first host when absent. */
        relayUrl: z.string().optional(),
        /** Kinds a bunker session may never sign. */
        deniedKinds: z.array(z.number().int()).default([]),
      })
      .prefault({}),
    escrow: technical(
      z
        .object({
          enabled: z.boolean().default(false).describe('Company can read managed-key DMs'),
          /** Relays where escrow applies; empty = all relays. */
          relays: z.array(z.string()).default([]),
          /** Testing only: allow escrow decrypts when no approvals service exists. */
          allowWithoutApprovals: z.boolean().default(false),
          notice: z
            .string()
            .default('Your messages on this workspace may be accessed for compliance.'),
        })
        .prefault({}),
      'NIP-17 gift wraps (1059) addressed to managed keys can be unwrapped (NIP-59 seal → rumor).',
    ),
    migrate: z
      .object({
        /** Wrap the alerts module's relay DM key (`alerts.keys`/`nostr`) on start. */
        alertsKey: z.boolean().default(true),
        /**
         * Wrap NIP-29 group signing keys (`relay.groups.key`). Off by default: the relay
         * must understand the `{ wrapped, provider }` record shape first.
         */
        relayGroupKeys: z.boolean().default(false),
      })
      .prefault({}),
  })
  .describe('Company key custody: master key, signing limits, bunker and DM escrow');

export type KeyvaultConfig = z.infer<typeof KeyvaultConfigSchema>;
