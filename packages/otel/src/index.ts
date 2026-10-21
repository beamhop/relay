// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @beamhop/otel — opt-in OpenTelemetry traces (§8).
 *
 * Off by default and isolated (§12.0): the Bun binary loads this package only when
 * `modules.otel` exists in the config, and even then the module registers nothing —
 * no middleware, no listeners, no action, no requests — until `endpoint` is set.
 * Spans are exported as OTLP/HTTP JSON over `fetch` (Bun and Workers alike) to the
 * collector the admin configured, and nowhere else.
 *
 * Spans: every HTTP request through `kernel.http` (with W3C `traceparent`
 * propagation), relay EVENT / REQ handling, Blossom uploads and admin actions.
 * Optionally the `/metrics` counters are exported as OTLP metrics too.
 */
import {
  type BeamhopConfig,
  type BeamhopModule,
  type Kernel,
  type KernelEnv,
  defineAction,
  defineModule,
} from '@beamhop/core';
import type { Context, Next } from 'hono';
import { matchedRoutes } from 'hono/route';
import { z } from 'zod';
import { type OtelConfig, OtelConfigSchema } from './config.ts';
import { type ExporterStats, type FetchLike, OtlpTraceExporter } from './exporter.ts';
import { type InsightsLike, exportMetrics } from './metrics.ts';
import { SpanKind, parseTraceparent } from './otlp.ts';
import { Tracer, blossomOp, cleanRoute, reasonPrefix } from './tracer.ts';

export * from './config.ts';
export * from './exporter.ts';
export * from './metrics.ts';
export * from './otlp.ts';
export * from './tracer.ts';

export const OTEL_MODULE_ID = 'otel';
/** `kernel.use<OtelService>(OTEL_SERVICE)` while tracing is on. */
export const OTEL_SERVICE = 'otel';
export const OTEL_FLUSH_JOB = 'otel.flush';
export const OTEL_METRICS_JOB = 'otel.metrics';
/** How often queued spans are sent when no batch filled up first. */
export const FLUSH_SECONDS = 5;

export interface OtelModuleOptions {
  /** Fetch used for exports (tests pass a stub). */
  fetch?: FetchLike;
  /** Random source for sampling and retry jitter. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxQueue?: number;
  maxBatch?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
}

export interface OtelService {
  tracer: Tracer;
  exporter: OtlpTraceExporter;
  /** Send queued spans now. */
  flush(): Promise<void>;
  /** Send the insights counters now (no-op unless `metrics.enabled`). */
  exportMetrics(): Promise<void>;
  stats(): ExporterStats;
}

const services = new WeakMap<Kernel, OtelService>();

function section(kernel: Kernel): OtelConfig | undefined {
  const raw = kernel.moduleConfig<OtelConfig>(OTEL_MODULE_ID);
  return raw ? OtelConfigSchema.safeParse(raw).data : undefined;
}

/** Headers for exports: plain ones, then secret ones on top. */
function exportHeaders(cfg: OtelConfig | undefined): Record<string, string> {
  return cfg ? { ...cfg.headers, ...cfg.secretHeaders } : {};
}

function httpMiddleware(tracer: Tracer, exporter: OtlpTraceExporter) {
  return async (c: Context<KernelEnv>, next: Next) => {
    const incoming = parseTraceparent(c.req.header('traceparent'));
    const sampled = incoming ? incoming.sampled : tracer.sample();
    if (!sampled) return next();
    const start = tracer.nowMs();
    await next();
    const end = tracer.nowMs();
    const method = c.req.method;
    let route = '*';
    try {
      const routes = matchedRoutes(c);
      route = routes[c.req.routeIndex]?.path ?? routes.at(-1)?.path ?? '*';
    } catch {
      // Router details unavailable: keep the wildcard.
    }
    route = route === '*' || route === '/*' ? '(other)' : cleanRoute(route);
    const status = c.res.status;
    const failed = status >= 500 || !!c.error;
    tracer.record({
      name: `${method} ${route}`,
      kind: SpanKind.SERVER,
      startMs: start,
      endMs: end,
      ...(incoming ? { traceId: incoming.traceId, parentSpanId: incoming.spanId } : {}),
      attributes: {
        'http.request.method': method,
        'http.route': route,
        'http.response.status_code': status,
        'url.scheme': new URL(c.req.url).protocol.replace(':', ''),
        'beamhop.relay.id': c.get('route')?.relayId,
        'beamhop.blossom.op': blossomOp(method, route),
        'error.type': failed ? (c.error ? 'exception' : String(status)) : undefined,
      },
      ...(failed ? { status: { code: 'error' as const } } : {}),
    });
    let exec: { waitUntil(p: Promise<unknown>): void } | undefined;
    try {
      exec = c.executionCtx;
    } catch {
      // No execution context (Bun): the scheduled flush sends it.
    }
    // Workers may freeze the isolate after the response, so send now (in the background).
    if (exec) exec.waitUntil(exporter.flush().catch(() => undefined));
    else if (exporter.batchReady()) exporter.flush().catch(() => undefined);
  };
}

