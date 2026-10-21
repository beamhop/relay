// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `config.modules['enterprise-identity']` — the single optional enterprise
 * identity block (§12.0.3). Absent by default; nothing here is read unless the
 * module is enabled.
 */
import { example, labels, recommend, showWhen, technical } from '@beamhop/core';
import { z } from 'zod';

export const MODULE_ID = 'enterprise-identity';

export const KeyModelSchema = labels(z.enum(['self-custody', 'managed']), {
  'self-custody': 'Employees keep their own key',
  managed: 'The company keeps keys for employees',
}).describe('Who holds the signing key: the employee (self-custody) or the company (managed)');
export type KeyModel = z.infer<typeof KeyModelSchema>;

export const AudienceSchema = labels(z.enum(['admin', 'team']), {
  admin: 'Admins (admin app)',
  team: 'Employees (team app)',
});
export type Audience = z.infer<typeof AudienceSchema>;

export const IdpSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/)
      .describe('Short id used in sign-in links, e.g. "google" or "entra"'),
    type: labels(z.enum(['google', 'microsoft', 'oidc']), {
      google: 'Google Workspace',
      microsoft: 'Microsoft Entra ID (Azure AD)',
      oidc: 'Other (Okta, Keycloak, any OpenID Connect provider)',
    }).describe('Kind of company directory'),
    label: z.string().optional().describe('Button text, e.g. "Sign in with Contoso"'),
    clientId: z.string().min(1).describe('Application (client) id from the identity provider'),
    clientSecret: z.string().optional().describe('Client secret from the identity provider'),
    issuer: showWhen(
      example(
        technical(
          z.string().url().optional(),
          'OIDC issuer identifier; discovery at <issuer>/.well-known/openid-configuration. Required for type "oidc".',
        ).describe('Sign-in address of your identity provider'),
        'https://login.example.com/realms/company',
      ),
      { path: 'type', equals: 'oidc' },
    ),
    tenant: showWhen(
      example(
        technical(
          z.string().optional(),
          'Microsoft Entra tenant id (GUID) or verified domain; issuer https://login.microsoftonline.com/<tenant>/v2.0',
        ).describe('Your Microsoft tenant'),
        'contoso.onmicrosoft.com',
      ),
      { path: 'type', equals: 'microsoft' },
    ),
    hostedDomain: showWhen(
      example(
        technical(
          z.string().optional(),
          'Google Workspace `hd` restriction: sent as auth param and enforced on the ID token `hd` claim.',
        ).describe('Only people from this Google Workspace domain can sign in'),
        'company.com',
      ),
      { path: 'type', equals: 'google' },
    ),
    scopes: technical(
      z
        .array(z.string())
        .default(['openid', 'email', 'profile'])
        .describe(
          'What information is requested from the provider at sign-in. The default is right for most setups.',
        ),
      'OAuth scopes requested in the authorization request.',
    ),
    groupsClaim: technical(
      z
        .string()
        .default('groups')
        .describe(
          'Where the provider lists the groups a person belongs to. Change only if your provider uses another name.',
        ),
      'ID token claim carrying group ids/names (Entra: `groups` object ids; Keycloak/Okta: names).',
    ),
    audiences: z
      .array(AudienceSchema)
      .default(['admin', 'team'])
      .describe('Who may sign in with it: admins (admin app), employees (team app), or both'),
    allowInsecure: recommend(
      technical(
        z
          .boolean()
          .default(false)
          .describe('Allow a provider address without encryption (http). Only for local testing.'),
        'Allow http:// issuer (local development/test IdPs only).',
      ),
      false,
      'Unencrypted sign-in can be intercepted.',
    ),
  })
  .describe('A company sign-in provider');
export type IdpConfig = z.infer<typeof IdpSchema>;

