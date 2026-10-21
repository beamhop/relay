// SPDX-License-Identifier: AGPL-3.0-or-later
/** Network deny lists, outbound relay policy and Cloudflare-specific behaviour. */
import 'reflect-metadata';
import { describe, expect, test } from 'bun:test';
import { type RouteContext, defineModule, runRequestGates } from '@beamhop/core';
import * as x509 from '@peculiar/x509';
import { complianceInternals } from '../src/module.ts';
import { NetworkConfigSchema } from '../src/network/config.ts';
import {
  NETWORK_POLICY_PATH,
  networkModule,
  outboundAllowed,
  trustsProxyHeaders,
} from '../src/network/module.ts';
import { BACKGROUND_SERVICE, type BackgroundTasksLike } from '../src/runtime.ts';
import { makeKernel } from './helpers.ts';

const relayRoute: RouteContext = { relayId: 'main', publicUrl: 'https://relay.test', ipHash: 'h' };
const nodeRoute: RouteContext = { relayId: '', publicUrl: 'https://relay.test', ipHash: 'h' };

function network(extra: Record<string, unknown>, runtime: 'test' | 'cloudflare' = 'test') {
  return makeKernel({
    compliance: false,
    extra: [networkModule],
    modules: { 'enterprise-network': extra },
    runtime,
    config: { node: { trustProxy: true } },
  });
}

describe('IP deny lists', () => {
  test('deny list wins over allowlists, per relay and everywhere; never logs raw IPs', async () => {
    const lines: string[] = [];
    const { kernel } = await makeKernel({
      compliance: false,
      extra: [networkModule],
      modules: {
        'enterprise-network': {
          allowlist: { relays: { main: ['10.0.0.0/8'] } },
          denylist: { all: ['10.6.6.0/24'], relays: { main: ['10.7.0.0/16'] } },
        },
      },
      ports: {
        logger: {
          log: (_l, msg, f) => lines.push(`${msg} ${JSON.stringify(f ?? {})}`),
          child() {
            return this;
          },
        },
      },
    });
    const gate = (route: RouteContext, ip?: string, path = '/') =>
      runRequestGates(kernel, new Request(`https://relay.test${path}`), {
        route,
        upgrade: false,
        clientIp: () => ip,
      });
    expect(await gate(relayRoute, '10.1.1.1')).toBeUndefined();
    expect((await gate(relayRoute, '10.6.6.6'))?.status).toBe(403);
    expect((await gate(relayRoute, '10.7.1.1'))?.status).toBe(403);
    expect((await gate(nodeRoute, '10.6.6.6', '/api/x'))?.status).toBe(403); // `all` covers admin
    expect(await gate(nodeRoute, '10.7.1.1', '/api/x')).toBeUndefined(); // relay list does not
    expect(lines.some((l) => l.includes('deny list'))).toBe(true);
    expect(lines.some((l) => l.includes('10.6.6.6') || l.includes('10.7.1.1'))).toBe(false);
  });

  test('defaults: no deny list, no outbound policy', () => {
    const cfg = NetworkConfigSchema.parse({});
    expect(cfg.denylist).toEqual({ all: [], relays: {} });
    expect(cfg.outbound).toEqual({ default: null, groups: {} });
    expect(() => NetworkConfigSchema.parse({ denylist: { all: ['nope'] } })).toThrow();
    expect(() => NetworkConfigSchema.parse({ outbound: { default: ['https://x'] } })).toThrow();
  });
});

describe('per-group outbound relay policy', () => {
  test('served at /.well-known/beamhop/network; 404 without a policy', async () => {
    const none = await network({});
    expect((await none.kernel.http.request(NETWORK_POLICY_PATH)).status).toBe(404);

    const { kernel } = await network({
      outbound: { default: [], groups: { team1: ['wss://partner.example'], open: [] } },
    });
    const res = await kernel.http.request(NETWORK_POLICY_PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      groups: { team1: { outbound: ['wss://partner.example'] }, open: { outbound: [] } },
      default: { outbound: [] },
    });

    const unrestricted = await network({ outbound: { groups: { team1: [] } } });
    expect(
      await (await unrestricted.kernel.http.request(NETWORK_POLICY_PATH)).json(),
    ).toMatchObject({ default: { outbound: null } });
  });

  test('route does not exist while the module is off', async () => {
    const { kernel } = await makeKernel({ compliance: false, modules: {} });
    expect((await kernel.http.request(NETWORK_POLICY_PATH)).status).toBe(404);
  });

  test('outboundAllowed: home-only, listed relays, unrestricted default', () => {
    const cfg = NetworkConfigSchema.parse({
      outbound: { default: [], groups: { team1: ['wss://Partner.example/'] } },
    });
    expect(outboundAllowed(cfg, 'team1', 'wss://partner.example')).toBe(true);
    expect(outboundAllowed(cfg, 'team1', 'wss://evil.example')).toBe(false);
    expect(outboundAllowed(cfg, 'other', 'wss://partner.example')).toBe(false);
    const open = NetworkConfigSchema.parse({});
    expect(outboundAllowed(open, 'any', 'wss://anywhere.example')).toBe(true);
  });
});

