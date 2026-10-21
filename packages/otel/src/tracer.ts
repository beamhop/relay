// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Span creation and the privacy rules every span goes through.
 *
 * Privacy: spans carry only attributes this package sets on purpose — HTTP method,
 * route pattern (never the URL or query), status, timings, relay id, event kind,
 * counts, decision prefixes and action ids. Never raw IPs, user pubkeys, content,
 * tokens or headers. Admin principal ids are hashed (`ports.crypto.sha256Hex`).
 */
import type { Clock, Crypto } from '@beamhop/core';
import type { OtlpTraceExporter } from './exporter.ts';
import { type AttrValue, type SpanData, SpanKind, type SpanKindValue } from './otlp.ts';

/** Attribute keys spans may carry. Anything else is dropped before export. */
export const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'http.request.method',
  'http.route',
  'http.response.status_code',
  'url.scheme',
  'beamhop.relay.id',
  'beamhop.blossom.op',
  'beamhop.event.outcome',
  'beamhop.event.reason',
  'beamhop.policy.by',
  'nostr.event.kind',
  'beamhop.req.filters',
  'beamhop.req.results',
  'beamhop.blob.size',
  'beamhop.blob.type',
  'beamhop.admin.action',
  'beamhop.admin.ok',
  'beamhop.admin.principal_hash',
  'error.type',
]);

const MAX_STRING = 200;

/** Keep only allowed keys with short, plain values. */
export function sanitizeAttributes(
  attrs: Record<string, AttrValue | undefined>,
): Record<string, AttrValue> {
  const out: Record<string, AttrValue> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || !ALLOWED_ATTRIBUTES.has(k)) continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    out[k] = typeof v === 'string' ? v.slice(0, MAX_STRING) : v;
  }
  return out;
}

export interface TracerDeps {
  crypto: Crypto;
  clock: Clock;
  exporter: OtlpTraceExporter;
  /** Current sample ratio (0..1). */
  ratio: () => number;
  random?: () => number;
}

export interface SpanInput {
  name: string;
  kind?: SpanKindValue;
  startMs: number;
  endMs: number;
  attributes: Record<string, AttrValue | undefined>;
  traceId?: string;
  parentSpanId?: string;
  spanId?: string;
  status?: SpanData['status'];
}

export class Tracer {
  private readonly random: () => number;

  constructor(private readonly deps: TracerDeps) {
    this.random = deps.random ?? Math.random;
  }

  /** Head sampling decision for a new root span. */
  sample(): boolean {
    const r = this.deps.ratio();
    if (!(r > 0)) return false;
    if (r >= 1) return true;
    return this.random() < r;
  }

  newTraceId(): string {
    return this.deps.crypto.randomHex(16);
  }

  newSpanId(): string {
    return this.deps.crypto.randomHex(8);
  }

  nowMs(): number {
    return this.deps.clock.nowMs();
  }

  /** Record a finished span (already sampled). */
  record(s: SpanInput): void {
    this.deps.exporter.enqueue({
      traceId: s.traceId ?? this.newTraceId(),
      spanId: s.spanId ?? this.newSpanId(),
      ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
      name: s.name,
      kind: s.kind ?? SpanKind.INTERNAL,
      startMs: s.startMs,
      endMs: s.endMs,
      attributes: sanitizeAttributes(s.attributes),
      ...(s.status ? { status: s.status } : {}),
    });
  }

  /** Short, one-way hash of an identifier (admin principal ids). */
  async hashId(id: string): Promise<string> {
    const hex = await this.deps.crypto.sha256Hex(new TextEncoder().encode(`beamhop.otel:${id}`));
    return hex.slice(0, 16);
  }
}

/**
 * Route pattern for display: regex constraints are removed
 * (`/:file{[0-9a-f]{64}…}` → `/:file`), so no request value can leak.
 */
export function cleanRoute(path: string): string {
  let out = '';
  let depth = 0;
  for (const ch of path) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out || '/';
}

/** Blossom operation for well-known Blossom routes (BUD-01/02/04/05), else undefined. */
export function blossomOp(method: string, route: string): string | undefined {
  if (route === '/:file') {
    if (method === 'GET' || method === 'HEAD') return 'get';
    if (method === 'DELETE') return 'delete';
  }
  if (method === 'PUT' && (route === '/upload' || route === '/media')) return 'upload';
  if (method === 'PUT' && route === '/mirror') return 'mirror';
  return undefined;
}

/** First word of a relay reason (`blocked: …` → `blocked`); free text is never exported. */
export function reasonPrefix(reason: string): string {
  const m = /^([a-z-]{1,32}):/.exec(reason.trim());
  return m?.[1] ?? 'other';
}
