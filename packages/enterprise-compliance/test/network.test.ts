// SPDX-License-Identifier: AGPL-3.0-or-later
import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import { type RouteContext, defineModule, runRequestGates } from '@beamhop/core';
import * as x509 from '@peculiar/x509';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { IpAllowlist, cidrContains, parseCidr, parseIp } from '../src/network/cidr.ts';
import { networkModule } from '../src/network/module.ts';
import { MtlsVerifier, decodeCertHeader } from '../src/network/mtls.ts';
import { makeKernel } from './helpers.ts';

describe('CIDR matching', () => {
  const m = (cidr: string, ip: string) => cidrContains(parseCidr(cidr)!, parseIp(ip)!);
  test('IPv4', () => {
    expect(m('10.0.0.0/8', '10.255.255.255')).toBe(true);
    expect(m('10.0.0.0/8', '11.0.0.0')).toBe(false);
    expect(m('192.168.1.7', '192.168.1.7')).toBe(true);
    expect(m('192.168.1.7/32', '192.168.1.8')).toBe(false);
    expect(m('0.0.0.0/0', '8.8.8.8')).toBe(true);
    expect(m('172.16.0.0/12', '172.31.255.1')).toBe(true);
    expect(m('172.16.0.0/12', '172.32.0.1')).toBe(false);
    expect(m('10.1.2.3/23', '10.1.3.200')).toBe(true); // host bits normalised
    expect(m('10.1.2.3/23', '10.1.4.0')).toBe(false);
  });
  test('IPv6, compression, embedded v4, zones, brackets', () => {
    expect(m('2001:db8::/32', '2001:db8:ffff::1')).toBe(true);
    expect(m('2001:db8::/32', '2001:db9::1')).toBe(false);
    expect(m('::1', '0:0:0:0:0:0:0:1')).toBe(true);
    expect(m('fe80::/10', 'fe80::1%eth0')).toBe(true);
    expect(m('fe80::/10', 'febf::1')).toBe(true);
    expect(m('fe80::/10', 'fec0::1')).toBe(false);
    expect(m('2001:db8::/127', '[2001:db8::1]:443')).toBe(true);
    expect(m('64:ff9b::/96', '64:ff9b::192.0.2.33')).toBe(true);
  });
  test('IPv4-mapped IPv6 and mixed families', () => {
    expect(m('10.0.0.0/8', '::ffff:10.1.2.3')).toBe(true);
    expect(m('::ffff:10.0.0.0/104', '10.9.9.9')).toBe(true);
    expect(m('10.0.0.0/8', '10.0.0.1:5000')).toBe(true);
    expect(m('::/0', '10.0.0.1')).toBe(false);
    expect(m('0.0.0.0/0', '2001:db8::1')).toBe(false);
  });
  test('invalid input', () => {
    for (const bad of [
      '10.0.0.256',
      '10.0.0',
      '010.0.0.1',
      '1::2::3',
      '10.0.0.0/33',
      '::/129',
      'x',
      '1:2:3:4:5:6:7:8:9',
    ])
      expect(parseCidr(bad)).toBeNull();
    expect(() => new IpAllowlist(['nope'])).toThrow();
    const list = new IpAllowlist(['10.0.0.0/8']);
    expect(list.allows(undefined)).toBe(false);
    expect(list.allows('garbage')).toBe(false);
    expect(new IpAllowlist([]).allows(undefined)).toBe(true);
  });
});

