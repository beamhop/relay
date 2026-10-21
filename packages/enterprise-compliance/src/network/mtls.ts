// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * mTLS / device certificates (§12.10). The TLS-terminating proxy (nginx, Envoy,
 * ALB, Traefik, Caddy…) passes the verified client certificate in a header; we
 * re-validate it against the company CA bundle (chain signature + validity window +
 * optional subject allowlist). Headers are only trusted when `node.trustProxy` is on
 * or the request carries the configured proxy secret.
 *
 * Bun-terminated TLS: configure the CA at the TLS layer (Bun `tls.ca` + `requestCert`
 * + `rejectUnauthorized`) — see README; certificate details are not exposed per request
 * by Bun.serve, so this module relies on the proxy-header path.
 */
// tsyringe (used by @peculiar/x509) needs the Reflect metadata polyfill under bundlers.
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { sha256Hex } from '../util.ts';

x509.cryptoProvider.set(crypto);

export interface MtlsResult {
  ok: boolean;
  /** Plain-language reason when not ok. */
  reason?: string;
  subject?: string;
  fingerprint?: string;
}

export function parsePemBundle(pem: string): x509.X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((b) => new x509.X509Certificate(b));
}

/** Decode the certificate header value from common proxy formats. */
export function decodeCertHeader(raw: string): string | Uint8Array | null {
  let v = raw.trim();
  if (!v) return null;
  // Envoy x-forwarded-client-cert: By=…;Hash=…;Cert="<url-encoded PEM>";…
  const xfcc = /(?:^|[;,])\s*Cert="([^"]+)"/i.exec(v);
  if (xfcc?.[1]) v = xfcc[1];
  if (v.includes('%')) {
    try {
      v = decodeURIComponent(v);
    } catch {
      return null;
    }
  }
  if (v.includes('BEGIN CERTIFICATE')) {
    // Some proxies replace newlines with spaces (or tabs); rebuild a valid PEM.
    const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(v);
    if (!m) return null;
    const body = m[1]!.replace(/[\s\t]+/g, '');
    return `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)?.join('\n')}\n-----END CERTIFICATE-----\n`;
  }
  // Base64 DER (e.g. Cloudflare / custom proxies).
  if (/^[A-Za-z0-9+/=_-]+$/.test(v)) {
    try {
      const bin = atob(v.replace(/-/g, '+').replace(/_/g, '/'));
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    } catch {
      return null;
    }
  }
  return null;
}

export class MtlsVerifier {
  private readonly anchors: x509.X509Certificate[];
  private cache = new Map<string, { at: number; result: MtlsResult }>();

  constructor(
    caPem: string,
    private readonly opts: { allowedSubjects?: string[]; now?: () => Date } = {},
  ) {
    this.anchors = parsePemBundle(caPem);
    if (!this.anchors.length) throw new Error('The company CA bundle has no certificates');
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  async verifyHeader(raw: string | null | undefined): Promise<MtlsResult> {
    if (!raw) return { ok: false, reason: 'No device certificate was presented' };
    const decoded = decodeCertHeader(raw);
    if (!decoded) return { ok: false, reason: 'The device certificate could not be read' };
    let cert: x509.X509Certificate;
    try {
      cert = new x509.X509Certificate(
        typeof decoded === 'string' ? decoded : (decoded as Uint8Array<ArrayBuffer>),
      );
    } catch {
      return { ok: false, reason: 'The device certificate could not be read' };
    }
    const fp = await sha256Hex(new Uint8Array(cert.rawData));
    const nowMs = this.now().getTime();
    const hit = this.cache.get(fp);
    if (hit && nowMs - hit.at < 60_000) return hit.result;
    const result = await this.verify(cert, fp);
    if (this.cache.size > 1000) this.cache.clear();
    this.cache.set(fp, { at: nowMs, result });
    return result;
  }

  async verify(cert: x509.X509Certificate, fingerprint?: string): Promise<MtlsResult> {
    const now = this.now();
    const fp = fingerprint ?? (await sha256Hex(new Uint8Array(cert.rawData)));
    const base = { subject: cert.subject, fingerprint: fp };
    if (now < cert.notBefore || now > cert.notAfter)
      return { ...base, ok: false, reason: 'The device certificate is expired or not yet valid' };
    const allowed = this.opts.allowedSubjects ?? [];
    if (allowed.length && !allowed.some((s) => cert.subject.includes(s)))
      return { ...base, ok: false, reason: 'This device certificate is not allowed' };
    // Every certificate in the bundle is a trust anchor (roots and pinned intermediates):
    // the device certificate must be signed directly by one of them.
    for (const issuer of this.anchors.filter((a) => a.subject === cert.issuer)) {
      if (now < issuer.notBefore || now > issuer.notAfter) continue;
      const ok = await cert
        .verify({ publicKey: issuer.publicKey, date: now, signatureOnly: true })
        .catch(() => false);
      if (ok) return { ...base, ok: true };
    }
    return { ...base, ok: false, reason: 'The device certificate is not from your company CA' };
  }
}
