// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * TLS auto-detection (§7) and in-process ACME HTTP-01 via `acme-client`.
 *
 *  - mode `acme`  → always ACME.
 *  - mode `auto`  → ACME if listening on :443 and the host has a public IP; otherwise proxy.
 *  - mode `proxy` → plain HTTP behind a reverse proxy (self-check endpoint verifies headers).
 *  - mode `off`   → plain HTTP, no proxy expectations.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import type { BeamhopConfig, Logger } from '@beamhop/core';

export type EffectiveTls = 'acme' | 'proxy' | 'off';

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
  /^0\./,
];

export function isPublicIp(ip: string): boolean {
  const v = ip.replace(/^::ffff:/, '').toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) return !PRIVATE_V4.some((r) => r.test(v));
  if (v === '::1' || v === '::') return false;
  if (v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return false;
  return v.includes(':');
}

export function localPublicIps(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (!a.internal && isPublicIp(a.address)) out.push(a.address);
  }
  return out;
}

/** Hostnames ACME can issue for: all relay hosts except wildcards/IPs/localhost. */
export function acmeDomains(config: BeamhopConfig): string[] {
  const set = new Set<string>();
  for (const r of config.relays) {
    for (const h of r.hosts) {
      const host = h.toLowerCase().replace(/:\d+$/, '');
      if (host === '*' || host.includes('*') || host === 'localhost') continue;
      if (/^[\d.]+$/.test(host) || host.includes(':')) continue;
      if (!host.includes('.')) continue;
      set.add(host);
    }
  }
  return [...set];
}

export function decideTls(
  config: BeamhopConfig,
  port: number,
  publicIps: () => string[] = localPublicIps,
): { mode: EffectiveTls; reason: string } {
  const m = config.node.tls.mode;
  if (m === 'off') return { mode: 'off', reason: 'TLS turned off in config' };
  if (m === 'proxy') return { mode: 'proxy', reason: 'TLS handled by a reverse proxy' };
  if (m === 'acme') return { mode: 'acme', reason: 'ACME requested in config' };
  if (port !== 443) return { mode: 'proxy', reason: `listening on :${port}, not :443` };
  if (publicIps().length === 0) return { mode: 'proxy', reason: 'no public IP on this machine' };
  if (acmeDomains(config).length === 0) {
    return { mode: 'proxy', reason: 'no domain names configured for ACME' };
  }
  return { mode: 'acme', reason: 'on :443 with a public IP' };
}

/** HTTP-01 challenge tokens served at /.well-known/acme-challenge/<token>. */
export class ChallengeStore {
  private readonly tokens = new Map<string, string>();
  set(token: string, keyAuthorization: string): void {
    this.tokens.set(token, keyAuthorization);
  }
  delete(token: string): void {
    this.tokens.delete(token);
  }
  get(token: string): string | undefined {
    return this.tokens.get(token);
  }
  /** Response for an ACME challenge path, or null if not a challenge request. */
  respond(pathname: string): Response | null {
    const prefix = '/.well-known/acme-challenge/';
    if (!pathname.startsWith(prefix)) return null;
    const value = this.tokens.get(pathname.slice(prefix.length));
    return value
      ? new Response(value, { headers: { 'content-type': 'text/plain' } })
      : new Response('unknown challenge', { status: 404 });
  }
}

export interface CertPair {
  cert: string;
  key: string;
  notAfter: Date;
}

/** Minimal surface of acme-client used here (injectable for tests). */
export interface AcmeBackend {
  createAccountKey(): Promise<string>;
  /** Run the full order; must call `onChallenge` / `onChallengeDone` for http-01. */
  obtain(opts: {
    accountKey: string;
    domains: string[];
    email?: string;
    directoryUrl: string;
    onChallenge(token: string, keyAuthorization: string): Promise<void>;
    onChallengeDone(token: string): Promise<void>;
  }): Promise<{ cert: string; key: string }>;
  notAfter(certPem: string): Date;
}

