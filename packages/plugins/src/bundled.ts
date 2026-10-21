// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bundled plugin host (Cloudflare, tests, any runtime without eval): plugins
 * come from a static import map generated at deploy time by runtime-cf
 * (`plugins: { "<id>": namespace }`, bare id → `beamhop-plugin-<id>`), plus
 * Beamhop's built-in plugins. Everything runs in-process; nothing is loaded
 * at runtime. Accepts the same export shapes as runtime-cf: a `definePlugin`
 * definition, `PolicyHooks`, or a factory `(config) => …`.
 *
 *   import { createBundledPluginHost } from '@beamhop/plugins';
 *   createCloudflareRuntime({ ..., modules: [createBundledPluginHost(plugins)] });
 */
import type { BeamhopModule } from '@beamhop/core';
import { BUILTIN_PLUGINS } from './builtin/index.ts';
import { loadDefinition, loadNamespace } from './host/inprocess.ts';
import { type PluginHostModuleOptions, createPluginHostModule } from './host/module.ts';
import type { LoadRequest, LoadedPlugin, PluginLoader } from './host/types.ts';
import { PluginLoadError } from './host/types.ts';
import type { DefinitionLike } from './sdk/index.ts';

export type PluginNamespace = Record<string, unknown>;
export type PluginImportMap = Record<string, PluginNamespace>;

export class BundledPluginLoader implements PluginLoader {
  readonly canInstall = false;
  constructor(
    private readonly importMap: PluginImportMap,
    private readonly builtins: Readonly<Record<string, DefinitionLike>> = BUILTIN_PLUGINS,
  ) {}

  async load(req: LoadRequest): Promise<LoadedPlugin> {
    const ns = this.importMap[req.id];
    if (ns) return loadNamespace(req.id, ns, req);
    const def = this.builtins[req.id];
    if (def) return loadDefinition(def, req);
    throw new PluginLoadError(
      'This plugin was not included when the relay was deployed; deploy again to add it',
    );
  }
}

export interface BundledHostOptions extends Omit<PluginHostModuleOptions, 'loader' | 'installer'> {
  builtins?: Readonly<Record<string, DefinitionLike>>;
}

/** The `plugins` module for runtimes that bundle plugins at build time. */
export function createBundledPluginHost(
  importMap: PluginImportMap = {},
  opts: BundledHostOptions = {},
): BeamhopModule {
  const { builtins, ...rest } = opts;
  return createPluginHostModule({ ...rest, loader: new BundledPluginLoader(importMap, builtins) });
}
