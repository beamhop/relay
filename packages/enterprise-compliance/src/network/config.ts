// SPDX-License-Identifier: AGPL-3.0-or-later
/** `config.modules['enterprise-network']` — network controls (§12.10). */
import { technical } from '@beamhop/core';
import { z } from 'zod';
import { isValidCidr } from './cidr.ts';

export const NETWORK_MODULE_ID = 'enterprise-network';

const cidr = z
  .string()
  .refine(isValidCidr, 'Not an IP address or range (e.g. 10.0.0.0/8, 2001:db8::/32)');

const ProxySecret = z
  .object({
    header: z.string().min(1).describe('Header your proxy adds'),
    value: z.string().min(16).describe('Secret value only your proxy knows'),
  })
  .describe('Shared secret that proves a request came through your proxy');

export const NetworkConfigSchema = z
  .object({
    adminPaths: technical(
      z.array(z.string()).default(['/api/', '/admin']),
      'Path prefixes treated as the admin app/API (node scope).',
    ),
    allowlist: z
      .object({
        admin: z
          .array(cidr)
          .default([])
          .describe('Networks allowed to open the admin app (everyone when empty)'),
        relays: z
          .record(z.string(), z.array(cidr))
          .default({})
          .describe('Networks allowed to use each relay (everyone when empty)'),
      })
      .prefault({}),
    mtls: z
      .object({
        enabled: z.boolean().default(false).describe('Only company devices can connect'),
        scope: z.enum(['admin', 'relays', 'all']).default('all'),
        caPem: z.string().optional().describe('Company CA certificate(s), PEM'),
        certHeader: technical(
          z.string().default('x-client-cert'),
          'Header with the client certificate from the TLS-terminating proxy: URL-encoded PEM (nginx $ssl_client_escaped_cert, ALB), base64 DER, or Envoy XFCC (Cert="…").',
        ),
        verifyHeader: technical(
          z.string().optional(),
          'Optional proxy verdict header, e.g. x-ssl-client-verify: SUCCESS.',
        ),
        proxySecret: ProxySecret.optional(),
        allowedSubjects: z
          .array(z.string())
          .default([])
          .describe('Only certificates whose subject contains one of these (all when empty)'),
      })
      .prefault({}),
    zeroTrust: z
      .object({
        provider: z
          .enum(['off', 'google-iap', 'cloudflare-access', 'entra-app-proxy'])
          .default('off')
          .describe('Identity-aware proxy in front of Beamhop'),
        scope: z.enum(['admin', 'all']).default('admin'),
        audience: z
          .string()
          .optional()
          .describe('Expected audience (IAP backend / Access AUD tag)'),
        teamDomain: z
          .string()
          .optional()
          .describe('Cloudflare Access team domain, e.g. acme.cloudflareaccess.com'),
        jwksUrl: z.string().url().optional(),
        jwks: technical(
          z.object({ keys: z.array(z.record(z.string(), z.unknown())) }).optional(),
          'Inline JWKS (air-gapped installs, tests); overrides jwksUrl.',
        ),
        userHeader: technical(
          z.string().default('x-ms-client-principal-name'),
          'Entra App Proxy header-based SSO: header carrying the signed-in user (UPN/email).',
        ),
        proxySecret: ProxySecret.optional(),
        admins: z
          .record(z.string(), z.string())
          .default({})
          .describe('Email → admin account id for the admin app'),
      })
      .prefault({}),
    privateOnly: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe('Hide the landing and status pages; share only minimal relay info'),
        keepPortal: z.boolean().default(true).describe('Keep the self-service portal'),
      })
      .prefault({}),
  })
  .prefault({});
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;
