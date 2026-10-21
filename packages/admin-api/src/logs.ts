// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Recent logs for the admin app (§8 "in-app viewer with filters"): a bounded
 * in-memory ring of structured log lines fed from the kernel logger
 * (`kernel.onLog`) and from `error` bus events, read with `logs.query`.
 *
 * Nothing is persisted. Before a line is stored, secrets and tokens are
 * replaced with "•••" and anything that looks like a raw IP address is
 * replaced with its salted hash (`ports.crypto.hashIp`), so the viewer never
 * shows one (§12 privacy rule: never log raw IPs).
 */
import {
  type ActionDef,
  type Kernel,
  type LogLevel,
  type LogRecord,
  defineAction,
} from '@beamhop/core';
import { z } from 'zod';
import { isSecretKey } from './util.ts';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

export interface StoredLog {
  /** Unix milliseconds. */
  at: number;
  level: LogLevel;
  /** Module or component that wrote the line ("server" when unknown). */
  source: string;
  message: string;
  fields: Record<string, unknown>;
}

export interface LogQuery {
  level?: LogLevel[];
  source?: string;
  text?: string;
  /** Unix milliseconds (inclusive). */
  since?: number;
  /** Unix milliseconds (inclusive). */
  until?: number;
  limit?: number;
}

const SOURCE_KEYS = ['module', 'component', 'source', 'subsystem', 'plugin'] as const;
const EXTRA_SECRET =
  /token|authorization|cookie|session|jwt|bearer|credential|privkey|seckey|^sk$|signature|claimcode|recovery/i;
const IP_KEY =
  /^(ip|ips|addr|address|remote|remoteaddr|remoteaddress|clientip|forwardedfor|x-forwarded-for|x-real-ip|cf-connecting-ip)$/i;
