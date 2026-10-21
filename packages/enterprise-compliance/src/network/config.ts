// SPDX-License-Identifier: AGPL-3.0-or-later
/** `config.modules['enterprise-network']` — network controls (§12.10). */
import { example, labels, recommend, showWhen, technical } from '@beamhop/core';
import { z } from 'zod';
import { isValidCidr } from './cidr.ts';

export const NETWORK_MODULE_ID = 'enterprise-network';

const cidr = z
  .string()
  .refine(isValidCidr, 'Not an IP address or range (e.g. 10.0.0.0/8, 2001:db8::/32)');

const relayUrl = z
  .string()
  .trim()
  .regex(/^wss?:\/\/\S+$/i, 'Not a relay address (e.g. wss://relay.example.com)');

const ProxySecret = z
  .object({
    header: example(z.string().min(1).describe('Header your proxy adds'), 'x-proxy-secret'),
    value: z.string().min(16).describe('Secret value only your proxy knows'),
  })
  .describe('Shared secret that proves a request came through your proxy');

export const NetworkConfigSchema = z
  .object({
    adminPaths: technical(
      z
        .array(z.string())
        .default(['/api/', '/admin'])
        .describe(
          'Web addresses that count as the admin app. Only change this if you moved the admin app.',
        ),
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
      .prefault({})
      .describe('Limit access to company networks'),
    denylist: z
      .object({
        all: z
          .array(cidr)
          .default([])
          .describe('Networks that are always blocked, for the admin app and every relay'),
        relays: z
          .record(z.string(), z.array(cidr))
          .default({})
          .describe('Networks blocked from each relay'),
      })
      .prefault({})
      .describe('Block specific networks'),
    mtls: z
      .object({
        enabled: z.boolean().default(false).describe('Only company devices can connect'),
        scope: labels(z.enum(['admin', 'relays', 'all']).default('all'), {
          admin: 'Admin app only',
          relays: 'Relays only',
          all: 'Admin app and relays',
        }).describe('Where the company-device check applies.'),
        caPem: technical(
          z
            .string()
            .optional()
            .describe('Your company certificate authority that issues device certificates.'),
          'Company CA certificate(s), PEM',
        ),
        certHeader: technical(
          z
            .string()
            .default('x-client-cert')
            .describe(
              'Header your proxy uses to pass on the device certificate. Match your proxy setup.',
            ),
          'Header with the client certificate from the TLS-terminating proxy: URL-encoded PEM (nginx $ssl_client_escaped_cert, ALB), base64 DER, or Envoy XFCC (Cert="…").',
        ),
        verifyHeader: technical(
          example(
            z
              .string()
              .optional()
              .describe(
                'Header where your proxy reports whether the certificate checked out. Optional.',
              ),
            'x-ssl-client-verify',
          ),
          'Optional proxy verdict header, e.g. x-ssl-client-verify: SUCCESS.',
        ),
        proxySecret: ProxySecret.optional(),
        allowedSubjects: z
          .array(z.string())
          .default([])
          .describe('Only certificates whose subject contains one of these (all when empty)'),
      })
      .prefault({})
      .describe('Company devices only (client certificates)'),
    zeroTrust: z
      .object({
        provider: labels(
          z.enum(['off', 'google-iap', 'cloudflare-access', 'entra-app-proxy']).default('off'),
          {
            off: 'Off',
            'google-iap': 'Google Identity-Aware Proxy',
            'cloudflare-access': 'Cloudflare Access',
            'entra-app-proxy': 'Microsoft Entra application proxy',
          },
        ).describe('Identity-aware proxy in front of Beamhop'),
        scope: showWhen(
          recommend(
            labels(z.enum(['admin', 'all']).default('admin'), {
              admin: 'Admin app only',
              all: 'Admin app and relays',
            }),
            'admin',
            'Most Nostr apps cannot sign in through a company proxy.',
          ).describe('Where the company sign-in proxy is required.'),
          { path: 'provider', equals: ['google-iap', 'cloudflare-access', 'entra-app-proxy'] },
        ),
        audience: showWhen(
          technical(
            z
              .string()
              .optional()
              .describe('The ID your proxy puts in its sign-in tokens for this app.'),
            'Expected audience (IAP backend / Access AUD tag)',
          ),
          { path: 'provider', equals: ['google-iap', 'cloudflare-access'] },
        ),
        teamDomain: showWhen(
          example(
            z
              .string()
              .optional()
              .describe('Cloudflare Access team domain, e.g. acme.cloudflareaccess.com'),
            'acme.cloudflareaccess.com',
          ),
          { path: 'provider', equals: 'cloudflare-access' },
        ),
        jwksUrl: showWhen(
          technical(
            z
              .string()
              .url()
              .optional()
              .describe(
                'Where to fetch the proxy’s signing keys. Empty = the provider’s usual address.',
              ),
            'JWKS URL; defaults to Google IAP public keys or <teamDomain>/cdn-cgi/access/certs.',
          ),
          { path: 'provider', equals: ['google-iap', 'cloudflare-access'] },
        ),
        jwks: technical(
          z
            .object({
              keys: z
                .array(z.record(z.string(), z.unknown()))
                .describe('The signing keys, pasted in. Only for servers without internet access.'),
            })
            .optional()
            .describe('Signing keys pasted in directly instead of fetched.'),
          'Inline JWKS (air-gapped installs, tests); overrides jwksUrl.',
        ),
        userHeader: showWhen(
          technical(
            z
              .string()
              .default('x-ms-client-principal-name')
              .describe(
                'Header the Microsoft proxy uses to say who is signed in. Keep the default.',
              ),
            'Entra App Proxy header-based SSO: header carrying the signed-in user (UPN/email).',
          ),
          { path: 'provider', equals: 'entra-app-proxy' },
        ),
        proxySecret: ProxySecret.optional(),
        admins: z
          .record(z.string(), z.string())
          .default({})
          .describe('Email → admin account id for the admin app'),
      })
      .prefault({})
      .describe('Company sign-in proxy (zero trust)'),
    privateOnly: z
      .object({
        enabled: z
          .boolean()
          .default(false)
          .describe('Hide the landing and status pages; share only minimal relay info'),
        keepPortal: z.boolean().default(true).describe('Keep the self-service portal'),
      })
      .prefault({})
      .describe('Private-only mode'),
    outbound: technical(
      z
        .object({
          default: z
            .array(relayUrl)
            .describe('Other relays every group may also post to')
            .nullable()
            .default(null)
            .describe(
              'Other relays every group may also post to. Empty = only this relay. Not set = no limit.',
            ),
          groups: z
            .record(z.string(), z.array(relayUrl))
            .default({})
            .describe('Other relays each group may also post to (empty = only this relay)'),
        })
        .prefault({})
        .describe('Where team groups may post besides this relay'),
      'Per-group outbound relay allow (NIP-29 group id = h tag), published at GET /.well-known/beamhop/network for the team client. Enforced by the client; Beamhop itself never forwards group events to other relays.',
    ),
  })
  .prefault({});
export type NetworkConfig = z.infer<typeof NetworkConfigSchema>;
