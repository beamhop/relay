// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * System module: in-app updates with automatic backup + rollback, doctor and
 * resource advisor (§14, §6.7, §6.11). Runtime-agnostic: the runtime provides
 * `runtime.updater`, `runtime.doctor` and `runtime.host` where it can (Bun
 * single binary); elsewhere the actions explain what to do instead.
 */
import { type BeamhopModule, type Kernel, defineModule } from '@beamhop/core';
import { createSystemActions } from './actions.ts';
import { UpdateManager, type UpdateOptions } from './update.ts';

export * from './types.ts';
export {
  BUSY_PHASES,
  CLOUDFLARE_HOW_TO,
  SOURCE_HOW_TO,
  UPDATE_COL,
  VERIFY_JOB,
  UpdateManager,
  signatureBlock,
  summarizeNotes,
  type UpdateCheckOutput,
  type UpdateOptions,
  type UpdatePhase,
  type UpdateState,
  type UpdateStatus,
} from './update.ts';
export {
  FIX_RULES,
  fromFinding,
  fromHealth,
  runDoctorReport,
  type DoctorFix,
  type DoctorReport,
  type DoctorResult,
  type DoctorTone,
} from './doctor.ts';
export {
  COLD_MIN_BYTES,
  COLD_STALE_DAYS,
  COLD_STORAGE_ACTION,
  CONFIG_ADVICE,
  advise,
  coldStorageConfigured,
  daysLeft,
  gatherFacts,
  recommendSize,
  runAdvisor,
  type Advice,
  type AdvisorFacts,
  type AdvisorReport,
  type MachineSize,
} from './advisor.ts';

export const SYSTEM_MODULE_ID = 'system';
/** `kernel.use<UpdateManager>(SYSTEM_SERVICE)`. */
export const SYSTEM_SERVICE = 'system.updates';

const managers = new WeakMap<Kernel, UpdateManager>();

export function createSystemModule(opts: UpdateOptions = {}): BeamhopModule {
  return defineModule({
    id: SYSTEM_MODULE_ID,
    register(kernel) {
      const updates = new UpdateManager(kernel, opts);
      managers.set(kernel, updates);
      kernel.provide(SYSTEM_SERVICE, updates);
      for (const a of createSystemActions(kernel, updates)) kernel.actions.register(a);
    },
    async start(kernel) {
      try {
        await managers.get(kernel)?.onBoot();
      } catch (err) {
        kernel.ports.logger.log('error', 'update self-test could not start', {
          module: SYSTEM_MODULE_ID,
          err: String(err),
        });
      }
    },
    async stop(kernel) {
      const m = managers.get(kernel);
      m?.stop();
      managers.delete(kernel);
    },
  });
}

export const systemModule = createSystemModule();
