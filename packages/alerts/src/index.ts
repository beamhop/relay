// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @beamhop/alerts — rules engine with baseline-aware anomaly detection,
 * notifiers (Web Push, NIP-17 DM, Telegram, Discord, Slack, email), on-call
 * routing, digest, attention cards and playbooks (§6.9, §6.10, §8).
 *
 * Exposes `kernel.use<AlertsService>('alerts')` and installs `kernel.setNotifier`.
 */
import { type BeamhopModule, type Kernel, defineModule } from '@beamhop/core';
import { createActions } from './actions.ts';
import { AlertsModuleConfigSchema } from './config.ts';
import { PLAYBOOKS } from './playbooks.ts';
import { type AlertsModuleOptions, AlertsRuntime } from './runtime.ts';

export * from './baseline.ts';
export * from './config.ts';
export * from './digest.ts';
export * from './engine.ts';
export * from './notifiers.ts';
export * from './playbooks.ts';
export * from './router.ts';
export * from './rules.ts';
export * from './runtime.ts';
export * from './webpush.ts';

export const ALERTS_SERVICE = 'alerts';
export const EVALUATE_JOB = 'alerts.evaluate';
export const DIGEST_JOB = 'alerts.digest';
export const HOUSEKEEPING_JOB = 'alerts.housekeeping';

const runtimes = new WeakMap<Kernel, AlertsRuntime>();

export function createAlertsModule(opts: AlertsModuleOptions = {}): BeamhopModule {
  return defineModule({
    id: 'alerts',
    configSchema: AlertsModuleConfigSchema,
    register(kernel) {
      const rt = new AlertsRuntime(kernel, opts);
      runtimes.set(kernel, rt);
      kernel.setNotifier((n) => rt.route(n).then(() => undefined));
      kernel.cards.push({ id: 'alerts', cards: (relayId) => rt.engine.cards(relayId) });
      for (const p of PLAYBOOKS)
        if (!kernel.playbooks.some((x) => x.id === p.id)) kernel.playbooks.push(p);
      for (const a of createActions(rt)) kernel.actions.register(a);
      kernel.provide(ALERTS_SERVICE, rt);
    },
    start(kernel) {
      const rt = runtimes.get(kernel);
      if (!rt) return;
      const sched = kernel.ports.scheduler;
      const report = (source: string) => (err: unknown) =>
        kernel.bus.emit('error', { source, message: String(err) });
      sched.every(EVALUATE_JOB, rt.config().evaluateSeconds, () =>
        rt.evaluate().then(() => undefined, report(EVALUATE_JOB)),
      );
      sched.every(DIGEST_JOB, 3600, () =>
        rt.digestTick().then(() => undefined, report(DIGEST_JOB)),
      );
      sched.every(HOUSEKEEPING_JOB, 86400, () =>
        rt.engine
          .pruneChanges(kernel.ports.clock.now() - 30 * 86400)
          .then(() => undefined, report(HOUSEKEEPING_JOB)),
      );
    },
    async stop(kernel) {
      const rt = runtimes.get(kernel);
      if (!rt) return;
      for (const j of [EVALUATE_JOB, DIGEST_JOB, HOUSEKEEPING_JOB])
        kernel.ports.scheduler.cancel(j);
      await rt.engine.saveBaselines().catch(() => undefined);
      rt.engine.stop();
    },
  });
}

/** The alerts module with default options. */
export const alertsModule = createAlertsModule();
