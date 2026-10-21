// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Span model, OTLP/HTTP JSON encoding and W3C Trace Context parsing.
 * Pure functions, Web-standard only (runs on Bun and Workers).
 */
import { BEAMHOP_VERSION } from '@beamhop/core';

export type AttrValue = string | number | boolean;

/** OTLP `SpanKind` values. */
export const SpanKind = { INTERNAL: 1, SERVER: 2, CLIENT: 3, PRODUCER: 4, CONSUMER: 5 } as const;
export type SpanKindValue = (typeof SpanKind)[keyof typeof SpanKind];

/** A finished span, ready to export. */
export interface SpanData {
  /** 32 lowercase hex characters. */
  traceId: string;
  /** 16 lowercase hex characters. */
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKindValue;
  /** Unix milliseconds. */
  startMs: number;
  endMs: number;
  attributes: Record<string, AttrValue>;
  status?: { code: 'ok' | 'error'; message?: string };
}

export interface ResourceInfo {
  serviceName: string;
  instanceId: string;
}

type AnyValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };

function anyValue(v: AttrValue): AnyValue {
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number')
    return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
}

export function encodeAttributes(attrs: Record<string, AttrValue>) {
  return Object.keys(attrs)
    .sort()
    .map((key) => ({ key, value: anyValue(attrs[key] as AttrValue) }));
}

/** Unix ms → OTLP `fixed64` nanoseconds (as a decimal string, per the JSON mapping). */
export const msToNanos = (ms: number): string =>
  (BigInt(Math.max(0, Math.round(ms))) * 1_000_000n).toString();

const STATUS_CODE = { ok: 1, error: 2 } as const;

/** `ExportTraceServiceRequest` in the OTLP JSON encoding (hex ids, string nanos). */
export function encodeTraces(spans: SpanData[], resource: ResourceInfo): unknown {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: encodeAttributes({
            'service.name': resource.serviceName,
            'service.instance.id': resource.instanceId,
            'service.version': BEAMHOP_VERSION,
          }),
        },
        scopeSpans: [
          {
            scope: { name: 'beamhop', version: BEAMHOP_VERSION },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.kind,
              startTimeUnixNano: msToNanos(s.startMs),
              endTimeUnixNano: msToNanos(Math.max(s.endMs, s.startMs)),
              attributes: encodeAttributes(s.attributes),
              ...(s.status
                ? {
                    status: {
                      code: STATUS_CODE[s.status.code],
                      ...(s.status.message ? { message: s.status.message } : {}),
                    },
                  }
                : {}),
            })),
          },
        ],
      },
    ],
  };
}

/** `{endpoint}/v1/traces` (an endpoint that already ends with it is used as-is). */
export function tracesUrl(endpoint: string): string {
  const e = endpoint.replace(/\/+$/, '');
  return e.endsWith('/v1/traces') ? e : `${e}/v1/traces`;
}

/** `{endpoint}/v1/metrics`, accepting a traces URL as the base too. */
export function metricsUrl(endpoint: string): string {
  const e = endpoint.replace(/\/+$/, '').replace(/\/v1\/traces$/, '');
  return e.endsWith('/v1/metrics') ? e : `${e}/v1/metrics`;
}

export interface TraceParent {
  traceId: string;
  spanId: string;
  sampled: boolean;
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;

/**
 * Parse a W3C `traceparent` header. Returns null for anything invalid (version `ff`,
 * all-zero ids, extra fields on version `00`), so a bad header starts a new trace.
 */
export function parseTraceparent(header: string | null | undefined): TraceParent | null {
  if (!header) return null;
  const m = TRACEPARENT_RE.exec(header.trim().toLowerCase());
  if (!m) return null;
  const [, version, traceId, spanId, flags, rest] = m as unknown as [
    string,
    string,
    string,
    string,
    string,
    string | undefined,
  ];
  if (version === 'ff' || (version === '00' && rest)) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return null;
  return { traceId, spanId, sampled: (Number.parseInt(flags, 16) & 1) === 1 };
}

/** Format a `traceparent` header value (version 00). */
export function formatTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}
