// SPDX-License-Identifier: AGPL-3.0-or-later
import { technical } from '@beamhop/core';
import { z } from 'zod';

export const MODULE_ID = 'admin-api';

/** `config.modules['admin-api']`. */
export const AdminApiConfigSchema = z
  .object({
    sessionTtlSeconds: z
      .number()
      .int()
      .min(300)
      .default(12 * 3600)
      .describe('How long a sign-in lasts before admins must sign in again'),
    sessionMaxAgeSeconds: technical(
      z
        .number()
        .int()
        .min(300)
        .default(7 * 86400),
      'Absolute max age of a session JWT across sliding refreshes (POST …/session/refresh); measured from auth_time.',
    ).describe('Longest time someone can stay signed in without signing in again'),
    keyRotationDays: technical(
      z.number().int().min(1).max(365).default(7),
      'HS256 session signing key rotation period; previous keys stay valid for one session lifetime.',
    ).describe('How often the sign-in signing key is replaced'),
    undoWindowSeconds: z
      .number()
      .int()
      .min(30)
      .max(3600)
      .default(300)
      .describe('How long you can undo a change'),
    passkeys: z
      .object({
        rpId: technical(
          z.string().optional(),
          'WebAuthn relying party id; defaults to the request host name.',
        ).describe('Domain passkeys are tied to'),
        rpName: z.string().default('Beamhop').describe('Name shown when creating a passkey'),
        origins: technical(
          z.array(z.string()).default([]),
          'Extra allowed WebAuthn origins (e.g. the admin app origin when served elsewhere).',
        ).describe('Extra web addresses allowed to use passkeys'),
      })
      .prefault({}),
    tokens: z
      .object({
        maxDays: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .default(365)
          .describe('Longest allowed lifetime for API tokens'),
      })
      .prefault({}),
    live: z
      .object({
        heartbeatSeconds: z.number().int().min(5).max(300).default(25),
      })
      .prefault({}),
  })
  .prefault({});

export type AdminApiConfig = z.infer<typeof AdminApiConfigSchema>;

/** DocStore collections owned by this module. */
export const COL = {
  admins: 'admin.admins',
  invites: 'admin.invites',
  claim: 'admin.claim',
  recovery: 'admin.recovery',
  keys: 'admin.keys',
  revoked: 'admin.revoked-sessions',
  passkeys: 'admin.passkeys',
  challenges: 'admin.webauthn-challenges',
  tokens: 'admin.tokens',
  nip98Seen: 'admin.nip98-seen',
  undo: 'admin.undo',
  audit: 'admin.audit',
  notes: 'admin.notes',
  revisions: 'admin.config-revisions',
  configMeta: 'admin.config-meta',
  proposals: 'admin.config-proposals',
} as const;
