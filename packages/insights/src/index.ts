// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @beamhop/insights — metrics, health score, community analytics,
 * Prometheus `/metrics` and OTLP export (§8).
 *
 * Exposes `kernel.use<InsightsService>('insights')`.
 */
import {
  type BeamhopModule,
  type Kernel,
  type KernelEnv,
  type Principal,
  can,
  defineModule,
} from '@beamhop/core';
import type { Context } from 'hono';
import { createActions } from './actions.ts';
import { InsightsConfigSchema } from './config.ts';
import { PROMETHEUS_CONTENT_TYPE } from './prometheus.ts';
import { type InsightsModuleOptions, InsightsRuntime } from './service.ts';

export * from './analytics.ts';
export * from './collector.ts';
export * from './config.ts';
export * from './health.ts';
export * from './hll.ts';
export * from './metrics.ts';
export * from './otlp.ts';
export * from './prometheus.ts';
export * from './providers.ts';
export * from './rollup.ts';
export * from './service.ts';
export * from './sketch.ts';

export const INSIGHTS_SERVICE = 'insights';
export const FLUSH_JOB = 'insights.flush';
export const MAINTAIN_JOB = 'insights.maintain';
export const OTLP_JOB = 'insights.otlp';

const runtimes = new WeakMap<Kernel, InsightsRuntime>();
/** Config-change subscriptions made in start(), removed in stop(). */
const configOffs = new WeakMap<Kernel, () => void>();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function authorizedForMetrics(
  kernel: Kernel,
  c: Context<KernelEnv>,
  token: string | undefined,
): Promise<boolean> {
  const header = c.req.header('authorization') ?? '';
  if (token && header.startsWith('Bearer ') && timingSafeEqual(header.slice(7).trim(), token))
    return true;
  let principal: Principal | null | undefined = c.get('principal');
  if (!principal) {
    for (const p of kernel.authProviders) {
      try {
        principal = await p.authenticate(c.req.raw);
      } catch {
        principal = null;
      }
      if (principal) break;
    }
  }
  return !!principal && can(principal, 'insights.read', null);
}

export function createInsightsModule(opts: InsightsModuleOptions = {}): BeamhopModule {
  return defineModule({
    id: 'insights',
    configSchema: InsightsConfigSchema,
    register(kernel) {
      const rt = new InsightsRuntime(kernel, opts);
      runtimes.set(kernel, rt);
      for (const a of createActions(rt)) kernel.actions.register(a);
      kernel.provide(INSIGHTS_SERVICE, rt);

      const path = rt.config().prometheus.path;
      kernel.http.get(path, async (c, next) => {
        const cfg = rt.config().prometheus;
        if (!cfg.enabled || c.req.path !== cfg.path) return next();
        if (!(await authorizedForMetrics(kernel, c, cfg.token)))
          return new Response('Unauthorized\n', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Bearer realm="beamhop-metrics"' },
          });
        return new Response(rt.prometheus(), {
          status: 200,
          headers: { 'Content-Type': PROMETHEUS_CONTENT_TYPE, 'Cache-Control': 'no-store' },
        });
      });
    },

    start(kernel) {
      const rt = runtimes.get(kernel);
      if (!rt) return;
      const sched = kernel.ports.scheduler;
      const report = (source: string) => (err: unknown) =>
        kernel.bus.emit('error', { source, message: String(err) });

      sched.every(FLUSH_JOB, rt.config().flushSeconds, () => rt.flush().catch(report(FLUSH_JOB)));
      sched.every(MAINTAIN_JOB, 3600, () => rt.maintain().catch(report(MAINTAIN_JOB)));

      const scheduleOtlp = () => {
        sched.cancel(OTLP_JOB);
        const otlp = rt.config().otlp;
        if (otlp)
          sched.every(OTLP_JOB, otlp.intervalSeconds, () =>
            rt.exportOtlp().catch(report(OTLP_JOB)),
          );
      };
      scheduleOtlp();
      configOffs.get(kernel)?.();
      configOffs.set(
        kernel,
        kernel.onConfigChange(() => scheduleOtlp()),
      );
    },

    async stop(kernel) {
      const rt = runtimes.get(kernel);
      if (!rt) return;
      configOffs.get(kernel)?.();
      configOffs.delete(kernel);
      for (const job of [FLUSH_JOB, MAINTAIN_JOB, OTLP_JOB]) kernel.ports.scheduler.cancel(job);
      await rt.flush().catch(() => undefined);
      rt.stop();
    },
  });
}

/** The insights module with default options. */
export const insightsModule = createInsightsModule();
