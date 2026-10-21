// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Turn statically imported module namespaces (from the generated import map, §9:
 * plugins are compiled into the bundle, never eval'd) into BeamhopModules.
 *
 * Accepted plugin shapes, checked in order on `default` then named exports:
 * 1. a BeamhopModule (`{ id, register }`)
 * 2. PolicyHooks (`{ id, priority, on*() }`) → wrapped in a module that adds the hooks
 * 3. a factory function `(pluginConfig) => (1) | (2)`
 */
import {
  type BeamhopConfig,
  type BeamhopModule,
  type PolicyHooks,
  defineModule,
} from '@beamhop/core';

export type Namespace = Record<string, unknown>;

export function isModule(v: unknown): v is BeamhopModule {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as BeamhopModule).id === 'string' &&
    typeof (v as BeamhopModule).register === 'function'
  );
}

const HOOK_NAMES = ['onConnect', 'onAuth', 'onEvent', 'onReq', 'onUpload', 'onBlobServe'] as const;

export function isPolicyHooks(v: unknown): v is PolicyHooks {
  if (!v || typeof v !== 'object') return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h.id === 'string' &&
    typeof h.priority === 'number' &&
    HOOK_NAMES.some((n) => typeof h[n] === 'function')
  );
}

function policyModule(pluginId: string, hooks: PolicyHooks): BeamhopModule {
  return defineModule({
    id: `plugin.${pluginId}`,
    register(kernel) {
      kernel.policy.add(hooks);
    },
  });
}

function fromValue(pluginId: string, v: unknown, pluginConfig: unknown): BeamhopModule | null {
  if (isModule(v)) return v;
  if (isPolicyHooks(v)) return policyModule(pluginId, v);
  if (typeof v === 'function' && !/^class[\s{]/.test(Function.prototype.toString.call(v))) {
    try {
      const made = (v as (c: unknown) => unknown)(pluginConfig);
      if (isModule(made)) return made;
      if (isPolicyHooks(made)) return policyModule(pluginId, made);
    } catch {
      return null;
    }
  }
  return null;
}

/** All BeamhopModules exported by a built-in package namespace (default first, deduped by id). */
export function modulesFromNamespace(ns: Namespace): BeamhopModule[] {
  const out = new Map<string, BeamhopModule>();
  const values = ['default' in ns ? ns.default : undefined, ...Object.values(ns)];
  for (const v of values) if (isModule(v) && !out.has(v.id)) out.set(v.id, v);
  return [...out.values()];
}

/** Resolve one plugin namespace into a single module, or null when it has no usable export. */
export function pluginModule(
  pluginId: string,
  ns: Namespace,
  pluginConfig: unknown,
): BeamhopModule | null {
  const candidates = ['default' in ns ? ns.default : undefined, ...Object.values(ns)];
  for (const v of candidates) {
    const m = fromValue(pluginId, v, pluginConfig);
    if (m) return m;
  }
  return null;
}

export interface BundledModules {
  /** Package name → namespace for built-in feature packages. */
  builtins?: Record<string, Namespace>;
  /** Plugin id → namespace, generated from `config.plugins`. */
  plugins?: Record<string, Namespace>;
}

/**
 * Final module list for a config. Plugins disabled in the *runtime* config are skipped
 * (they are still in the bundle until the next deploy).
 */
export function resolveModules(
  bundled: BundledModules,
  config: BeamhopConfig,
  warn: (msg: string, fields?: Record<string, unknown>) => void = () => {},
): BeamhopModule[] {
  const out: BeamhopModule[] = [];
  const seen = new Set<string>();
  const push = (m: BeamhopModule) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    out.push(m);
  };
  for (const [pkg, ns] of Object.entries(bundled.builtins ?? {})) {
    const mods = modulesFromNamespace(ns);
    if (mods.length === 0) warn('Built-in package has no module export', { package: pkg });
    for (const m of mods) push(m);
  }
  for (const p of config.plugins) {
    if (!p.enabled) continue;
    const ns = bundled.plugins?.[p.id];
    if (!ns) {
      warn('Plugin is enabled but was not bundled; redeploy to include it', { plugin: p.id });
      continue;
    }
    const m = pluginModule(p.id, ns, p.config);
    if (m) push(m);
    else warn('Plugin has no usable export', { plugin: p.id });
  }
  return out;
}