export async function acmeClientBackend(): Promise<AcmeBackend> {
  const acme = await import('acme-client');
  return {
    async createAccountKey() {
      return (await acme.crypto.createPrivateKey()).toString();
    },
    async obtain(o) {
      const client = new acme.Client({ directoryUrl: o.directoryUrl, accountKey: o.accountKey });
      const [key, csr] = await acme.crypto.createCsr({
        commonName: o.domains[0],
        altNames: o.domains,
      });
      const cert = await client.auto({
        csr,
        email: o.email,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
          if (challenge.type === 'http-01') await o.onChallenge(challenge.token, keyAuthorization);
        },
        challengeRemoveFn: async (_authz, challenge) => {
          if (challenge.type === 'http-01') await o.onChallengeDone(challenge.token);
        },
      });
      return { cert, key: key.toString() };
    },
    notAfter(certPem) {
      return acme.crypto.readCertificateInfo(certPem).notAfter;
    },
  };
}

export const LETSENCRYPT_PRODUCTION = 'https://acme-v02.api.letsencrypt.org/directory';

export interface AcmeManagerOptions {
  tlsDir: string;
  domains: string[];
  email?: string;
  directoryUrl?: string;
  challenges: ChallengeStore;
  logger: Logger;
  backend?: AcmeBackend;
  /** Renew when fewer than this many days remain (default 30). */
  renewBeforeDays?: number;
  now?: () => number;
}

/** Obtains, stores and renews the node certificate in `<dataDir>/tls`. */
export class AcmeManager {
  private backend?: AcmeBackend;
  readonly certPath: string;
  readonly keyPath: string;
  readonly accountKeyPath: string;
  constructor(private readonly o: AcmeManagerOptions) {
    this.backend = o.backend;
    this.certPath = join(o.tlsDir, 'cert.pem');
    this.keyPath = join(o.tlsDir, 'key.pem');
    this.accountKeyPath = join(o.tlsDir, 'account.key');
  }

  private async getBackend(): Promise<AcmeBackend> {
    this.backend ??= await acmeClientBackend();
    return this.backend;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  async current(): Promise<CertPair | null> {
    if (!existsSync(this.certPath) || !existsSync(this.keyPath)) return null;
    const cert = readFileSync(this.certPath, 'utf8');
    const key = readFileSync(this.keyPath, 'utf8');
    try {
      return { cert, key, notAfter: (await this.getBackend()).notAfter(cert) };
    } catch {
      return null;
    }
  }

  needsRenewal(pair: CertPair | null): boolean {
    if (!pair) return true;
    const days = (pair.notAfter.getTime() - this.now()) / 86_400_000;
    return days < (this.o.renewBeforeDays ?? 30);
  }

  /** Return a valid certificate, obtaining/renewing it if needed. */
  async ensure(): Promise<{ pair: CertPair; renewed: boolean }> {
    const existing = await this.current();
    if (existing && !this.needsRenewal(existing)) return { pair: existing, renewed: false };
    const backend = await this.getBackend();
    let accountKey: string;
    if (existsSync(this.accountKeyPath)) accountKey = readFileSync(this.accountKeyPath, 'utf8');
    else {
      accountKey = await backend.createAccountKey();
      writeFileSync(this.accountKeyPath, accountKey, { mode: 0o600 });
    }
    this.o.logger.log('info', 'requesting TLS certificate', {
      domains: this.o.domains,
      technical: 'ACME HTTP-01',
    });
    const { cert, key } = await backend.obtain({
      accountKey,
      domains: this.o.domains,
      email: this.o.email,
      directoryUrl: this.o.directoryUrl ?? LETSENCRYPT_PRODUCTION,
      onChallenge: async (token, ka) => this.o.challenges.set(token, ka),
      onChallengeDone: async (token) => this.o.challenges.delete(token),
    });
    writeFileSync(this.certPath, cert, { mode: 0o600 });
    writeFileSync(this.keyPath, key, { mode: 0o600 });
    const pair = { cert, key, notAfter: backend.notAfter(cert) };
    this.o.logger.log('info', 'TLS certificate ready', { notAfter: pair.notAfter.toISOString() });
    return { pair, renewed: true };
  }
}