const Inner = z.object({
  /** Set by the schema: false when the section was absent/empty (isolation guard). */
  configured: technical(
    z
      .boolean()
      .describe('Set automatically: whether company sign-in has been set up. You never change it.'),
    'Derived on parse: false when the section was absent or empty (isolation guard).',
  ),
  enabled: z
    .boolean()
    .default(true)
    .describe('Turn company sign-in on or off without losing its settings.'),
  publicUrl: example(
    technical(
      z.string().url().optional(),
      'Base URL used for redirect URIs and the SCIM endpoint. Defaults to the request origin.',
    ).describe('Public web address of this server'),
    'https://relay.company.com',
  ),
  idps: z
    .array(IdpSchema)
    .default([])
    .describe('Company sign-in providers people can use (Google, Microsoft, Okta…).'),
  relays: technical(
    z.array(z.string()).default([]),
    'Relay ids where the SSO binding access resolver decides read/write (NIP-42 AUTH pubkey must have an active binding).',
  ).describe('Relays that only company members can use'),
  unboundAccess: technical(
    labels(z.enum(['deny', 'defer']).default('deny'), {
      deny: 'Keep them out',
      defer: 'Let the relay’s other access rules decide',
    }),
    'deny: pubkeys without an active binding are refused on enterprise relays; defer: other access rules decide.',
  ).describe('What happens to people who are not in the company directory'),
  defaultKeyModel: KeyModelSchema.default('self-custody'),
  teamSessionTtlSeconds: z
    .number()
    .int()
    .min(300)
    .default(8 * 3600)
    .describe(
      'How long employees stay signed in to the team app, in seconds. Shorter is safer, longer is more convenient.',
    ),
  teamAppPath: example(
    z
      .string()
      .default('/app')
      .describe(
        'Web path where the team app is served. Change only if it clashes with another page.',
      ),
    '/app',
  ),
  adminAppPath: example(
    z
      .string()
      .default('/admin')
      .describe(
        'Web path where the admin app is served. Change only if it clashes with another page.',
      ),
    '/admin',
  ),
  nip05: z
    .object({
      enabled: z.boolean().default(true).describe('Give employees name@company addresses'),
      domain: example(
        technical(
          z.string().optional(),
          'NIP-05 domain: only bound emails at this domain are served from /.well-known/nostr.json.',
        ).describe('Company email domain, e.g. company.com'),
        'company.com',
      ),
    })
    .prefault({})
    .describe('Company addresses (name@company) for employees'),
  scim: technical(
    z
      .object({
        enabled: z.boolean().default(true).describe('Let Microsoft Entra / Okta push users here'),
      })
      .prefault({})
      .describe('Automatic user sync pushed from your directory'),
    'SCIM 2.0 provisioning endpoint.',
  ),
  google: z
    .object({
      directorySync: z
        .object({
          enabled: z
            .boolean()
            .default(false)
            .describe(
              'Regularly copy people and groups from Google Workspace, and remove people who leave.',
            ),
          idp: showWhen(
            z.string().default('google').describe('Which sign-in provider these people use'),
            { path: 'enabled', equals: true },
          ),
          serviceAccountEmail: showWhen(
            example(
              technical(
                z
                  .string()
                  .optional()
                  .describe('The email of the Google service account created for this sync.'),
                'Service account with domain-wide delegation for the Admin SDK Directory API.',
              ),
              'beamhop-sync@my-project.iam.gserviceaccount.com',
            ),
            { path: 'enabled', equals: true },
          ),
          privateKey: showWhen(
            technical(
              z
                .string()
                .optional()
                .describe(
                  'The private key of that service account (from its key file). Stored privately.',
                ),
              'Service account PKCS#8 PEM private key (RS256, domain-wide delegation).',
            ),
            { path: 'enabled', equals: true },
          ),
          adminEmail: showWhen(
            example(
              z
                .string()
                .optional()
                .describe('A Workspace admin the sync acts as (domain-wide delegation)'),
              'it-admin@company.com',
            ),
            { path: 'enabled', equals: true },
          ),
          customer: showWhen(
            technical(
              z
                .string()
                .default('my_customer')
                .describe('Which Google Workspace account to read. The default means your own.'),
              'Admin SDK `customer` parameter; my_customer = the account of the admin user.',
            ),
            { path: 'enabled', equals: true },
          ),
          intervalMinutes: showWhen(
            z
              .number()
              .int()
              .min(5)
              .max(1440)
              .default(15)
              .describe(
                'How often to sync, in minutes. Lower means people who leave lose access sooner.',
              ),
            { path: 'enabled', equals: true },
          ),
        })
        .prefault({})
        .describe('Sync people and groups from Google Workspace'),
    })
    .prefault({})
    .describe('Google Workspace'),
  offboarding: z
    .object({
      keyDestructionGraceDays: technical(
        z.number().int().min(0).max(3650).default(30),
        'Managed keys are crypto-shredded after this grace period; blocked while under legal hold.',
      ).describe('Days before a departed employee’s managed key is destroyed'),
      successorPubkey: technical(
        z
          .string()
          .regex(/^[0-9a-f]{64}$/)
          .optional()
          .describe('Who receives groups and files when a manager is unknown'),
        'Hex pubkey.',
      ),
    })
    .prefault({})
    .describe('What happens when someone leaves the company'),
  profileSync: z.boolean().default(true).describe('Copy name, title and photo from the directory'),
  groupSync: z.boolean().default(true).describe('Turn directory groups into chat channels'),
});

/**
 * Schema for `config.modules['enterprise-identity']`. The kernel parses `{}` when
 * the section is absent, so `configured` records whether the admin actually wrote
 * the section (an empty object counts as absent). Re-parsing parsed output keeps it.
 */
export const EnterpriseIdentityConfigSchema = z.preprocess((raw) => {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  const r = obj as Record<string, unknown>;
  if (typeof r.configured !== 'boolean') r.configured = Object.keys(obj).length > 0;
  return r;
}, Inner);
export type EnterpriseIdentityConfig = z.infer<typeof Inner>;

export function parseEnterpriseConfig(raw: unknown): EnterpriseIdentityConfig {
  return EnterpriseIdentityConfigSchema.parse(raw) as EnterpriseIdentityConfig;
}
