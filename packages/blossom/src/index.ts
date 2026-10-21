// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Blossom module: BUD-01/02/04/05/06 HTTP handlers, kind 24242 auth, tier
 * quotas, cross-relay dedupe with per-relay ownership, policy hooks
 * (onUpload / onBlobServe), admin actions, health check and orphan GC.
 *
 * Exposes `kernel.use<BlossomService>('blossom')` for dependents (media, moderation).
 */
import { type BeamhopModule, defineModule } from '@beamhop/core';
import { blossomHealthCheck, registerActions } from './admin.ts';
import { BlossomConfigSchema } from './config.ts';
import { registerRoutes } from './routes.ts';
import { type BlossomOptions, BlossomService } from './service.ts';
import { registerStorageActions, tiersCards, tiersHealthCheck } from './storage-admin.ts';
import { TIERING_JOB, TieringService } from './tiering.ts';

export const BLOSSOM_GC_JOB = 'blossom.gc';
export const BLOSSOM_TIERING_JOB = TIERING_JOB;

export function createBlossomModule(opts: BlossomOptions = {}): BeamhopModule {
  let svc: BlossomService | undefined;
  let tiering: TieringService | undefined;
  const offs: Array<() => void> = [];
  return defineModule({
    id: 'blossom',
    configSchema: BlossomConfigSchema,
    register(kernel) {
      svc = new BlossomService(kernel, opts);
      kernel.provide('blossom', svc);
      const s = svc;
      // Hot/cold tiering: routes ports.blobs through a tiered store (pass-through when off).
      const t = new TieringService(kernel, s, opts.tiering);
      tiering = t;
      s.tiering = t;
      offs.push(() => t.restore());
      offs.push(
        kernel.onConfigChange(() => {
          void t.ensureCold().catch(() => null);
        }),
      );
      // NIP-62: the person's files go with their posts (relay emits `user.vanished`).
      offs.push(
        kernel.bus.on('user.vanished', (e) =>
          s.track('blossom.vanish', async () => {
            const r = await s.vanish(e.relayId, e.pubkey, e.until);
            if (r.removed) kernel.ports.logger.log('info', 'blossom vanish', { ...r });
          }),
        ),
      );
      registerRoutes(kernel, svc);
      registerActions(kernel, svc);
      registerStorageActions(kernel, svc, t);
      kernel.health.push(blossomHealthCheck(kernel));
      kernel.health.push(tiersHealthCheck(t));
      kernel.cards.push(tiersCards(kernel, t));
    },
    async start(kernel) {
      const s = svc;
      if (!s) return;
      const t = tiering;
      if (t) {
        await t.ensureCold().catch(() => null);
        kernel.ports.scheduler.every(TIERING_JOB, t.intervalSeconds, async () => {
          try {
            await t.run();
          } catch (err) {
            kernel.bus.emit('error', { source: TIERING_JOB, message: String(err) });
          }
        });
      }
      kernel.ports.scheduler.every(BLOSSOM_GC_JOB, opts.gcIntervalSeconds ?? 3600, async () => {
        try {
          const r = await s.gc();
          if (r.expired || r.erased) {
            kernel.ports.logger.log('info', 'blossom gc', { ...r });
          }
        } catch (err) {
          kernel.bus.emit('error', { source: BLOSSOM_GC_JOB, message: String(err) });
        }
      });
    },
    stop(kernel) {
      kernel.ports.scheduler.cancel(BLOSSOM_GC_JOB);
      kernel.ports.scheduler.cancel(TIERING_JOB);
      for (const off of offs.splice(0)) off();
    },
  });
}

/** Default Blossom module (global fetch for mirroring). */
export const blossomModule: BeamhopModule = createBlossomModule();

export { checkAuth, BLOSSOM_AUTH_KIND, type AuthVerb, type AuthResult } from './auth.ts';
export { parseRange } from './routes.ts';
export {
  ABUSE_SCAN_SOURCE,
  ANONYMOUS,
  BLOCKED,
  BlossomService,
  HELD,
  QUARANTINE,
  isAbuseMatch,
  type BlockedRecord,
  type GcState,
  type QuarantineRecord,
  type BlobDescriptor,
  type HeldBlobRecord,
  type VanishFilesResult,
  type BlossomOptions,
  type IngestParams,
  type IngestResult,
  type UploadLimits,
} from './service.ts';
export { BlossomError, isPrivateHost } from './util.ts';
export { NEAR_QUOTA_RATIO, type UsageSummary, usageSummary } from './admin.ts';
export {
  BlossomConfigSchema,
  ColdTierSchema,
  TiersSchema,
  type BlossomConfig,
  type ColdTierConfig,
  type TiersConfig,
} from './config.ts';
export {
  COLD_STORE_SERVICE,
  TIERS,
  TIER_CRITICAL,
  TIER_WARN,
  TieringService,
  type TierRecord,
  type TierStatus,
  type TieringOptions,
  type TieringState,
  type TieringStatusOutput,
} from './tiering.ts';
export {
  ABUSE_TEXT,
  PREVIEW_MAX_BYTES,
  RELEASED,
  quarantineSource,
  type QuarantineItem,
  type QuarantineSource,
} from './storage-admin.ts';
export { SUPPORTED_BUDS, SERVER_LIST_KIND } from './routes.ts';
