// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Enterprise key custody (§12.3): envelope encryption under a KEK (local master
 * key, AWS/GCP/Azure KMS, Vault Transit), an isolated audited signer for
 * company-managed keys, a built-in NIP-46 bunker hosted by the relay itself,
 * crypto-shredding with legal-hold checks, and optional DM escrow (§12.8).
 *
 * Isolation (§12.0): the module contributes NOTHING unless
 * `config.modules['enterprise-keyvault']` exists — no routes, actions, services,
 * bus listeners, health checks, cards or jobs. (It has no `configSchema` on
 * purpose: the kernel would otherwise materialize an empty section.)
 */
import { type BeamhopModule, type Kernel, defineModule } from '@beamhop/core';
import { createActions } from './actions.ts';
import { MODULE_ID, SERVICE } from './config.ts';
import { createCardSource, createHealthChecks } from './health.ts';
import { type KeyvaultDeps, KeyvaultRuntime } from './runtime.ts';

export * from './config.ts';
export * from './envelope.ts';
export * from './kek/index.ts';
export * from './signer.ts';
export * from './bunker.ts';
export * from './escrow.ts';
export * from './migrate.ts';
export { KeyvaultRuntime } from './runtime.ts';
export type { KeyvaultDeps, KeyvaultService } from './runtime.ts';

/**
 * Runtime service (`kernel.use(SECRET_FILES_SERVICE)`) that reads secret files such as
 * a generated master key (`kek.keyFile`). Provided by runtimes with a filesystem (Bun).
 */
export const SECRET_FILES_SERVICE = 'runtime.secret-files';
export interface SecretFilesService {
  read(path: string): Promise<string>;
}

const SHRED_JOB = 'keyvault.shred';
const PRUNE_JOB = 'keyvault.audit-prune';

const runtimes = new WeakMap<Kernel, { rt: KeyvaultRuntime; off: () => void }>();

/** Runtime handle for tests/integrations (undefined when the module is not configured). */
export function keyvaultRuntime(kernel: Kernel): KeyvaultRuntime | undefined {
  return runtimes.get(kernel)?.rt;
}

export function createKeyvaultModule(deps: KeyvaultDeps = {}): BeamhopModule {
  return defineModule({
    id: MODULE_ID,
    optional: true,
    async register(kernel) {
      if (kernel.config().modules[MODULE_ID] === undefined) return;
      // `kek.keyFile` needs a file reader: injected, or the runtime's secret-file service.
      const files = kernel.use<SecretFilesService>(SECRET_FILES_SERVICE);
      const rt = new KeyvaultRuntime(
        kernel,
        deps.readFile || !files ? deps : { ...deps, readFile: (p) => files.read(p) },
      );
      rt.cfg(); // validate early: a broken config section fails the boot loudly
      await rt.init();
      if (rt.current) {
        rt.priorWrapper = kernel.ports.keyWrapper;
        rt.portWrapper = rt.envelope.portWrapper(rt.priorWrapper);
        kernel.ports.keyWrapper = rt.portWrapper;
      }
      kernel.provide(SERVICE, rt.service());
      for (const a of createActions(rt)) kernel.actions.register(a);
      kernel.health.push(...createHealthChecks(rt));
      kernel.cards.push(createCardSource(rt));
      kernel.ui.push({
        path: '/settings/company/keys',
        title: 'Company keys',
        placement: 'settings-section',
        chunk: 'enterprise-keyvault',
      });
      const off = kernel.bus.on('event.accepted', ({ relayId, event }) =>
        rt.bunker.onAccepted(relayId, event),
      );
      runtimes.set(kernel, { rt, off });
    },
    async start(kernel) {
      const h = runtimes.get(kernel);
      if (!h) return;
      const { rt } = h;
      const { scheduler, logger } = kernel.ports;
      scheduler.every(SHRED_JOB, 3600, async () => {
        const n = await rt.signer.processDestruction();
        if (n) logger.log('info', 'managed keys destroyed', { count: n });
      });
      scheduler.every(PRUNE_JOB, 86400, async () => {
        await rt.signer.pruneAudit();
      });
      if (rt.portWrapper) {
        try {
          const report = await rt.migrateLegacy();
          if (report.wrapped.length || report.failed.length)
            logger.log('info', 'key vault wrapped older keys', {
              wrapped: report.wrapped,
              failed: report.failed,
            });
        } catch (err) {
          logger.log('warn', 'key vault migration failed', { err: String(err) });
        }
      }
    },
    async stop(kernel) {
      const h = runtimes.get(kernel);
      if (!h) return;
      h.off();
      kernel.ports.scheduler.cancel(SHRED_JOB);
      kernel.ports.scheduler.cancel(PRUNE_JOB);
      await h.rt.bunker.idle();
      // Turned off while running: hand key wrapping back to what was there before.
      if (h.rt.portWrapper && kernel.ports.keyWrapper === h.rt.portWrapper)
        kernel.ports.keyWrapper = h.rt.priorWrapper;
      runtimes.delete(kernel);
    },
  });
}

export const enterpriseKeyvaultModule = createKeyvaultModule();
export default enterpriseKeyvaultModule;
