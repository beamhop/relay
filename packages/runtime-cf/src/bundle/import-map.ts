// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Plugin bundling (§9): Workers cannot eval or load code at runtime, so the deploy
 * build discovers enabled plugins from config and generates a Worker entry with a
 * static import map. Pure function; the CLI (`cli.ts`) supplies file resolution.
 */
import { type BeamhopConfig, parseConfig } from '@beamhop/core';
import { BUILTIN_PLUGINS } from '@beamhop/plugins';

/** Feature packages bundled by default. Missing ones are skipped with a warning. */
export const DEFAULT_BUILTINS = [
  '@beamhop/relay',
  '@beamhop/policy',
  '@beamhop/blossom',
  '@beamhop/admin-api',
] as const;

/**
 * Optional (enterprise) module id → package. A package is bundled when one of its modules
 * has a `config.modules[id]` section, or for all of them with `enterprise: true`
 * (`--enterprise`), so they can be turned on later from the admin app without a redeploy.
 * Bundled optional modules still stay off until configured (§12.0).
 */
export const OPTIONAL_MODULE_PACKAGES: Readonly<Record<string, string>> = {
  'enterprise-compliance': '@beamhop/enterprise-compliance',
  'enterprise-network': '@beamhop/enterprise-compliance',
  'enterprise-identity': '@beamhop/enterprise-identity',
  'enterprise-keyvault': '@beamhop/enterprise-keyvault',
};

/** Optional packages to bundle for `config` (deduped, stable order). */
export function optionalPackages(config: BeamhopConfig, all = false): string[] {
  const out: string[] = [];
  for (const [id, pkg] of Object.entries(OPTIONAL_MODULE_PACKAGES)) {
    if ((all || config.modules[id] !== undefined) && !out.includes(pkg)) out.push(pkg);
  }
  return out;
}

/** Package of the bundled plugin host (`createBundledPluginHost`). */
export const PLUGINS_PACKAGE = '@beamhop/plugins';

/** Plugin ids shipped inside `@beamhop/plugins` (no npm package to bundle). */
export const BUILTIN_PLUGIN_IDS: readonly string[] = Object.keys(BUILTIN_PLUGINS);

/**
 * Plugin id → npm package. Scoped or path-like ids are used as-is;
 * bare ids map to `beamhop-plugin-<id>`.
 */
export function pluginPackageName(id: string): string {
  if (id.startsWith('@') || id.includes('/')) return id;
  return `beamhop-plugin-${id}`;
}

export interface ImportMapInput {
  /** Raw config (validated here, inlined as-is so schema defaults apply at runtime). */
  config: unknown;
  builtins?: readonly string[];
  /**
   * Resolve a package to the import specifier to emit, or null when it is not installed.
   * The CLI returns a path relative to the generated file.
   */
  resolve: (pkg: string) => string | null;
  /** Specifier for `@beamhop/runtime-cf` (as resolved by the caller). */
  runtimeSpecifier: string;
  /** Inline the config into the bundle (default true). */
  inlineConfig?: boolean;
  /** Bundle every optional (enterprise) package, configured or not. */
  enterprise?: boolean;
  /** Ids served by the plugin host's built-ins (default: `BUILTIN_PLUGINS` keys). */
  builtinPlugins?: readonly string[];
}

export interface ImportMapResult {
  code: string;
  builtins: Array<{ pkg: string; specifier: string }>;
  plugins: Array<{ id: string; pkg: string; specifier: string }>;
  /** Built-in packages that were not installed (skipped). */
  skipped: string[];
  /** Enabled plugins that could not be resolved (build must fail). */
  missing: Array<{ id: string; pkg: string }>;
  /** Enabled built-in plugins (served by the plugin host, not imported separately). */
  builtinPlugins: string[];
  /** `@beamhop/plugins` specifier when the plugin host is bundled. */
  pluginHost: string | null;
}

const str = (s: string) => JSON.stringify(s);

export function generateImportMap(input: ImportMapInput): ImportMapResult {
  const config: BeamhopConfig = parseConfig(input.config ?? {});
  const builtins: ImportMapResult['builtins'] = [];
  const skipped: string[] = [];
  const wanted = [...(input.builtins ?? DEFAULT_BUILTINS)];
  for (const pkg of optionalPackages(config, input.enterprise)) {
    if (!wanted.includes(pkg)) wanted.push(pkg);
  }
  for (const pkg of wanted) {
    const specifier = input.resolve(pkg);
    if (specifier) builtins.push({ pkg, specifier });
    else skipped.push(pkg);
  }
  const plugins: ImportMapResult['plugins'] = [];
  const missing: ImportMapResult['missing'] = [];
  const builtinPlugins: string[] = [];
  const builtinIds = new Set(input.builtinPlugins ?? BUILTIN_PLUGIN_IDS);
  const pluginHost = input.resolve(PLUGINS_PACKAGE);
  const seen = new Set<string>();
  for (const p of config.plugins) {
    if (!p.enabled || seen.has(p.id)) continue;
    seen.add(p.id);
    // Built-in plugins live inside @beamhop/plugins: nothing to import for them.
    if (builtinIds.has(p.id) && pluginHost) {
      builtinPlugins.push(p.id);
      continue;
    }
    const pkg = pluginPackageName(p.id);
    const specifier = input.resolve(pkg);
    if (specifier) plugins.push({ id: p.id, pkg, specifier });
    else missing.push({ id: p.id, pkg });
  }

  const lines: string[] = [
    '// SPDX-License-Identifier: AGPL-3.0-or-later',
    '// AUTO-GENERATED by @beamhop/runtime-cf (beamhop-cf-build). Do not edit.',
    '// Static import map: plugins are compiled into the Worker, never loaded at runtime.',
    `import { createCloudflareRuntime } from ${str(input.runtimeSpecifier)};`,
  ];
  if (pluginHost) lines.push(`import { createBundledPluginHost } from ${str(pluginHost)};`);
  builtins.forEach((b, i) => {
    lines.push(`import * as builtin${i} from ${str(b.specifier)};`);
  });
  plugins.forEach((p, i) => {
    lines.push(`import * as plugin${i} from ${str(p.specifier)};`);
  });
  lines.push('');
  lines.push(
    `const config: unknown = ${input.inlineConfig === false ? 'undefined' : JSON.stringify(input.config ?? {})};`,
  );
  lines.push('');
  lines.push('const plugins = {');
  plugins.forEach((p, i) => {
    lines.push(`  ${str(p.id)}: plugin${i},`);
  });
  lines.push('};');
  lines.push('');
  lines.push('const runtime = createCloudflareRuntime({');
  lines.push('  config,');
  lines.push('  builtins: {');
  builtins.forEach((b, i) => {
    lines.push(`    ${str(b.pkg)}: builtin${i},`);
  });
  lines.push('  },');
  if (pluginHost) {
    // The plugin host loads enabled plugins (bundled ones + built-ins), with the
    // plugin admin actions, circuit breaker and stats.
    lines.push('  modules: [createBundledPluginHost(plugins)],');
  } else {
    lines.push('  plugins,');
  }
  lines.push('});');
  lines.push('');
  lines.push('export default runtime.worker;');
  lines.push('export class RelayRoom extends runtime.RelayRoom {}');
  lines.push('');
  return {
    code: lines.join('\n'),
    builtins,
    plugins,
    skipped,
    missing,
    builtinPlugins,
    pluginHost,
  };
}