function wireBus(kernel: Kernel, tracer: Tracer, exporter: OtlpTraceExporter): void {
  const kick = () => {
    if (exporter.batchReady()) exporter.flush().catch(() => undefined);
  };
  kernel.bus.on('event.accepted', (e) => {
    if (!tracer.sample()) return;
    const end = tracer.nowMs();
    tracer.record({
      name: 'relay.event',
      kind: SpanKind.SERVER,
      startMs: end - Math.max(0, e.latencyMs),
      endMs: end,
      attributes: {
        'beamhop.relay.id': e.relayId,
        'nostr.event.kind': e.event.kind,
        'beamhop.event.outcome': 'accepted',
      },
    });
    kick();
  });
  kernel.bus.on('event.rejected', (e) => {
    if (!tracer.sample()) return;
    const now = tracer.nowMs();
    const prefix = reasonPrefix(e.reason);
    tracer.record({
      name: 'relay.event',
      kind: SpanKind.SERVER,
      startMs: now,
      endMs: now,
      attributes: {
        'beamhop.relay.id': e.relayId,
        'nostr.event.kind': e.kind,
        'beamhop.event.outcome': prefix === 'shadow' ? 'hidden' : 'rejected',
        'beamhop.event.reason': prefix,
        'beamhop.policy.by': e.by,
      },
    });
    kick();
  });
  kernel.bus.on('event.held', (e) => {
    if (!tracer.sample()) return;
    const now = tracer.nowMs();
    tracer.record({
      name: 'relay.event',
      kind: SpanKind.SERVER,
      startMs: now,
      endMs: now,
      attributes: {
        'beamhop.relay.id': e.relayId,
        'nostr.event.kind': e.event.kind,
        'beamhop.event.outcome': 'held',
        'beamhop.policy.by': e.by,
      },
    });
    kick();
  });
  kernel.bus.on('req.served', (e) => {
    if (!tracer.sample()) return;
    const end = tracer.nowMs();
    tracer.record({
      name: 'relay.req',
      kind: SpanKind.SERVER,
      startMs: end - Math.max(0, e.latencyMs),
      endMs: end,
      attributes: {
        'beamhop.relay.id': e.relayId,
        'beamhop.req.filters': e.filters,
        'beamhop.req.results': e.results,
      },
    });
    kick();
  });
  kernel.bus.on('blob.uploaded', (e) => {
    if (!tracer.sample()) return;
    const now = tracer.nowMs();
    tracer.record({
      name: 'blossom.upload',
      kind: SpanKind.INTERNAL,
      startMs: now,
      endMs: now,
      attributes: {
        'beamhop.relay.id': e.relayId,
        'beamhop.blossom.op': 'upload',
        'beamhop.blob.size': e.size,
        'beamhop.blob.type': e.type,
      },
    });
    kick();
  });
  kernel.bus.on('admin.action', (e) => {
    if (!tracer.sample()) return;
    const now = tracer.nowMs();
    const traceId = tracer.newTraceId();
    const spanId = tracer.newSpanId();
    tracer
      .hashId(e.principalId)
      .then((principalHash) => {
        tracer.record({
          name: 'admin.action',
          kind: SpanKind.INTERNAL,
          startMs: now,
          endMs: now,
          traceId,
          spanId,
          attributes: {
            'beamhop.relay.id': e.relayId ?? undefined,
            'beamhop.admin.action': e.actionId,
            'beamhop.admin.ok': e.ok,
            'beamhop.admin.principal_hash': principalHash,
          },
          ...(e.ok ? {} : { status: { code: 'error' as const } }),
        });
        kick();
      })
      .catch(() => undefined);
  });
}

