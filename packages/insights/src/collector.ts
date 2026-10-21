// SPDX-License-Identifier: AGPL-3.0-or-later
/** Bus → metrics/analytics wiring. Handlers are O(1) and never await. */
import type { Kernel, NostrEvent } from '@beamhop/core';
import type { Analytics } from './analytics.ts';
import { METRICS, type MetricsRegistry } from './metrics.ts';

/** NIP-01 machine-readable prefixes; anything else is "other" (bounded cardinality). */
const KNOWN_REASONS = new Set([
  'duplicate',
  'pow',
  'blocked',
  'rate-limited',
  'invalid',
  'restricted',
  'mute',
  'error',
  'auth-required',
  'spam',
]);

export function normalizeReason(reason: string): string {
  const prefix = (reason.split(':')[0] ?? '').trim().toLowerCase();
  return KNOWN_REASONS.has(prefix) ? prefix : 'other';
}

export function errorSource(source: string): string {
  const s = (source.split(/[.:]/)[0] ?? '').toLowerCase().replace(/[^a-z0-9_-]/g, '');
  return s.slice(0, 24) || 'unknown';
}

/** Approximate serialized size without stringifying on the hot path. */
export function approxEventBytes(e: NostrEvent): number {
  let n = 200 + e.content.length;
  for (const t of e.tags) for (const v of t) n += v.length + 3;
  return n;
}

export const NODE = '_node';

export function wireCollector(
  kernel: Kernel,
  registry: MetricsRegistry,
  analytics: Analytics | null,
): Array<() => void> {
  const bus = kernel.bus;
  const now = () => kernel.ports.clock.now();
  return [
    bus.on('conn.open', (p) => {
      const l = { relay: p.relayId };
      registry.inc(METRICS.connectionsOpened, l);
      registry.add(METRICS.connections, l, 1);
      analytics?.onConnection(p.relayId, now(), p.userAgent, p.country);
    }),
    bus.on('conn.close', (p) => registry.add(METRICS.connections, { relay: p.relayId }, -1)),
    bus.on('event.accepted', (p) => {
      const l = { relay: p.relayId };
      registry.inc(METRICS.eventsAccepted, l);
      registry.observe(METRICS.eventLatency, l, p.latencyMs);
      registry.inc(METRICS.bytesIn, l, approxEventBytes(p.event));
      analytics?.onEvent(p.relayId, p.event, now());
    }),
    bus.on('event.rejected', (p) =>
      registry.inc(METRICS.eventsRejected, { relay: p.relayId, reason: normalizeReason(p.reason) }),
    ),
    bus.on('event.held', (p) => registry.inc(METRICS.eventsHeld, { relay: p.relayId })),
    bus.on('event.deleted', (p) =>
      registry.inc(
        METRICS.eventsDeleted,
        { relay: p.relayId, cause: p.cause },
        Math.max(1, p.ids.length),
      ),
    ),
    bus.on('req.served', (p) => {
      const l = { relay: p.relayId };
      registry.inc(METRICS.reqServed, l);
      registry.inc(METRICS.reqResults, l, p.results);
      registry.observe(METRICS.reqLatency, l, p.latencyMs);
    }),
    bus.on('auth.success', (p) => {
      registry.inc(METRICS.authSuccess, { relay: p.relayId });
      analytics?.onActive(p.relayId, p.pubkey, now());
    }),
    bus.on('report.received', (p) => registry.inc(METRICS.reports, { relay: p.relayId })),
    bus.on('blob.uploaded', (p) => {
      const l = { relay: p.relayId };
      registry.inc(METRICS.blobUploads, l);
      registry.inc(METRICS.blobBytes, l, p.size);
      analytics?.onActive(p.relayId, p.pubkey, now());
    }),
    bus.on('blob.deleted', (p) => registry.inc(METRICS.blobDeleted, { relay: p.relayId })),
    bus.on('blob.quarantined', (p) => registry.inc(METRICS.blobQuarantined, { relay: p.relayId })),
    bus.on('error', (p) =>
      registry.inc(METRICS.errors, { relay: p.relayId ?? NODE, source: errorSource(p.source) }),
    ),
  ];
}
