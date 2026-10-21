// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @beamhop/experience — the server side of "remove decisions" (§6.6–6.14, §7):
 * suggestions inbox (batched, ranked, per-admin dismiss/snooze, approve via the
 * normal action path), first-week setup checklist, launch kit + "Test my relay",
 * guided playbooks, sandbox replay of config changes, "Why?" explanations,
 * local-only weekly admin minutes, and the simple-screen complexity budget.
 *
 * Nothing in this module changes relay behaviour on its own.
 */
import { type BeamhopModule, type Kernel, defineModule } from '@beamhop/core';
import { createActions } from './actions.ts';
import { AdminTimeTracker } from './admin-time.ts';
import { SuggestionsEngine } from './inbox.ts';
import { type OutsideDialer, defaultDialer } from './launch-kit.ts';
import { registerPlaybooks } from './playbooks.ts';
import { MODULE_ID } from './util.ts';
import { RejectionRing } from './why.ts';

export * from './admin-time.ts';
export * from './checklist.ts';
export * from './inbox.ts';
export * from './launch-kit.ts';
export * from './patch.ts';
export * from './playbooks.ts';
export * from './simple-screens.ts';
export * from './simulate.ts';
export * from './why.ts';
export { COL, MODULE_ID, ExperienceError } from './util.ts';

export interface ExperienceModuleOptions {
  /** How "Test my relay" reaches the relay from outside (default: global fetch + WebSocket). */
  dialer?: OutsideDialer;
  /** Per-step timeout for "Test my relay". */
  testTimeoutMs?: number;
  /** How many recent refusals to remember for "Why?". */
  rejectionBuffer?: number;
}

/** `kernel.use<ExperienceService>('experience')`. */
export interface ExperienceService {
  readonly engine: SuggestionsEngine;
  readonly rejections: RejectionRing;
  readonly adminTime: AdminTimeTracker;
  /** Playbook ids this module registered (others were already provided). */
  readonly playbooksAdded: readonly string[];
  /** Resolves when background bookkeeping has settled (tests). */
  idle(): Promise<void>;
}

const runtimes = new WeakMap<
  Kernel,
  { svc: ExperienceService; added: string[]; cleanup: Array<() => void> }
>();

export function createExperienceModule(opts: ExperienceModuleOptions = {}): BeamhopModule {
  return defineModule({
    id: MODULE_ID,
    register(kernel) {
      const engine = new SuggestionsEngine(kernel);
      const ring = new RejectionRing(opts.rejectionBuffer ?? 500);
      const time = new AdminTimeTracker(kernel);
      const added: string[] = [];
      const cleanup = [...ring.attach(kernel), time.attach()];
      const svc: ExperienceService = {
        engine,
        rejections: ring,
        adminTime: time,
        playbooksAdded: added,
        async idle() {
          await Promise.all([engine.state.idle(), time.idle()]);
        },
      };
      for (const a of createActions({
        kernel,
        engine,
        ring,
        time,
        dialer: () => opts.dialer ?? defaultDialer,
        testTimeoutMs: opts.testTimeoutMs ?? 8000,
      }))
        kernel.actions.register(a);
      kernel.provide(MODULE_ID, svc);
      runtimes.set(kernel, { svc, added, cleanup });
    },
    start(kernel) {
      // Playbooks go in after every module registered, so ids others provide win.
      const rt = runtimes.get(kernel);
      if (rt) rt.added.push(...registerPlaybooks(kernel.playbooks));
    },
    stop(kernel) {
      const rt = runtimes.get(kernel);
      if (!rt) return;
      for (const fn of rt.cleanup.splice(0)) fn();
      return rt.svc.idle();
    },
  });
}

export const experienceModule = createExperienceModule();
export default experienceModule;