describe('network controls on Cloudflare', () => {
  test('proxy headers are not trusted on Workers without a shared secret', async () => {
    const bun = await network({});
    expect(trustsProxyHeaders(bun.kernel)).toBe(true);
    const cf = await network({}, 'cloudflare');
    expect(trustsProxyHeaders(cf.kernel)).toBe(false);
  });

  test('device certificates: plain "not available" health and refused connections', async () => {
    const { kernel } = await network({ mtls: { enabled: true } }, 'cloudflare');
    const health = kernel.health.find((h) => h.id === 'enterprise-network.proxy-trust');
    const r = await health?.run(null);
    expect(r?.status).toBe('critical');
    expect(r?.message).toContain('not available on Cloudflare');
  });

  test('device-certificate gate refuses with a plain message on Workers', async () => {
    const alg = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' };
    const keys = (await crypto.subtle.generateKey(alg, true, ['sign', 'verify'])) as CryptoKeyPair;
    const ca = await x509.X509CertificateGenerator.createSelfSigned({
      name: 'CN=Company CA',
      keys,
      signingAlgorithm: alg,
      notBefore: new Date(Date.now() - 3600e3),
      notAfter: new Date(Date.now() + 86400e3),
      extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
    });
    const { kernel } = await network(
      { mtls: { enabled: true, caPem: ca.toString('pem') } },
      'cloudflare',
    );
    const res = await runRequestGates(kernel, new Request('https://relay.test/'), {
      route: relayRoute,
      upgrade: false,
      clientIp: () => '1.2.3.4',
    });
    expect(res?.status).toBe(403);
    expect(await res?.text()).toContain('not available on Cloudflare');
  });

  test('Entra proxy without a shared secret is reported on Workers', async () => {
    const { kernel } = await network({ zeroTrust: { provider: 'entra-app-proxy' } }, 'cloudflare');
    const r = await kernel.health.find((h) => h.id === 'enterprise-network.proxy-trust')?.run(null);
    expect(r?.status).toBe('critical');
    expect(r?.message).toContain('Cloudflare');
  });
});

describe('compliance on Cloudflare', () => {
  test('SIEM appends are handed to the runtime background service', async () => {
    const tracked: Promise<unknown>[] = [];
    const bg = defineModule({
      id: 'bg',
      register(k) {
        k.provide<BackgroundTasksLike>(BACKGROUND_SERVICE, { waitUntil: (p) => tracked.push(p) });
      },
    });
    const { kernel } = await makeKernel({
      extra: [bg],
      runtime: 'cloudflare',
      modules: {
        'enterprise-compliance': {
          siem: { sinks: [{ id: 's', type: 'webhook', url: 'https://siem.example/x' }] },
        },
      },
    });
    const st = complianceInternals(kernel);
    await st?.holds.create(
      {
        name: 'H',
        reason: 'r',
        scope: { pubkeys: ['a'.repeat(64)], subjects: [], groups: [], relays: [] },
      },
      'admin',
    );
    expect(tracked.length).toBeGreaterThan(0);
    await Promise.all(tracked);
  });

  test('syslog destinations report "not available on Cloudflare"', async () => {
    const { kernel } = await makeKernel({
      runtime: 'cloudflare',
      modules: {
        'enterprise-compliance': {
          siem: { sinks: [{ id: 'sys', type: 'syslog', host: 'siem.local', port: 6514 }] },
        },
      },
    });
    const r = await kernel.health
      .find((h) => h.id === 'enterprise-compliance.cloudflare')
      ?.run(null);
    expect(r?.status).toBe('warn');
    expect(r?.message).toContain('not available on Cloudflare');
    const bun = await makeKernel({ modules: { 'enterprise-compliance': {} } });
    expect(bun.kernel.health.some((h) => h.id === 'enterprise-compliance.cloudflare')).toBe(false);
  });
});
