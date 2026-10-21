// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bun plugin loader: built-ins and `trusted` plugins run in-process; anything
 * else runs in a {@link WorkerSandbox}. Sources: built-in id, local file,
 * npm package installed in the plugins directory.
 */
import { isAbsolute, resolve } from 'node:path';
import { BUILTIN_PLUGINS } from '../builtin/index.ts';
import { loadDefinition, loadNamespace } from '../host/inprocess.ts';
import type { LoadRequest, LoadedPlugin, PluginLoader } from '../host/types.ts';
import { PluginLoadError } from '../host/types.ts';
import type { DefinitionLike, PluginPermission } from '../sdk/index.ts';
import { WorkerSandbox } from './sandbox.ts';

/** Same rule as runtime-cf's import map: bare id → `beamhop-plugin-<id>`. */
export function pluginPackageName(id: string): string {
  if (id.startsWith('@') || id.includes('/')) return id;
  return `beamhop-plugin-${id}`;
}

export type ResolvedSource =
  | { kind: 'builtin'; def: DefinitionLike }
  | { kind: 'file'; path: string; local: boolean };

export interface BunLoaderOptions {
  /** Plugins directory (npm packages are resolved from here). */
  dir: () => string;
  builtins?: Readonly<Record<string, DefinitionLike>>;
  log: (
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    fields?: Record<string, unknown>,
  ) => void;
  nowMs: () => number;
  /** Override the sandbox stuck-worker kill delay (tests). */
  hardKillMs?: number;
}

export class BunPluginLoader implements PluginLoader {
  readonly canInstall = true;
  private readonly builtins: Readonly<Record<string, DefinitionLike>>;

  constructor(private readonly opts: BunLoaderOptions) {
    this.builtins = opts.builtins ?? BUILTIN_PLUGINS;
  }

  resolveSource(req: Pick<LoadRequest, 'id' | 'settings' | 'installed'>): ResolvedSource {
    const src = req.settings.source;
    if (!src) {
      const def = this.builtins[req.id];
      if (def) return { kind: 'builtin', def };
      if (req.installed?.entry) {
        return { kind: 'file', path: req.installed.entry, local: req.installed.source === 'file' };
      }
      return { kind: 'file', path: this.resolvePackage(pluginPackageName(req.id)), local: false };
    }
    if (src.startsWith('file:')) return { kind: 'file', path: resolve(src.slice(5)), local: true };
    if (isAbsolute(src) || src.startsWith('./') || src.startsWith('../')) {
      return { kind: 'file', path: resolve(src), local: true };
    }
    if (src.startsWith('builtin:')) {
      const def = this.builtins[src.slice(8)];
      if (!def) throw new PluginLoadError(`There is no built-in plugin called “${src.slice(8)}”`);
      return { kind: 'builtin', def };
    }
    return { kind: 'file', path: this.resolvePackage(src), local: false };
  }

  private resolvePackage(pkg: string): string {
    try {
      return Bun.resolveSync(pkg, this.opts.dir());
    } catch {
      throw new PluginLoadError(`The plugin package ${pkg} is not installed`);
    }
  }

  watchPath(req: Pick<LoadRequest, 'id' | 'settings' | 'installed'>): string | undefined {
    try {
      const s = this.resolveSource(req);
      return s.kind === 'file' && s.local ? s.path : undefined;
    } catch {
      return undefined;
    }
  }

  async load(req: LoadRequest): Promise<LoadedPlugin> {
    const src = this.resolveSource(req);
    if (src.kind === 'builtin') return loadDefinition(src.def, req);
    // Cache-busting query so a reload picks up the new file.
    const entry = `${src.path}?v=${req.generation}`;
    if (req.settings.trusted) {
      let ns: Record<string, unknown>;
      try {
        ns = (await import(entry)) as Record<string, unknown>;
      } catch (err) {
        throw new PluginLoadError(`The plugin code could not be loaded: ${String(err)}`);
      }
      return loadNamespace(req.id, ns, req);
    }
    return WorkerSandbox.start({
      id: req.id,
      entry,
      config: req.rawConfig,
      approved: req.approved as PluginPermission[] | null,
      ...(req.settings.priority !== undefined ? { priority: req.settings.priority } : {}),
      timeBudgetMs: req.timeBudgetMs,
      ...(this.opts.hardKillMs ? { hardKillMs: this.opts.hardKillMs } : {}),
      ...(req.settings.maxMemoryMb ? { maxMemoryMb: req.settings.maxMemoryMb } : {}),
      makeApi: req.makeApi,
      nowMs: this.opts.nowMs,
      log: this.opts.log,
    });
  }
}
