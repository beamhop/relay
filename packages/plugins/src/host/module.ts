// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  type AttentionCard,
  type BeamhopModule,
  type CardSource,
  type Kernel,
  defineModule,
} from '@beamhop/core';
import { pluginActions } from './actions.ts';
import { PluginHost, type PluginHostOptions } from './host.ts';
import { PluginsModuleSchema } from './settings.ts';
import type { AuthoringBackend, PluginInstaller, PluginLoader } from './types.ts';

export const PLUGINS_MODULE_ID = 'plugins';
/** `kernel.use<PluginHost>(PLUGINS_SERVICE)` */
export const PLUGINS_SERVICE = 'plugins';

export interface PluginHostModuleOptions
  extends Omit<PluginHostOptions, 'kernel' | 'loader' | 'installer' | 'authoring'> {
  loader: PluginLoader | ((kernel: Kernel) => PluginLoader);
  installer?: PluginInstaller | ((kernel: Kernel) => PluginInstaller | undefined);
  authoring?: AuthoringBackend | ((kernel: Kernel) => AuthoringBackend | undefined);
}

/** Attention cards for plugins the safety switch turned off. */
export function pluginCards(host: PluginHost): CardSource {
  return {
    id: 'plugins',
    async cards(relayId) {
      const out: AttentionCard[] = [];
      for (const row of host.status()) {
        if (!row.tripped) continue;
        out.push({
          id: `plugins.tripped.${row.id}`,
          relayId,
          severity: 'warning',
          title: `“${row.name}” was turned off to keep your relay running`,
          body: `Beamhop switched this plugin off because ${row.tripped.reason}. Everything else keeps working. You can turn it back on or remove it.`,
          technical: `circuit breaker tripped at ${row.tripped.at}; last error: ${row.stats.lastError ?? 'n/a'}; timeouts=${row.stats.timeouts} errors=${row.stats.errors}`,
          batchKey: 'plugins.tripped',
          createdAt: row.tripped.at,
          primary: { label: 'Turn it back on', actionId: 'plugins.enable', input: { id: row.id } },
          secondary: { label: 'Remove it', actionId: 'plugins.uninstall', input: { id: row.id } },
        });
      }
      return out;
    },
  };
}

/** Build the `plugins` module around a loader (Bun: sandbox + files; Cloudflare: bundled). */
export function createPluginHostModule(opts: PluginHostModuleOptions): BeamhopModule {
  let host: PluginHost | undefined;
  return defineModule({
    id: PLUGINS_MODULE_ID,
    configSchema: PluginsModuleSchema,
    register(kernel) {
      const loader = typeof opts.loader === 'function' ? opts.loader(kernel) : opts.loader;
      const installer =
        typeof opts.installer === 'function' ? opts.installer(kernel) : opts.installer;
      const authoring =
        typeof opts.authoring === 'function' ? opts.authoring(kernel) : opts.authoring;
      host = new PluginHost({ ...opts, kernel, loader, installer, authoring });
      for (const a of pluginActions(host)) kernel.actions.register(a);
      kernel.cards.push(pluginCards(host));
      kernel.provide(PLUGINS_SERVICE, host);
    },
    async start() {
      await host?.start();
    },
    async stop() {
      await host?.stop();
    },
  });
}