function statusAction(svc: () => OtelService | undefined) {
  return defineAction({
    id: 'otel.status',
    title: 'Tracing export status',
    description:
      'How many traces were sent to your tracing collector, how many were dropped, and the last problem.',
    technical:
      'OTLP/HTTP JSON span exporter counters: exported, dropped (queue full, collector down or rejected), failed batches, retries, queue depth.',
    scope: 'node',
    permission: 'insights.read',
    readOnly: true,
    keywords: ['opentelemetry', 'otel', 'tracing', 'traces', 'tempo', 'jaeger'],
    input: z.object({}),
    async run() {
      const s = svc()?.stats();
      if (!s) return { output: null, summary: 'Tracing is off' };
      const summary = s.lastError
        ? `${s.exported} traces sent, ${s.dropped} dropped. Last problem: ${s.lastError}`
        : `${s.exported} traces sent, ${s.dropped} dropped`;
      return { output: s, summary };
    },
  });
}

export function createOtelModule(opts: OtelModuleOptions = {}): BeamhopModule {
  return defineModule({
    id: OTEL_MODULE_ID,
    configSchema: OtelConfigSchema,
    register(kernel) {
      // Off unless an admin set a collector address: contribute nothing at all.
      if (!section(kernel)?.endpoint) return;
      const fetchFn: FetchLike = opts.fetch ?? ((i, init) => fetch(i, init));
      const random = opts.random ?? Math.random;
      // Cached config, refreshed on change (the hot path never re-parses).
      let cfg = section(kernel);
      kernel.onConfigChange((next: BeamhopConfig) => {
        const raw = next.modules[OTEL_MODULE_ID];
        cfg = raw === undefined ? undefined : OtelConfigSchema.safeParse(raw).data;
      });
      const resource = () => ({
        serviceName: cfg?.serviceName ?? 'beamhop',
        instanceId: kernel.config().node.id,
      });
      const exporter = new OtlpTraceExporter({
        endpoint: () => cfg?.endpoint,
        headers: () => exportHeaders(cfg),
        resource,
        fetch: fetchFn,
        random,
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
        ...(opts.maxQueue !== undefined ? { maxQueue: opts.maxQueue } : {}),
        ...(opts.maxBatch !== undefined ? { maxBatch: opts.maxBatch } : {}),
        ...(opts.maxAttempts !== undefined ? { maxAttempts: opts.maxAttempts } : {}),
        ...(opts.retryBaseMs !== undefined ? { retryBaseMs: opts.retryBaseMs } : {}),
        now: () => kernel.ports.clock.now(),
      });
      const tracer = new Tracer({
        crypto: kernel.ports.crypto,
        clock: kernel.ports.clock,
        exporter,
        ratio: () => (cfg?.endpoint ? cfg.sampleRatio : 0),
        random,
      });
      const service: OtelService = {
        tracer,
        exporter,
        flush: () => exporter.flush(),
        async exportMetrics() {
          if (!cfg?.endpoint || !cfg.metrics.enabled) return;
          const insights = kernel.use<InsightsLike>('insights');
          if (!insights) return;
          await exportMetrics({
            fetch: fetchFn,
            endpoint: cfg.endpoint,
            headers: exportHeaders(cfg),
            insights,
            resource: resource(),
            now: kernel.ports.clock.now(),
          });
        },
        stats: () => exporter.stats(),
      };
      services.set(kernel, service);
      kernel.provide(OTEL_SERVICE, service);
      kernel.http.use('*', httpMiddleware(tracer, exporter));
      wireBus(kernel, tracer, exporter);
      kernel.actions.register(statusAction(() => services.get(kernel)));
    },

    start(kernel) {
      const svc = services.get(kernel);
      if (!svc) return;
      const report = (source: string) => (err: unknown) =>
        kernel.bus.emit('error', { source, message: String(err) });
      kernel.ports.scheduler.every(OTEL_FLUSH_JOB, FLUSH_SECONDS, () =>
        svc.flush().catch(report(OTEL_FLUSH_JOB)),
      );
      const scheduleMetrics = () => {
        kernel.ports.scheduler.cancel(OTEL_METRICS_JOB);
        const cfg = section(kernel);
        if (!cfg?.endpoint || !cfg.metrics.enabled) return;
        kernel.ports.scheduler.every(OTEL_METRICS_JOB, cfg.metrics.intervalSeconds, () =>
          svc.exportMetrics().catch(report(OTEL_METRICS_JOB)),
        );
      };
      scheduleMetrics();
      kernel.onConfigChange(() => scheduleMetrics());
    },

    async stop(kernel) {
      const svc = services.get(kernel);
      if (!svc) return;
      kernel.ports.scheduler.cancel(OTEL_FLUSH_JOB);
      kernel.ports.scheduler.cancel(OTEL_METRICS_JOB);
      await svc.flush().catch(() => undefined);
      services.delete(kernel);
    },
  });
}

/** The OpenTelemetry module with default options. */
export const otelModule = createOtelModule();