const IPV4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
/** Candidate IPv6; only hashed with "::" or 5+ groups, so clock times ("12:30:45") stay. */
const IPV6 = /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi;
const SECRET_VALUES: Array<[RegExp, string]> = [
  [/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer •••'],
  [/\bNostr\s+[\w+/=]{16,}/g, 'Nostr •••'],
  [/\bnsec1[02-9ac-hj-np-z]{20,}/g, '•••'],
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, '•••'],
  [/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1•••@'],
  [/([?&](?:token|key|secret|password|sig|auth)=)[^&\s]+/gi, '$1•••'],
];
const MAX_STRING = 2000;
const MAX_DEPTH = 6;

/** Replaces secrets and raw IPs. `hashIp` must be the node's salted IP hash. */
export class LogRedactor {
  constructor(private readonly hashIp: (ip: string) => string) {}

  text(s: string): string {
    let out = s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}…` : s;
    for (const [re, rep] of SECRET_VALUES) out = out.replace(re, rep);
    out = out.replace(IPV4, (ip) => `ip:${this.hashIp(ip)}`);
    out = out.replace(IPV6, (ip) =>
      ip.includes('::') || ip.split(':').length >= 5 ? `ip:${this.hashIp(ip)}` : ip,
    );
    return out;
  }

  value(v: unknown, key = '', depth = 0): unknown {
    if (v === null || v === undefined) return v;
    if (key && (isSecretKey(key) || EXTRA_SECRET.test(key)) && typeof v !== 'boolean')
      return typeof v === 'number' ? v : '•••';
    if (typeof v === 'string') {
      if (key && IP_KEY.test(key) && !v.startsWith('ip:') && /[.:]/.test(v))
        return `ip:${this.hashIp(v)}`;
      return this.text(v);
    }
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Error) return { name: v.name, message: this.text(v.message) };
    if (depth >= MAX_DEPTH) return '…';
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => this.value(x, key, depth + 1));
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 50))
        out[k] = this.value(x, k, depth + 1);
      return out;
    }
    return String(v);
  }

  fields(f: Record<string, unknown>): Record<string, unknown> {
    return this.value(f, '', 0) as Record<string, unknown>;
  }
}

/** Fixed-size ring of the most recent log lines (oldest dropped first). */
export class LogRing {
  private buf: StoredLog[] = [];
  private start = 0;
  /** Lines dropped because the ring was full (since start). */
  dropped = 0;

  constructor(private capacity: () => number) {}

  get size(): number {
    return this.buf.length;
  }

  push(rec: StoredLog): void {
    const cap = Math.max(1, this.capacity());
    // Capacity changed while wrapped (or shrank): re-linearize first.
    if (this.buf.length > cap || (this.start !== 0 && this.buf.length !== cap)) this.compact(cap);
    if (this.buf.length < cap) {
      this.buf.push(rec);
      return;
    }
    this.buf[this.start] = rec;
    this.start = (this.start + 1) % cap;
    this.dropped++;
  }

  /** Oldest → newest. */
  all(): StoredLog[] {
    return this.start === 0
      ? [...this.buf]
      : [...this.buf.slice(this.start), ...this.buf.slice(0, this.start)];
  }

  /** Re-linearize after the capacity changed (keeps the newest lines). */
  private compact(cap: number): void {
    const all = this.all();
    const over = Math.max(0, all.length - cap);
    this.dropped += over;
    this.buf = all.slice(over);
    this.start = 0;
  }

  /** Newest first, filtered. */
  query(q: LogQuery = {}): StoredLog[] {
    const limit = Math.min(500, Math.max(1, q.limit ?? 200));
    const levels = q.level?.length ? new Set(q.level) : null;
    const source = q.source?.trim().toLowerCase();
    const text = q.text?.trim().toLowerCase();
    const all = this.all();
    const out: StoredLog[] = [];
    for (let i = all.length - 1; i >= 0 && out.length < limit; i--) {
      const r = all[i] as StoredLog;
      if (levels && !levels.has(r.level)) continue;
      if (q.since !== undefined && r.at < q.since) continue;
      if (q.until !== undefined && r.at > q.until) continue;
      if (source && !r.source.toLowerCase().includes(source)) continue;
      if (text && !matches(r, text)) continue;
      out.push(r);
    }
    return out;
  }

  sources(): string[] {
    return [...new Set(this.buf.map((r) => r.source))].sort();
  }
}

function matches(r: StoredLog, text: string): boolean {
  if (r.message.toLowerCase().includes(text) || r.source.toLowerCase().includes(text)) return true;
  try {
    return JSON.stringify(r.fields).toLowerCase().includes(text);
  } catch {
    return false;
  }
}

/** Turn a raw logger line into a stored (redacted) one. */
export function toStored(rec: LogRecord, redact: LogRedactor): StoredLog {
  const fields = redact.fields(rec.fields ?? {});
  let source = 'server';
  for (const k of SOURCE_KEYS) {
    const v = fields[k];
    if (typeof v === 'string' && v) {
      source = v;
      break;
    }
  }
  return { at: rec.at, level: rec.level, source, message: redact.text(String(rec.msg)), fields };
}

/**
 * Start collecting logs for `kernel` and return the read-only `logs.query` action.
 * `keep` is the ring capacity (read on every write, so config changes apply at once).
 */
export function logActions(kernel: Kernel, keep: () => number): ActionDef[] {
  const ring = new LogRing(keep);
  const redact = new LogRedactor((ip) => kernel.ports.crypto.hashIp(ip));
  kernel.onLog?.((rec) => ring.push(toStored(rec, redact)));
  // Errors reported on the bus (handler crashes, plugin failures) are not always logged.
  kernel.bus.on('error', (e) => {
    const fields: Record<string, unknown> = { source: e.source };
    if (e.relayId) fields.relayId = e.relayId;
    if (e.stack) fields.stack = e.stack;
    ring.push(
      toStored({ at: kernel.ports.clock.nowMs(), level: 'error', msg: e.message, fields }, redact),
    );
  });

  const query = defineAction({
    id: 'logs.query',
    title: 'Recent logs',
    description:
      'What the server wrote to its log recently, newest first. Passwords, keys and IP addresses are hidden.',
    technical:
      'In-memory ring buffer (modules.admin-api.logs.keep lines, since restart) fed from kernel.ports.logger and `error` bus events; secrets redacted, IPs replaced by ports.crypto.hashIp. Times are Unix milliseconds.',
    scope: 'node',
    permission: 'insights.read',
    readOnly: true,
    keywords: ['logs', 'errors', 'debug', 'warnings', 'troubleshoot'],
    input: z.object({
      level: z.array(z.enum(LOG_LEVELS)).max(4).optional().describe('Only these levels'),
      source: z.string().max(100).optional().describe('Only lines from this part of the server'),
      text: z.string().max(200).optional().describe('Only lines containing this text'),
      since: z.number().int().nonnegative().optional().describe('From (Unix milliseconds)'),
      until: z.number().int().nonnegative().optional().describe('Until (Unix milliseconds)'),
      limit: z.number().int().min(1).max(500).default(200).describe('Most lines to return'),
    }),
    async run(input) {
      const q: LogQuery = { limit: input.limit };
      if (input.level) q.level = input.level;
      if (input.source) q.source = input.source;
      if (input.text) q.text = input.text;
      if (input.since !== undefined) q.since = input.since;
      if (input.until !== undefined) q.until = input.until;
      const records = ring.query(q).map((r) => ({
        at: r.at,
        level: r.level,
        source: r.source,
        message: r.message,
        fields: r.fields,
      }));
      return {
        output: { records, dropped: ring.dropped, sources: ring.sources() },
        summary: `${records.length} log line${records.length === 1 ? '' : 's'}`,
      };
    },
  });
  return [query as unknown as ActionDef];
}
