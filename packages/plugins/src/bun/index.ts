// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `@beamhop/plugins/bun` — what the Bun runtime registers. Exactly two module
 * exports (`pluginHostModule`, `webhooksModule`); everything else is a factory
 * or helper, so runtime-bun's module scan picks up only these.
 */
import { lookup } from 'node:dns/promises';
import { unwatchFile, watch, watchFile } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { BeamhopModule, Kernel } from '@beamhop/core';
import { type PluginHostModuleOptions, createPluginHostModule } from '../host/module.ts';
import { readSettings } from '../host/settings.ts';
import type { ResolveHost } from '../net/ssrf.ts';
import { createWebhooksModule } from '../webhooks/index.ts';
import { type RunCommand, createBunAuthoring } from './authoring.ts';
import { BunPluginInstaller } from './installer.ts';
import { BunPluginLoader } from './loader.ts';

export { BunPluginLoader, pluginPackageName } from './loader.ts';
export { BunPluginInstaller } from './installer.ts';
export { WorkerSandbox } from './sandbox.ts';
export { createBunAuthoring, rewriteImports, bunRun, type RunCommand } from './authoring.ts';

export interface BunPluginHostOptions
  extends Omit<PluginHostModuleOptions, 'loader' | 'installer' | 'watch' | 'authoring'> {
  /** Plugins directory override (default `modules.plugins.dir` or `<dataDir>/plugins`). */
  dir?: string;
  /** Command runner for `bun add` / `bun test` (tests inject a fake). */
  run?: RunCommand;
  /** Stuck-worker kill delay override (tests). */
  hardKillMs?: number;
  /** File watcher (default `node:fs` watch). */
  watch?: PluginHostModuleOptions['watch'];
}

export function pluginsDirFor(kernel: Kernel, override?: string): string {
  const cfg = kernel.config();
  const s = readSettings(cfg.modules.plugins);
  const dir = override ?? s.dir ?? join(cfg.node.dataDir, 'plugins');
  return isAbsolute(dir) ? dir : resolve(dir);
}

/**
 * Native file events plus stat polling as a fallback (native events are not
 * delivered on some systems/sandboxes, and editors that replace files break them).
 */
export const fsWatch: NonNullable<PluginHostModuleOptions['watch']> = (path, onChange) => {
  let native: ReturnType<typeof watch> | undefined;
  try {
    native = watch(path, () => onChange());
  } catch {
    native = undefined;
  }
  const poll = (
    cur: { mtimeMs: number; size: number },
    prev: { mtimeMs: number; size: number },
  ) => {
    if (cur.mtimeMs !== prev.mtimeMs || cur.size !== prev.size) onChange();
  };
  watchFile(path, { interval: 250 }, poll);
  return () => {
    native?.close();
    unwatchFile(path, poll);
  };
};

export const dnsResolveHost: ResolveHost = async (hostname) =>
  (await lookup(hostname, { all: true })).map((a) => a.address);

export function createBunPluginHost(opts: BunPluginHostOptions = {}): BeamhopModule {
  const { dir, run, hardKillMs, watch: watchFn, ...rest } = opts;
  return createPluginHostModule({
    ...rest,
    watch: watchFn ?? fsWatch,
    loader: (kernel) =>
      new BunPluginLoader({
        dir: () => pluginsDirFor(kernel, dir),
        log: (level, msg, fields) => kernel.ports.logger.log(level, msg, fields),
        nowMs: () => kernel.ports.clock.nowMs(),
        ...(hardKillMs ? { hardKillMs } : {}),
      }),
    installer: (kernel) =>
      new BunPluginInstaller({
        dir: () => pluginsDirFor(kernel, dir),
        ...(rest.fetch ? { fetch: rest.fetch } : {}),
        ...(run ? { run } : {}),
        now: () => kernel.ports.clock.now(),
      }),
    authoring: (kernel) =>
      createBunAuthoring({ dir: () => pluginsDirFor(kernel, dir), ...(run ? { run } : {}) }),
  });
}

/** Bun plugin host: sandboxed workers, installs into the data dir, hot reload. */
export const pluginHostModule: BeamhopModule = createBunPluginHost();
/** Webhooks with DNS-checked SSRF protection. */
export const webhooksModule: BeamhopModule = createWebhooksModule({ resolveHost: dnsResolveHost });
