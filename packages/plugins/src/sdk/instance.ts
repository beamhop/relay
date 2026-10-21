// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Turning a plugin definition into a callable instance. Runtime-agnostic and
 * kernel-free: used in-process by the hosts and inside the sandbox worker.
 */
import type { ActionDef, Decision, HookName, ReasonPrefix } from '@beamhop/core';
import { clampPriority, validateManifest } from './manifest.ts';
import type {
  CtxView,
  PluginApi,
  PluginHookContext,
  PluginHooks,
  PluginManifest,
  PluginSpec,
} from './types.ts';
import { HOOK_NAMES } from './types.ts';

export const PLUGIN_KIND = 'beamhop-plugin';

/** Minimal structural shape of a definition (a plugin may bundle its own SDK copy). */
export interface DefinitionLike {
  kind: typeof PLUGIN_KIND;
  manifest: PluginManifest;
  spec: PluginSpec;
}

export function isPluginDefinition(v: unknown): v is DefinitionLike {
  return (
    !!v &&
    typeof v === 'object' &&
    (v as DefinitionLike).kind === PLUGIN_KIND &&
    typeof (v as DefinitionLike).spec === 'object' &&
    typeof (v as DefinitionLike).manifest === 'object'
  );
}

export class PluginConfigError extends Error {
  constructor(
    message: string,
    readonly issues: Array<{ path: string; message: string }> = [],
  ) {
    super(message);
    this.name = 'PluginConfigError';
  }
}

/** Validate raw config against the plugin's schema. */
export function parsePluginConfig(spec: Pick<PluginSpec, 'configSchema'>, raw: unknown): unknown {
  const r = spec.configSchema.safeParse(raw ?? {});
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => ({
    path: i.path.map(String).join('.') || '(root)',
    message: i.message,
  }));
  throw new PluginConfigError(
    `Plugin settings are not valid: ${issues.map((i) => `${i.path} ${i.message}`).join('; ')}`,
    issues,
  );
}

export interface PluginInstance {
  manifest: PluginManifest;
  hooks: HookName[];
  call(hook: HookName, args: unknown[], ctx: CtxView): Promise<Decision>;
  actions: ActionDef[];
  dispose(): Promise<void>;
}

const PREFIXES: ReadonlySet<string> = new Set<ReasonPrefix>([
  'duplicate',
  'pow',
  'blocked',
  'rate-limited',
  'invalid',
  'restricted',
  'auth-required',
  'mute',
  'error',
]);

/** Normalize whatever a plugin returned into a valid Decision (untrusted input). */
export function sanitizeDecision(v: unknown): Decision {
  if (v === undefined || v === null) return { action: 'accept' };
  if (typeof v !== 'object') throw new Error('plugin returned a non-object decision');
  const d = v as Record<string, unknown>;
  const msg = (x: unknown) => (typeof x === 'string' ? x.slice(0, 300) : undefined);
  switch (d.action) {
    case 'accept':
      return { action: 'accept' };
    case 'reject': {
      const prefix = typeof d.prefix === 'string' && PREFIXES.has(d.prefix) ? d.prefix : 'blocked';
      return {
        action: 'reject',
        prefix: prefix as ReasonPrefix,
        message: msg(d.message) ?? 'not allowed',
      };
    }
    case 'shadow': {
      const m = msg(d.message);
      return m ? { action: 'shadow', message: m } : { action: 'shadow' };
    }
    case 'hold': {
      const m = msg(d.message);
      return m ? { action: 'hold', message: m } : { action: 'hold' };
    }
    default:
      throw new Error(`plugin returned an unknown decision: ${String(d.action)}`);
  }
}

/**
 * Create an instance: validates manifest + config, runs the hooks factory.
 * `api` must already carry the parsed config.
 */
export async function instantiate(
  def: DefinitionLike,
  api: PluginApi<unknown>,
  opts: { priority?: number } = {},
): Promise<PluginInstance> {
  const manifest = validateManifest({
    ...def.manifest,
    priority: clampPriority(opts.priority ?? def.manifest.priority),
  });
  const spec = def.spec;
  const hooks: PluginHooks<unknown> =
    typeof spec.hooks === 'function' ? await spec.hooks(api) : spec.hooks;
  const names = HOOK_NAMES.filter(
    (n) => typeof (hooks as Record<string, unknown>)[n] === 'function',
  );
  const rawActions = typeof spec.actions === 'function' ? spec.actions(api) : (spec.actions ?? []);
  const actions = rawActions.map((a) => ({ ...a, id: `plugin.${manifest.id}.${a.id}` }));
  return {
    manifest,
    hooks: names,
    actions,
    async call(hook, args, ctx) {
      const fn = (hooks as Record<string, (...a: unknown[]) => unknown>)[hook];
      if (!fn) return { action: 'accept' };
      const hctx: PluginHookContext<unknown> = { ...ctx, config: api.config, api };
      return sanitizeDecision(await fn.apply(hooks, [...args, hctx]));
    },
    async dispose() {
      await spec.dispose?.(api);
    },
  };
}