async function makeCa(name: string, notAfter = new Date(Date.now() + 86400e3)) {
  const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
  const keys = (await crypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    name: `CN=${name}`,
    keys,
    signingAlgorithm: alg,
    notBefore: new Date(Date.now() - 3600e3),
    notAfter,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  return { cert, keys, alg };
}

async function issue(
  ca: Awaited<ReturnType<typeof makeCa>>,
  cn: string,
  notAfter = new Date(Date.now() + 86400e3),
) {
  const keys = (await crypto.subtle.generateKey(ca.alg, true, ['sign', 'verify'])) as CryptoKeyPair;
  return x509.X509CertificateGenerator.create({
    subject: `CN=${cn}, O=Acme`,
    issuer: ca.cert.subject,
    publicKey: keys.publicKey,
    signingKey: ca.keys.privateKey,
    signingAlgorithm: ca.alg,
    notBefore: new Date(Date.now() - 3600e3),
    notAfter,
  });
}

describe('mTLS device certificates', () => {
  test('accepts company-issued certs in proxy header formats; rejects others', async () => {
    const ca = await makeCa('Acme Device CA');
    const evil = await makeCa('Acme Device CA'); // same name, different key
    const good = await issue(ca, 'laptop-1');
    const forged = await issue(evil, 'laptop-2');
    const expired = await issue(ca, 'old', new Date(Date.now() - 1000));
    const v = new MtlsVerifier(ca.cert.toString('pem'));
    const pem = good.toString('pem');
    expect((await v.verifyHeader(encodeURIComponent(pem))).ok).toBe(true); // nginx escaped
    expect((await v.verifyHeader(pem.replace(/\n/g, ' '))).ok).toBe(true); // spaces
    expect((await v.verifyHeader(good.toString('base64'))).ok).toBe(true); // DER base64
    expect(
      (
        await v.verifyHeader(
          `By=spiffe://x;Hash=abc;Cert="${encodeURIComponent(pem)}";Subject="CN=laptop-1"`,
        )
      ).ok,
    ).toBe(true); // Envoy XFCC
    const bad = await v.verifyHeader(encodeURIComponent(forged.toString('pem')));
    expect(bad).toMatchObject({
      ok: false,
      reason: 'The device certificate is not from your company CA',
    });
    expect((await v.verifyHeader(expired.toString('pem'))).reason).toContain('expired');
    expect((await v.verifyHeader(null)).ok).toBe(false);
    expect((await v.verifyHeader('%%%')).ok).toBe(false);
    const subj = new MtlsVerifier(ca.cert.toString('pem'), { allowedSubjects: ['CN=laptop-9'] });
    expect((await subj.verifyHeader(pem)).reason).toContain('not allowed');
    expect(decodeCertHeader('')).toBeNull();
  });

  test('gate enforces mTLS for admin paths with a proxy secret', async () => {
    const ca = await makeCa('Acme Device CA');
    const good = await issue(ca, 'laptop-1');
    const { kernel, ports } = await makeKernel({
      compliance: false,
      extra: [networkModule],
      modules: {
        'enterprise-network': {
          mtls: {
            enabled: true,
            scope: 'admin',
            caPem: ca.cert.toString('pem'),
            proxySecret: { header: 'x-proxy-secret', value: 'p'.repeat(20) },
          },
        },
      },
    });
    ports.clock.ms = Date.now(); // certificates are issued against wall-clock time
    const route: RouteContext = { relayId: '', publicUrl: 'https://relay.test', ipHash: 'h' };
    const req = (h: Record<string, string>) =>
      new Request('https://relay.test/api/v1/me', { headers: h });
    const run = (r: Request) =>
      runRequestGates(kernel, r, { route, upgrade: false, clientIp: () => '1.2.3.4' });
    expect((await run(req({})))?.status).toBe(403);
    // Cert without the proxy secret is not trusted.
    expect(
      (await run(req({ 'x-client-cert': encodeURIComponent(good.toString('pem')) })))?.status,
    ).toBe(403);
    expect(
      await run(
        req({
          'x-client-cert': encodeURIComponent(good.toString('pem')),
          'x-proxy-secret': 'p'.repeat(20),
        }),
      ),
    ).toBeUndefined();
    // Relay paths are not in scope.
    const relayRoute: RouteContext = {
      relayId: 'main',
      publicUrl: 'https://relay.test',
      ipHash: 'h',
    };
    expect(
      await runRequestGates(kernel, new Request('https://relay.test/'), {
        route: relayRoute,
        upgrade: true,
      }),
    ).toBeUndefined();
  });
});

describe('zero-trust proxies', () => {
  async function iapEnv(provider: 'google-iap' | 'cloudflare-access') {
    const alg = provider === 'google-iap' ? 'ES256' : 'RS256';
    const { publicKey, privateKey } = await generateKeyPair(alg, { extractable: true });
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg };
    const issuer =
      provider === 'google-iap'
        ? 'https://cloud.google.com/iap'
        : 'https://acme.cloudflareaccess.com';
    const audience = provider === 'google-iap' ? '/projects/1/global/backendServices/2' : 'aud-tag';
    const sessions: string[] = [];
    const { kernel, ports } = await makeKernel({
      compliance: false,
      extra: [
        networkModule,
        defineModule({
          id: 'admin-stub',
          register(k) {
            k.provide('admin.directory', {
              get: async (id: string) =>
                id === 'admin-1' ? { id, roles: { '*': 'owner' } } : null,
              principalOf: (rec: { id: string; roles: Record<string, 'owner'> }, via: 'sso') => ({
                id: rec.id,
                roles: rec.roles,
                via,
              }),
            });
            k.provide('admin.sessions', {
              issue: async (id: string) => {
                sessions.push(id);
                return { token: 'sess', expiresAt: 1 };
              },
            });
          },
        }),
      ],
      modules: {
        'enterprise-network': {
          zeroTrust: {
            provider,
            audience,
            teamDomain: 'acme.cloudflareaccess.com',
            jwks: { keys: [jwk] },
            admins: { 'alice@acme.com': 'admin-1' },
          },
        },
      },
    });
    const now = ports.clock.now();
    const sign = (
      claims: Record<string, unknown>,
      opts: { iss?: string; aud?: string; exp?: number } = {},
    ) =>
      new SignJWT({ email: 'alice@acme.com', ...claims })
        .setProtectedHeader({ alg, kid: 'k1' })
        .setIssuer(opts.iss ?? issuer)
        .setAudience(opts.aud ?? audience)
        .setSubject('user-123')
        .setIssuedAt(now)
        .setExpirationTime(opts.exp ?? now + 600)
        .sign(privateKey);
    const header =
      provider === 'google-iap' ? 'x-goog-iap-jwt-assertion' : 'cf-access-jwt-assertion';
    return { kernel, sign, header, sessions, now };
  }

  for (const provider of ['google-iap', 'cloudflare-access'] as const) {
    test(`${provider}: valid assertion passes, maps to an admin principal and session`, async () => {
      const { kernel, sign, header, sessions } = await iapEnv(provider);
      const route: RouteContext = { relayId: '', publicUrl: 'https://relay.test', ipHash: 'h' };
      const token = await sign({});
      const req = new Request('https://relay.test/api/v1/me', { headers: { [header]: token } });
      expect(await runRequestGates(kernel, req, { route, upgrade: false })).toBeUndefined();
      const p = kernel.authProviders.find((a) => a.id === 'zero-trust')!;
      expect((await p.authenticate(req))?.id).toBe('admin-1');
      const res = await kernel.http.fetch(
        new Request('https://relay.test/api/zero-trust/session', {
          method: 'POST',
          headers: { [header]: token },
        }),
        { route },
      );
      expect(res.status).toBe(200);
      expect(sessions).toEqual(['admin-1']);
      const none = new Request('https://relay.test/api/v1/me');
      expect((await runRequestGates(kernel, none, { route, upgrade: false }))?.status).toBe(401);
    });

    test(`${provider}: wrong audience, issuer, expiry or key is rejected`, async () => {
      const { kernel, sign, header, now } = await iapEnv(provider);
      const route: RouteContext = { relayId: '', publicUrl: 'https://relay.test', ipHash: 'h' };
      const check = async (t: string) =>
        (
          await runRequestGates(
            kernel,
            new Request('https://relay.test/admin/', { headers: { [header]: t } }),
            {
              route,
              upgrade: false,
            },
          )
        )?.status;
      expect(await check(await sign({}, { aud: 'other' }))).toBe(401);
      expect(await check(await sign({}, { iss: 'https://evil.example' }))).toBe(401);
      expect(await check(await sign({}, { exp: now - 3600 }))).toBe(401);
      const { privateKey } = await generateKeyPair(provider === 'google-iap' ? 'ES256' : 'RS256');
      const forged = await new SignJWT({ email: 'alice@acme.com' })
        .setProtectedHeader({ alg: provider === 'google-iap' ? 'ES256' : 'RS256', kid: 'k1' })
        .setIssuedAt(now)
        .setExpirationTime(now + 60)
        .sign(privateKey);
      expect(await check(forged)).toBe(401);
      // Relay traffic is not in scope 'admin'.
      const relayRoute: RouteContext = {
        relayId: 'main',
        publicUrl: 'https://relay.test',
        ipHash: 'h',
      };
      expect(
        await runRequestGates(kernel, new Request('https://relay.test/'), {
          route: relayRoute,
          upgrade: true,
        }),
      ).toBeUndefined();
    });
  }

  test('entra app proxy: header trusted only with the proxy secret', async () => {
    const { kernel } = await makeKernel({
      compliance: false,
      extra: [networkModule],
      modules: {
        'enterprise-network': {
          zeroTrust: {
            provider: 'entra-app-proxy',
            proxySecret: { header: 'x-ap-secret', value: 's'.repeat(16) },
          },
        },
      },
    });
    const route: RouteContext = { relayId: '', publicUrl: 'https://relay.test', ipHash: 'h' };
    const run = (h: Record<string, string>) =>
      runRequestGates(kernel, new Request('https://relay.test/api/x', { headers: h }), {
        route,
        upgrade: false,
      });
    expect((await run({ 'x-ms-client-principal-name': 'alice@acme.com' }))?.status).toBe(401);
    expect(
      await run({ 'x-ms-client-principal-name': 'alice@acme.com', 'x-ap-secret': 's'.repeat(16) }),
    ).toBeUndefined();
  });
});

