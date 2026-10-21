// SPDX-License-Identifier: AGPL-3.0-or-later
import { example, recommend, technical } from '@beamhop/core';
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
      .describe(
        'How long a sign-in lasts before admins must sign in again. Shorter is safer on shared devices.',
      ),
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
    ).describe(
      'How often the secret key that protects sign-ins is replaced. The default suits almost everyone.',
    ),
    undoWindowSeconds: z
      .number()
      .int()
      .min(30)
      .max(3600)
      .default(300)
      .describe('How long after a change you can still undo it with one tap.'),
    passkeys: z
      .object({
        rpId: technical(
          z.string().optional(),
          'WebAuthn relying party id; defaults to the request host name.',
        ).describe(
          'The domain passkeys are tied to. Leave empty unless the admin app is reached under several names.',
        ),
        rpName: z
          .string()
          .default('Beamhop')
          .describe('Name shown by your device when you create a passkey.'),
        origins: technical(
          z.array(z.string()).default([]),
          'Extra allowed WebAuthn origins (e.g. the admin app origin when served elsewhere).',
        ).describe(
          'Extra web addresses allowed to use passkeys. Only needed when the admin app is hosted elsewhere.',
        ),
      })
      .prefault({})
      .describe('Passkeys (sign in with your fingerprint, face or device PIN)'),
    tokens: z
      .object({
        maxDays: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .default(365)
          .describe('Longest allowed lifetime for API tokens used by scripts and other tools.'),
      })
      .prefault({})
      .describe('API tokens for scripts and integrations'),
    live: z
      .object({
        heartbeatSeconds: technical(
          z
            .number()
            .int()
            .min(5)
            .max(300)
            .default(25)
            .describe(
              "How often the admin app's live view checks the connection is still alive, in seconds. Lower it if a proxy cuts idle connections.",
            ),
          'Interval of SSE keep-alive comments on the live stream.',
        ),
      })
      .prefault({})
      .describe('Live updates in the admin app'),
  })
  .prefault({})
  .describe('Admin app sign-in and safety settings');

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
