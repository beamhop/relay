// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Lifecycle module: retention (per kind / tier / goals), blob expiry, storage
 * caps, legal-hold hook, scheduled backups + restore, Litestream config and
 * lag monitoring, known-good marking for safe mode, and personal data export.
 *
 * Services:
 * - `kernel.use<LegalHolds>('lifecycle.holds')` — legal hold registry (§12.7)
 * - `kernel.use<LifecycleService>('lifecycle')` — backups, retention, export
 */
import {
  ACCEPT,
  type BeamhopModule,
  type Kernel,
  type RelayId,
  defineModule,
  reject,
} from '@beamhop/core';
import { createActions } from './actions.ts';
import { type BackupLast, BackupService } from './backup.ts';
import { type ExportOptions, exportUserData } from './export.ts';
import { FAILOVER_PLAYBOOK, createCardSource, createHealthChecks } from './health.ts';
import { HOLDS_SERVICE, type LegalHolds } from './holds.ts';
import { KnownGoodMarker } from './known-good.ts';
import { LitestreamMonitor, generateLitestreamConfig } from './litestream.ts';
import { RetentionEngine } from './retention.ts';
import { type LifecycleOptions, LifecycleRuntime } from './runtime.ts';
import { LifecycleConfigSchema, MODULE_ID } from './settings.ts';

export {
  MODULE_ID,
  COL,
  LifecycleConfigSchema,
  StorageCapSchema,
  DEFAULT_LOW_VALUE_KINDS,
} from './settings.ts';
export type { LifecycleConfig, StorageCap } from './settings.ts';
export { HOLDS_SERVICE, createHolds } from './holds.ts';
export type { HoldProvider, HoldSubject, LegalHolds } from './holds.ts';
export {
  ARCHIVE_TYPE,
  ARCHIVE_FORMAT,
  BackupService,
  type ArchiveManifest,
  type BackupLast,
  type BackupRecord,
  type RestoreResult,
  type VerifyResult,
} from './backup.ts';
export {
  RetentionEngine,
  isProtectedKind,
  type RetentionPlan,
  type RetentionState,
} from './retention.ts';
export {
  generateLitestreamConfig,
  parsePrometheus,
  sqlitePathOf,
  LitestreamMonitor,
  litestreamHealth,
  type LitestreamOptions,
  type LitestreamStatus,
} from './litestream.ts';
export { KnownGoodMarker } from './known-good.ts';
export { exportUserData, USER_EXPORT_FORMAT, type ExportOptions } from './export.ts';
export { FAILOVER_PLAYBOOK } from './health.ts';
export { tarPack, tarUnpack, gzip, gunzip } from './tar.ts';
export type { SqlExecLike, TableSource } from './sql.ts';
export {
  STORAGE_SQL_SERVICE,
  type LifecycleOptions,
  type RuntimeInfo,
  type StorageSqlService,
} from './runtime.ts';

/** `kernel.use<LifecycleService>('lifecycle')`. */
export interface LifecycleService {
  holds: LegalHolds;
  backups: BackupService;
  retention: RetentionEngine;
  knownGood: KnownGoodMarker;
  litestream: LitestreamMonitor;
  exportUserData(
    relayId: RelayId,
    pubkey: string,
    opts?: ExportOptions,
  ): ReadableStream<Uint8Array>;
  generateLitestreamConfig(opts?: Parameters<typeof generateLitestreamConfig>[1]): string;
  /** Latest backup status (`lifecycle.backups/last`), or null if none ran yet. */
  lastBackup(): Promise<BackupLast | null>;
  /** True while a restore is running (writes are refused). */
  restoring(): boolean;
  /** Wait for background bus handlers (tests). */
  idle(): Promise<void>;
}

export const JOBS = {
  retention: 'lifecycle.retention',
  backups: 'lifecycle.backups',
  knownGood: 'lifecycle.known-good',
  litestream: 'lifecycle.litestream',
} as const;

interface Entry {
  rt: LifecycleRuntime;
  service: LifecycleService;
  cleanup: Array<() => void>;
}

const runtimes = new WeakMap<Kernel, Entry>();

const FAILOVER_STEPS = [
  {
    title: 'Keep a standby ready',
    body: 'Run Litestream on this server so every change is copied to cloud storage within seconds. Download the settings file and install it next to Beamhop.',
    actionId: 'backups.litestream-config',
    input: {},
  },
  {
    title: 'Check the standby is up to date',
    body: 'The health screen shows how far behind the copy is. Aim for under a minute.',
  },
  {
    title: 'If this server fails',
    body: 'On the standby, restore the database from the copy (litestream restore), start Beamhop, then point your domain (DNS) or floating IP to the standby.',
  },
  {
    title: 'After switching',
    body: 'Start Litestream on the new main server so it is protected again, and keep the old server off until it has been rebuilt as the new standby.',
  },
];

