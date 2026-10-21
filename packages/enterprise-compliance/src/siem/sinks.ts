// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SIEM sinks. HTTP sinks use `fetch` (Bun + Workers). Syslog needs raw sockets:
 * the Bun adapter (`syslog-bun.ts`) is imported lazily, only when a syslog sink
 * is used on the Bun runtime; tests inject a transport.
 */
import type { RuntimeName } from '@beamhop/core';
import { SignJWT, importPKCS8 } from 'jose';
import type { SinkConfig } from '../config.ts';
import { hmacSha256Hex } from '../util.ts';
import {
  type SiemRecord,
  octetFrame,
  toChronicle,
  toSentinel,
  toSplunk,
  toSyslog,
} from './format.ts';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface Sink {
  readonly id: string;
  readonly type: SinkConfig['type'];
  send(records: SiemRecord[]): Promise<void>;
  close?(): Promise<void>;
}

/** Byte transport for syslog (TCP/TLS frames are already octet-counted). */
export interface SyslogTransport {
  send(frames: Uint8Array[]): Promise<void>;
  close(): Promise<void>;
}

export type SyslogTransportFactory = (opts: {
  host: string;
  port: number;
  transport: 'tls' | 'tcp' | 'udp';
  caPem?: string;
}) => Promise<SyslogTransport>;

export interface SinkDeps {
  fetch: FetchLike;
  runtime: RuntimeName;
  nodeId: string;
  /** Unix seconds. */
  now(): number;
  syslogTransport?: SyslogTransportFactory;
}

export class SinkError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SinkError';
  }
}

