// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Optional modules (enterprise…): switched on and off while running by adding or
 * removing their `config.modules[id]` section. Runtimes describe which optional
 * modules they can load ({@link OptionalModuleSource}); {@link manageOptionalModules}
 * watches config changes and hot-enables/disables them via `kernel.enableModule` /
 * `kernel.disableModule`, and exposes a {@link ModuleManager} service
 * (`kernel.use(MODULE_MANAGER_SERVICE)`) for the `modules.*` admin actions.
 *
 * Generic on purpose: core knows no module ids; runtimes supply loaders.
 */
import type { BeamhopConfig } from './config.ts';
import type { BeamhopModule, Kernel } from './modules.ts';

export const MODULE_MANAGER_SERVICE = 'runtime.modules';

export interface OptionalModuleSource {
  /** Module id (= `config.modules` key). */
  id: string;
  /** Load the module (dynamic import / bundled namespace). Undefined when not available. */
  load(): Promise<BeamhopModule | undefined>;
  /** Minimal valid config section written when an admin turns the module on (default `{}`). */
  defaultSection?(): Promise<Record<string, unknown>>;
  /** False when this runtime cannot load it (e.g. not bundled). Default true. */
  available?: boolean;
}

export interface OptionalModuleState {
  id: string;
  available: boolean;
  /** Registered with the kernel right now. */
  enabled: boolean;
  /** `config.modules[id]` exists. */
  configured: boolean;
  /** Plain-language reason the last enable failed, if it did. */
  error?: string;
}

export interface ModuleManager {
  list(): OptionalModuleState[];
  has(id: string): boolean;
  /** Section to write into `config.modules[id]` to turn it on. */
  defaultSection(id: string): Promise<Record<string, unknown>>;
  /** Bring loaded modules in line with the current config (also runs on every config change). */
  sync(): Promise<void>;
}

function wanted(config: BeamhopConfig, id: string): boolean {
  return Object.hasOwn(config.modules, id) && config.modules[id] !== undefined;
}

/**
 * Watch config changes and hot-enable/disable the given optional modules.
 * Returns the manager (also provided as {@link MODULE_MANAGER_SERVICE}).
 * Config listeners return the sync promise, so `kernel.applyConfig()` (and the
 * admin config service) resolves only once the module is loaded or unloaded, and
 * fails (rolling the revision back) when loading fails.
 */
export function manageOptionalModules(
  kernel: Kernel,
  sources: OptionalModuleSource[],
): ModuleManager {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const loaded = new Map<string, BeamhopModule>();
  const unavailable = new Set<string>();
  const errors = new Map<string, string>();
  const log = kernel.ports.logger;

  const sync = async (config: BeamhopConfig = kernel.config()): Promise<void> => {
    if (!kernel.enableModule || !kernel.disableModule) return;
    const failures: unknown[] = [];
    // Turn off first (reverse order), then on, so dependents are handled sensibly.
    for (const s of [...sources].reverse()) {
      if (wanted(config, s.id) || !kernel.isEnabled(s.id)) continue;
      try {
        await kernel.disableModule(s.id);
        log.log('info', 'optional module turned off', { module: s.id });
      } catch (err) {
        failures.push(err);
      }
    }
    for (const s of sources) {
      if (!wanted(config, s.id) || kernel.isEnabled(s.id)) continue;
      try {
        let m = loaded.get(s.id);
        if (!m) {
          m = s.available === false ? undefined : await s.load();
          if (!m) {
            unavailable.add(s.id);
            throw new Error(`${s.id} is not available on this server`);
          }
          loaded.set(s.id, m);
        }
        await kernel.enableModule(m);
        errors.delete(s.id);
        log.log('info', 'optional module turned on', { module: s.id });
      } catch (err) {
        errors.set(s.id, String(err instanceof Error ? err.message : err));
        log.log('error', 'optional module could not be turned on', {
          module: s.id,
          err: String(err),
        });
        failures.push(err);
      }
    }
    if (failures.length) throw failures[0];
  };

  const manager: ModuleManager = {
    list() {
      const config = kernel.config();
      return sources.map((s) => {
        const st: OptionalModuleState = {
          id: s.id,
          available: s.available !== false && !unavailable.has(s.id),
          enabled: kernel.isEnabled(s.id),
          configured: wanted(config, s.id),
        };
        const e = errors.get(s.id);
        if (e) st.error = e;
        return st;
      });
    },
    has: (id) => byId.has(id),
    async defaultSection(id) {
      const s = byId.get(id);
      return s?.defaultSection ? s.defaultSection() : {};
    },
    sync: () => sync(),
  };
  kernel.onConfigChange((next) => sync(next));
  kernel.provide(MODULE_MANAGER_SERVICE, manager);
  return manager;
}
