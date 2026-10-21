// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @beamhop/plugins — runtime-agnostic parts: SDK re-exports, bundled host
 * (Cloudflare / tests), catalog, built-in plugins and webhooks.
 * The Bun host (sandbox, installer, hot reload) lives in `@beamhop/plugins/bun`.
 *
 * Note: this entry intentionally exports no always-on module instance; the
 * runtimes decide which modules to register (`createBundledPluginHost`,
 * `createWebhooksModule`, or `@beamhop/plugins/bun`).
 */
export * from './sdk/index.ts';
export {
  BundledPluginLoader,
  createBundledPluginHost,
  type BundledHostOptions,
  type PluginImportMap,
  type PluginNamespace,
} from './bundled.ts';
export * from './catalog/index.ts';
export {
  BUILTIN_CATALOG,
  BUILTIN_PLUGINS,
  buildTrustSet,
  parseNip05,
  verifyNip05,
} from './builtin/index.ts';
export {
  PluginHost,
  SDK_GUIDE,
  STATE_COLLECTION,
  INSTALLED_COLLECTION,
  type PluginHostOptions,
  type PluginStatus,
  type PluginStatusRow,
} from './host/host.ts';
export {
  PLUGINS_MODULE_ID,
  PLUGINS_SERVICE,
  createPluginHostModule,
  pluginCards,
  type PluginHostModuleOptions,
} from './host/module.ts';
export { pluginActions, permissionLines } from './host/actions.ts';
export {
  PluginsModuleSchema,
  PluginEntrySettingsSchema,
  type PluginsModuleSettings,
} from './host/settings.ts';
export * from './host/types.ts';
export type { PluginStatsSnapshot } from './host/stats.ts';
export { loadDefinition, loadNamespace, resolveExport } from './host/inprocess.ts';
export * from './net/ssrf.ts';
export * from './webhooks/index.ts';