describe('IP allowlists and private-only mode via the request gate', () => {
  async function env(extra: Record<string, unknown>) {
    return makeKernel({
      compliance: false,
      extra: [networkModule],
      modules: { 'enterprise-network': extra },
      relays: [
        { id: 'main', hosts: ['relay.test'], info: { name: 'Acme', description: 'secret team' } },
      ],
    });
  }
  const relayRoute: RouteContext = {
    relayId: 'main',
    publicUrl: 'https://relay.test',
    ipHash: 'h',
  };
  const nodeRoute: RouteContext = { relayId: '', publicUrl: 'https://relay.test', ipHash: 'h' };

  test('relay and admin allowlists (HTTP + WebSocket), fail closed without an IP', async () => {
    const { kernel, ports } = await env({
      allowlist: { admin: ['10.0.0.0/8'], relays: { main: ['192.168.0.0/16', '2001:db8::/32'] } },
    });
    const ws = new Request('https://relay.test/', { headers: { upgrade: 'websocket' } });
    const gate = (r: Request, route: RouteContext, ip?: string, upgrade = false) =>
      runRequestGates(kernel, r, { route, upgrade, clientIp: () => ip });
    expect(await gate(ws, relayRoute, '192.168.4.4', true)).toBeUndefined();
    expect(await gate(ws, relayRoute, '2001:db8::5', true)).toBeUndefined();
    expect((await gate(ws, relayRoute, '8.8.8.8', true))?.status).toBe(403);
    expect((await gate(ws, relayRoute, undefined, true))?.status).toBe(403);
    const admin = new Request('https://relay.test/api/v1/nodes/n/relays/main/actions');
    expect((await gate(admin, relayRoute, '192.168.4.4'))?.status).toBe(403); // admin list applies
    expect(await gate(admin, nodeRoute, '10.2.3.4')).toBeUndefined();
    // Raw IPs are never logged.
    expect(JSON.stringify(ports.logger.lines)).not.toContain('8.8.8.8');
  });

  test('private-only: landing/status hidden, NIP-11 minimal, WS + portal untouched', async () => {
    const { kernel } = await env({ privateOnly: { enabled: true } });
    const gate = (r: Request, upgrade = false) =>
      runRequestGates(kernel, r, { route: relayRoute, upgrade });
    expect((await gate(new Request('https://relay.test/')))?.status).toBe(404);
    expect((await gate(new Request('https://relay.test/status')))?.status).toBe(404);
    expect(await gate(new Request('https://relay.test/portal'))).toBeUndefined();
    expect(
      await gate(new Request('https://relay.test/', { headers: { upgrade: 'websocket' } }), true),
    ).toBeUndefined();
    const nip11 = await gate(
      new Request('https://relay.test/', { headers: { accept: 'application/nostr+json' } }),
    );
    const doc = await nip11!.json();
    expect(doc.name).toBe('Acme');
    expect(doc.description).toBeUndefined();
    expect(doc.pubkey).toBeUndefined();
  });
});
