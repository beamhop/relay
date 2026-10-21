// SPDX-License-Identifier: AGPL-3.0-or-later
/** In-process loading for trusted plugins (built-ins, bundled, `trusted: true`). */
import type { Decision, HookName, PolicyContext, PolicyHooks } from '@beamhop/core';
import {
  type DefinitionLike,
  HOOK_NAMES,
  clampPriority,
  instantiate,
  isPluginDefinition,
  parsePluginConfig,
  sanitizeDecision,
  toCtxView,
} from '../sdk/index.ts';
import {
  type LoadRequest,
  type LoadedPlugin,
  PluginLoadError,
  permissionsExceed,
} from './types.ts';

export async function loadDefinition(def: DefinitionLike, req: LoadRequest): Promise<LoadedPlugin> {
  const extra = permissionsExceed(def.manifest.permissions, req.approved);
  if (extra.length > 0) {
    throw new PluginLoadError(
      `The plugin asks for permissions you have not approved: ${extra.join(', ')}`,
    );
  }
  const config = parsePluginConfig(def.spec, req.rawConfig);
  const api = req.makeApi(def.manifest.permissions, config);
  const inst = await instantiate(def, api, { priority: req.settings.priority });
  return {
    manifest: inst.manifest,
    hooks: inst.hooks,
    mode: 'in-process',
    actions: inst.actions,
    call: (hook, args, ctx) => inst.call(hook, args, toCtxView(ctx)),
    close: () => inst.dispose(),
  };
}

function isPolicyHooks(v: unknown): v is PolicyHooks {
  if (!v || typeof v !== 'object') return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h.id === 'string' &&
    typeof h.priority === 'number' &&
    HOOK_NAMES.some((n) => typeof h[n] === 'function')
  );
}

function isPlainFunction(v: unknown): v is (c: unknown) => unknown {
  return typeof v === 'function' && !/^class[\s{]/.test(Function.prototype.toString.call(v));
}

/** Legacy shapes (runtime-cf convention): PolicyHooks or `(config) => PolicyHooks`. */
function loadLegacyHooks(id: string, hooks: PolicyHooks, req: LoadRequest): LoadedPlugin {
  const names = HOOK_NAMES.filter(
    (n) => typeof (hooks as unknown as Record<string, unknown>)[n] === 'function',
  );
  return {
    manifest: {
      id,
      name: id,
      description: '',
      version: '0.0.0',
      permissions: [],
      priority: clampPriority(req.settings.priority ?? hooks.priority),
    },
    hooks: names,
    mode: 'in-process',
    actions: [],
    async call(hook: HookName, args: unknown[], ctx: PolicyContext | undefined): Promise<Decision> {
      const fn = (hooks as unknown as Record<string, (...a: unknown[]) => unknown>)[hook];
      if (!fn) return { action: 'accept' };
      return sanitizeDecision(await fn.apply(hooks, [...args, ctx]));
    },
    async close() {},
  };
}

export type ResolvedExport =
  | { kind: 'definition'; def: DefinitionLike }
  | { kind: 'hooks'; hooks: PolicyHooks }
  | { kind: 'factory'; fn: (c: unknown) => unknown };

/** Find the plugin in a module namespace (`default` first, then named exports). */
export function resolveExport(ns: Record<string, unknown>): ResolvedExport | null {
  const candidates = ['default' in ns ? ns.default : undefined, ...Object.values(ns)];
  for (const v of candidates) if (isPluginDefinition(v)) return { kind: 'definition', def: v };
  for (const v of candidates) if (isPolicyHooks(v)) return { kind: 'hooks', hooks: v };
  for (const v of candidates) if (isPlainFunction(v)) return { kind: 'factory', fn: v };
  return null;
}

/** Load whatever a namespace exports, in-process. */
export async function loadNamespace(
  id: string,
  ns: Record<string, unknown>,
  req: LoadRequest,
): Promise<LoadedPlugin> {
  const r = resolveExport(ns);
  if (!r) throw new PluginLoadError('The package does not export a plugin');
  if (r.kind === 'definition') return loadDefinition(r.def, req);
  if (r.kind === 'hooks') return loadLegacyHooks(id, r.hooks, req);
  const made = await r.fn(req.rawConfig);
  if (isPluginDefinition(made)) return loadDefinition(made, req);
  if (isPolicyHooks(made)) return loadLegacyHooks(id, made, req);
  throw new PluginLoadError('The package does not export a plugin');
}
