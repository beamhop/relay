// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `@beamhop/plugins/sdk` — write a policy plugin:
 *
 *   export default definePlugin({ id, name, description, version, permissions,
 *     configSchema, hooks: { onEvent(event, ctx) { … } } });
 */
import {
  ACCEPT,
  type BeamhopModule,
  type Decision,
  type HookName,
  type Kernel,
  type PolicyContext,
  type PolicyHooks,
  type ReasonPrefix,
} from '@beamhop/core';
import { z } from 'zod';
import { createPluginApi } from './api.ts';
import { toCtxView } from './context.ts';
import { type DefinitionLike, PLUGIN_KIND, instantiate, parsePluginConfig } from './instance.ts';
import { clampPriority, validateManifest } from './manifest.ts';
import { HOOK_NAMES, type PluginInput, type PluginManifest, type PluginSpec } from './types.ts';

export * from './types.ts';
export { createPluginApi, PluginPermissionError, type PluginApiDeps } from './api.ts';
export { toCtxView } from './context.ts';
export {
  instantiate,
  isPluginDefinition,
  parsePluginConfig,
  PluginConfigError,
  sanitizeDecision,
  PLUGIN_KIND,
  type DefinitionLike,
  type PluginInstance,
} from './instance.ts';
export {
  ManifestSchema,
  PLUGIN_BAND,
  PLUGIN_ID_RE,
  clampPriority,
  compareSemver,
  validateManifest,
} from './manifest.ts';

/**
 * A plugin definition. It is also a `BeamhopModule` (id `plugin.<id>`) so that
 * runtimes which only understand modules (e.g. runtime-cf's plain import map)
 * can register it directly; the plugin host is the richer path (sandbox,
 * stats, circuit breaker, hot reload).
 */
export interface PluginDefinition<S extends z.ZodType = z.ZodType>
  extends DefinitionLike,
    BeamhopModule {
  readonly kind: typeof PLUGIN_KIND;
  readonly manifest: PluginManifest;
  readonly spec: PluginSpec<S>;
}

export function definePlugin<S extends z.ZodType = z.ZodType>(
  input: PluginInput<S>,
): PluginDefinition<S> {
  const topLevel: Record<string, unknown> = {};
  for (const n of HOOK_NAMES) {
    const fn = (input as unknown as Record<string, unknown>)[n];
    if (typeof fn === 'function') topLevel[n] = fn;
  }
  const spec: PluginSpec<S> = {
    ...input,
    version: input.version ?? '0.0.0',
    permissions: input.permissions ?? [],
    configSchema: input.configSchema ?? (z.any() as unknown as S),
    hooks: input.hooks ?? (topLevel as PluginSpec<S>['hooks']),
  };
  const manifest = validateManifest({
    id: spec.id,
    name: spec.name,
    description: spec.description,
    version: spec.version,
    permissions: spec.permissions,
    priority: clampPriority(spec.priority),
  });
  const def: PluginDefinition<S> = {
    kind: PLUGIN_KIND,
    manifest,
    spec,
    id: `plugin.${manifest.id}`,
    async register(kernel: Kernel) {
      await registerStandalone(def as unknown as DefinitionLike, kernel);
    },
  };
  return def;
}

/** Standalone in-process registration (no host): used when a runtime treats the plugin as a module. */
async function registerStandalone(def: DefinitionLike, kernel: Kernel): Promise<void> {
  const entry = kernel.config().plugins.find((p) => p.id === def.manifest.id);
  if (!entry || !entry.enabled) return;
  const config = parsePluginConfig(def.spec, entry.config);
  const api = createPluginApi({
    id: def.manifest.id,
    permissions: def.manifest.permissions,
    config,
    events: kernel.ports.events,
    docs: kernel.ports.docs,
    clock: kernel.ports.clock,
    logger: kernel.ports.logger,
  });
  const inst = await instantiate(def, api);
  kernel.policy.add(
    toPolicyHooks(
      `plugin.${def.manifest.id}`,
      inst.manifest.priority,
      inst.hooks,
      (hook, args, ctx) => inst.call(hook, args, toCtxView(ctx)),
    ),
  );
  for (const a of inst.actions) kernel.actions.register(a);
}

/** Build a core `PolicyHooks` object that forwards only the implemented hooks. */
export function toPolicyHooks(
  id: string,
  priority: number,
  hooks: readonly HookName[],
  invoke: (hook: HookName, args: unknown[], ctx: PolicyContext | undefined) => Promise<Decision>,
): PolicyHooks {
  const out: PolicyHooks = { id, priority };
  const rec = out as unknown as Record<string, (...a: unknown[]) => Promise<Decision>>;
  for (const h of hooks) {
    rec[h] = (...args: unknown[]) => {
      const ctx = args[args.length - 1] as PolicyContext | undefined;
      return invoke(h, args.slice(0, -1), ctx);
    };
  }
  return out;
}

// ── Decision helpers ──
export const accept = (): Decision => ACCEPT;
export const reject = (prefix: ReasonPrefix, message: string): Decision => ({
  action: 'reject',
  prefix,
  message,
});
export const shadow = (message?: string): Decision =>
  message ? { action: 'shadow', message } : { action: 'shadow' };
export const hold = (message?: string): Decision =>
  message ? { action: 'hold', message } : { action: 'hold' };
