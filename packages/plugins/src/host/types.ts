// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ActionDef, Decision, HookName, PolicyContext } from '@beamhop/core';
import type { CatalogEntry } from '../catalog/index.ts';
import type { PluginApi, PluginManifest, PluginPermission } from '../sdk/index.ts';
import type { PluginEntrySettings } from './settings.ts';

/** A plugin installed into the data directory (DocStore `plugins.installed`). */
export interface InstalledRecord {
  id: string;
  package: string;
  version: string;
  integrity?: string;
  /** Absolute path of the module entry to import. */
  entry?: string;
  /** Permissions the admin approved at install time. */
  permissions: PluginPermission[];
  source: 'builtin' | 'catalog' | 'npm' | 'file';
  installedAt: number;
}

export interface LoadRequest {
  id: string;
  rawConfig: unknown;
  settings: PluginEntrySettings;
  installed: InstalledRecord | null;
  /** Permissions the admin approved (null = whatever the manifest declares). */
  approved: PluginPermission[] | null;
  timeBudgetMs: number;
  /** Increments on every (re)load; used for cache-busting imports. */
  generation: number;
  /** Host-side capabilities for this plugin (in-process use and sandbox RPC). */
  makeApi(permissions: readonly PluginPermission[], config: unknown): PluginApi<unknown>;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  hooks: HookName[];
  mode: 'in-process' | 'sandbox';
  actions: ActionDef[];
  /** Throws {@link PluginTimeoutError} / {@link PluginCrashError} / any error on failure. */
  call(hook: HookName, args: unknown[], ctx: PolicyContext | undefined): Promise<Decision>;
  close(): Promise<void>;
}

export interface PluginLoader {
  load(req: LoadRequest): Promise<LoadedPlugin>;
  /** Local file to watch for hot reload, if any. */
  watchPath?(req: Pick<LoadRequest, 'id' | 'settings' | 'installed'>): string | undefined;
  /** Can this loader run plugins that are not compiled in? (false on Cloudflare) */
  readonly canInstall: boolean;
}

export interface PluginInstaller {
  /** Download + verify + install; returns the record to persist. */
  install(entry: CatalogEntry): Promise<InstalledRecord>;
  remove(rec: InstalledRecord): Promise<void>;
}

/** Source-code plugins (AI generated or pasted): run tests and keep files locally. Bun only. */
export interface AuthoringBackend {
  test(p: { id: string; code: string; tests?: string }): Promise<{
    ok: boolean;
    passed?: number;
    failed?: number;
    output: string;
  }>;
  /** Write the plugin source; returns the absolute entry path. */
  writeLocal(id: string, code: string): Promise<string>;
  removeLocal(id: string): Promise<void>;
}

export class PluginTimeoutError extends Error {
  constructor(ms: number) {
    super(`plugin did not answer within ${ms} ms`);
    this.name = 'PluginTimeoutError';
  }
}

export class PluginCrashError extends Error {
  constructor(message = 'plugin sandbox stopped unexpectedly') {
    super(message);
    this.name = 'PluginCrashError';
  }
}

/** The sandbox is restarting: the call is answered by the fail mode but not counted as a failure. */
export class PluginUnavailableError extends Error {
  constructor(message = 'plugin sandbox is restarting') {
    super(message);
    this.name = 'PluginUnavailableError';
  }
}

export class PluginLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginLoadError';
  }
}

export function permissionsExceed(
  wanted: readonly PluginPermission[],
  approved: readonly PluginPermission[] | null,
): PluginPermission[] {
  if (!approved) return [];
  return wanted.filter((p) => !approved.includes(p));
}