export function createLifecycleModule(opts: LifecycleOptions = {}): BeamhopModule {
  return defineModule({
    id: MODULE_ID,
    configSchema: LifecycleConfigSchema,
    register(kernel) {
      const rt = new LifecycleRuntime(kernel, opts);
      const retention = new RetentionEngine(rt);
      const backups = new BackupService(rt);
      const knownGood = new KnownGoodMarker(rt);
      const fetchImpl =
        opts.fetch ?? ((url: string, init?: RequestInit) => globalThis.fetch(url, init));
      const litestream = new LitestreamMonitor(fetchImpl, () => kernel.ports.clock.now());
      const cleanup: Array<() => void> = [];

      const service: LifecycleService = {
        holds: rt.holds,
        backups,
        retention,
        knownGood,
        litestream,
        exportUserData: (relayId, pubkey, o) => exportUserData(kernel.ports, relayId, pubkey, o),
        generateLitestreamConfig: (o) => generateLitestreamConfig(kernel.config(), o),
        lastBackup: () => backups.last(),
        restoring: () => rt.restoring,
        idle: () => retention.idle(),
      };
      kernel.provide(HOLDS_SERVICE, rt.holds);
      kernel.provide(MODULE_ID, service);

      // Writes pause while a backup is being restored (cheap flag check otherwise).
      const busy = () =>
        rt.restoring
          ? reject('error', 'the relay is restoring a backup; try again in a minute')
          : ACCEPT;
      cleanup.push(
        kernel.policy.add({
          id: 'lifecycle.restore-guard',
          priority: -1000,
          onEvent: busy,
          onUpload: busy,
        }),
      );

      cleanup.push(
        kernel.bus.on('blob.uploaded', (p) => retention.track(retention.onBlobUploaded(p))),
      );

      for (const a of createActions(rt, backups, retention)) kernel.actions.register(a);
      kernel.health.push(...createHealthChecks(rt, backups, retention, litestream));
      kernel.cards.push(createCardSource(rt, backups, retention, litestream));
      kernel.playbooks.push({
        id: FAILOVER_PLAYBOOK,
        title: 'Standby server and failover',
        steps: FAILOVER_STEPS,
      });
      kernel.ui.push({
        path: '/settings/backups',
        title: 'Backups',
        placement: 'settings-section',
        chunk: 'lifecycle-backups',
      });
      runtimes.set(kernel, { rt, service, cleanup });
    },

    start(kernel) {
      const entry = runtimes.get(kernel);
      if (!entry) return;
      const { rt, service } = entry;
      const sched = kernel.ports.scheduler;
      const s = rt.settings();
      const guard = (name: string, fn: () => Promise<unknown>) => async () => {
        if (rt.restoring) return;
        try {
          await fn();
        } catch (err) {
          rt.log('error', 'lifecycle job failed', { job: name, err: String(err) });
        }
      };
      sched.every(
        JOBS.retention,
        s.retention.intervalMinutes * 60,
        guard(JOBS.retention, () => service.retention.tick()),
      );
      sched.every(
        JOBS.backups,
        s.backups.checkMinutes * 60,
        guard(JOBS.backups, async () => {
          if (await service.backups.due()) await service.backups.run('scheduled');
        }),
      );
      sched.every(
        JOBS.knownGood,
        s.knownGood.checkSeconds,
        guard(JOBS.knownGood, async () => {
          if ((await service.knownGood.tick()) !== 'waiting') sched.cancel(JOBS.knownGood);
        }),
      );
      sched.every(
        JOBS.litestream,
        s.litestream.checkSeconds,
        guard(JOBS.litestream, async () => {
          const cfg = rt.settings().litestream;
          if (cfg.enabled) await service.litestream.sample(cfg.metricsUrl);
        }),
      );
      entry.cleanup.push(() => {
        for (const j of Object.values(JOBS)) sched.cancel(j);
      });
    },

    async stop(kernel) {
      const entry = runtimes.get(kernel);
      if (!entry) return;
      for (const c of entry.cleanup.splice(0)) c();
      await entry.service.idle();
      runtimes.delete(kernel);
    },
  });
}

export const lifecycleModule = createLifecycleModule();