async function ensureOk(res: Response, what: string): Promise<void> {
  if (res.ok) return;
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {}
  throw new SinkError(`${what} answered ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
}

/** OAuth token cache shared by the Sentinel and Chronicle sinks. */
class TokenCache {
  private token: { value: string; exp: number } | null = null;
  constructor(
    private readonly now: () => number,
    private readonly fetchToken: () => Promise<{ access_token: string; expires_in?: number }>,
  ) {}
  async get(): Promise<string> {
    if (this.token && this.token.exp - 60 > this.now()) return this.token.value;
    const t = await this.fetchToken();
    if (!t.access_token) throw new SinkError('token endpoint returned no access_token');
    this.token = { value: t.access_token, exp: this.now() + (t.expires_in ?? 3600) };
    return t.access_token;
  }
  reset(): void {
    this.token = null;
  }
}

export function createSink(cfg: SinkConfig, deps: SinkDeps): Sink {
  switch (cfg.type) {
    case 'webhook':
      return {
        id: cfg.id,
        type: cfg.type,
        async send(records) {
          const body = JSON.stringify({ node: deps.nodeId, records });
          const headers: Record<string, string> = {
            'content-type': 'application/json',
            ...cfg.headers,
          };
          if (cfg.secret)
            headers['x-beamhop-signature'] = `sha256=${await hmacSha256Hex(cfg.secret, body)}`;
          const res = await deps.fetch(cfg.url, { method: 'POST', headers, body });
          await ensureOk(res, 'The webhook');
        },
      };
    case 'splunk': {
      const url = new URL(cfg.url);
      if (!/\/services\/collector/.test(url.pathname)) {
        url.pathname = `${url.pathname.replace(/\/$/, '')}/services/collector/event`;
      }
      return {
        id: cfg.id,
        type: cfg.type,
        async send(records) {
          const res = await deps.fetch(url.toString(), {
            method: 'POST',
            headers: {
              authorization: `Splunk ${cfg.token}`,
              'content-type': 'application/json',
            },
            body: toSplunk(records, {
              sourcetype: cfg.sourcetype,
              host: deps.nodeId,
              ...(cfg.index ? { index: cfg.index } : {}),
            }),
          });
          await ensureOk(res, 'Splunk');
        },
      };
    }
    case 'sentinel': {
      const tokens = new TokenCache(deps.now, async () => {
        const res = await deps.fetch(
          `${cfg.authorityHost.replace(/\/$/, '')}/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: cfg.clientId,
              client_secret: cfg.clientSecret,
              scope: 'https://monitor.azure.com/.default',
              grant_type: 'client_credentials',
            }).toString(),
          },
        );
        await ensureOk(res, 'Microsoft sign-in');
        return (await res.json()) as { access_token: string; expires_in?: number };
      });
      const ingest = `${cfg.dceEndpoint.replace(/\/$/, '')}/dataCollectionRules/${encodeURIComponent(cfg.dcrImmutableId)}/streams/${encodeURIComponent(cfg.streamName)}?api-version=2023-01-01`;
      return {
        id: cfg.id,
        type: cfg.type,
        async send(records) {
          const token = await tokens.get();
          const res = await deps.fetch(ingest, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(toSentinel(records)),
          });
          if (res.status === 401) tokens.reset();
          await ensureOk(res, 'Microsoft Sentinel');
        },
      };
    }
    case 'chronicle': {
      const sa = cfg.serviceAccount;
      const tokens = new TokenCache(deps.now, async () => {
        const key = await importPKCS8(sa.privateKeyPem, 'RS256');
        const now = deps.now();
        const assertion = await new SignJWT({
          scope: 'https://www.googleapis.com/auth/malachite-ingestion',
        })
          .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
          .setIssuer(sa.clientEmail)
          .setSubject(sa.clientEmail)
          .setAudience(sa.tokenUri)
          .setIssuedAt(now)
          .setExpirationTime(now + 3600)
          .sign(key);
        const res = await deps.fetch(sa.tokenUri, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion,
          }).toString(),
        });
        await ensureOk(res, 'Google sign-in');
        return (await res.json()) as { access_token: string; expires_in?: number };
      });
      const base = (
        cfg.endpoint ?? `https://${cfg.region}-malachiteingestion-pa.googleapis.com`
      ).replace(/\/$/, '');
      return {
        id: cfg.id,
        type: cfg.type,
        async send(records) {
          const token = await tokens.get();
          const res = await deps.fetch(`${base}/v2/unstructuredlogentries:batchCreate`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              customer_id: cfg.customerId,
              log_type: cfg.logType,
              entries: toChronicle(records),
            }),
          });
          if (res.status === 401) tokens.reset();
          await ensureOk(res, 'Google Chronicle');
        },
      };
    }
    case 'syslog': {
      let transport: SyslogTransport | null = null;
      const open = async (): Promise<SyslogTransport> => {
        if (transport) return transport;
        const factory = deps.syslogTransport ?? (await defaultSyslogTransport(deps.runtime));
        transport = await factory({
          host: cfg.host,
          port: cfg.port,
          transport: cfg.transport,
          ...(cfg.caPem ? { caPem: cfg.caPem } : {}),
        });
        return transport;
      };
      return {
        id: cfg.id,
        type: cfg.type,
        async send(records) {
          const opts = { facility: cfg.facility, appName: cfg.appName, hostname: deps.nodeId };
          const frames = records.map((r) => {
            const msg = toSyslog(r, opts);
            // UDP: one datagram per message, no framing (RFC 5426).
            return cfg.transport === 'udp' ? new TextEncoder().encode(msg) : octetFrame(msg);
          });
          const t = await open();
          try {
            await t.send(frames);
          } catch (err) {
            transport = null;
            await t.close().catch(() => {});
            throw err;
          }
        },
        async close() {
          await transport?.close();
          transport = null;
        },
      };
    }
  }
}

async function defaultSyslogTransport(runtime: RuntimeName): Promise<SyslogTransportFactory> {
  if (runtime !== 'bun' && runtime !== 'test') {
    throw new SinkError(
      'Syslog needs the Bun server (raw TCP/TLS). On Cloudflare use Splunk, Sentinel, Chronicle or a webhook.',
    );
  }
  // Lazy: keeps Bun-only socket code out of Workers bundles and non-syslog setups.
  const mod = await import('./syslog-bun.ts');
  return mod.bunSyslogTransport;
}
