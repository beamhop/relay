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
import { registerRoutes } from './routes.ts';
import { type BlossomOptions, BlossomService } from './service.ts';

export const BLOSSOM_GC_JOB = 'blossom.gc';

export function createBlossomModule(opts: BlossomOptions = {}): BeamhopModule {
  let svc: BlossomService | undefined;
  return defineModule({
    id: 'blossom',
    register(kernel) {
      svc = new BlossomService(kernel, opts);
      kernel.provide('blossom', svc);
      registerRoutes(kernel, svc);
      registerActions(kernel, svc);
      kernel.health.push(blossomHealthCheck(kernel));
    },
    start(kernel) {
      const s = svc;
      if (!s) return;
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
    },
  });
}

/** Default Blossom module (global fetch for mirroring). */
export const blossomModule: BeamhopModule = createBlossomModule();

export { checkAuth, BLOSSOM_AUTH_KIND, type AuthVerb, type AuthResult } from './auth.ts';
export { parseRange } from './routes.ts';
export {
  ANONYMOUS,
  BlossomService,
  type BlobDescriptor,
  type BlossomOptions,
  type IngestParams,
  type IngestResult,
  type UploadLimits,
} from './service.ts';
export { BlossomError, isPrivateHost } from './util.ts';
export { NEAR_QUOTA_RATIO, type UsageSummary, usageSummary } from './admin.ts';
