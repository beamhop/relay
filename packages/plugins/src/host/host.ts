// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Plugin host: keeps the set of running plugins in sync with config, registers
 * their hooks in the policy pipeline (band 300+), measures every call and
 * trips a circuit breaker on crash loops.
 *
 * Safety guard (documented exception to "suggestions are never auto-applied"):
 * a plugin that fails `breaker.threshold` times in a row (errors, timeouts,
 * sandbox crashes) is turned off automatically so it cannot take the relay
 * down. The admin gets an attention card to turn it back on or remove it.
 */
import {
  ACCEPT,
  type BeamhopConfig,
  type Decision,
  type HookName,
  type Kernel,
  type PolicyContext,
} from '@beamhop/core';
import { BUILTIN_CATALOG } from '../builtin/index.ts';
import { type Catalog, type CatalogEntry, loadCatalog, mergeCatalogs } from '../catalog/index.ts';
import {
  PLUGIN_ID_RE,
  type PluginManifest,
  type PluginPermission,
  createPluginApi,
  toPolicyHooks,
  validateManifest,
} from '../sdk/index.ts';
import { commitConfig } from './config-write.ts';
import {
  type PluginEntrySettings,
  type PluginsModuleSettings,
  entrySettings,
  readSettings,
} from './settings.ts';
import { PluginStats, type PluginStatsSnapshot } from './stats.ts';
import {
  type AuthoringBackend,
  type InstalledRecord,
  type LoadedPlugin,
  type PluginInstaller,
  type PluginLoader,
  PluginTimeoutError,
  PluginUnavailableError,
  permissionsExceed,
} from './types.ts';

export const STATE_COLLECTION = 'plugins.state';
export const INSTALLED_COLLECTION = 'plugins.installed';
export const BEAMHOP_VERSION = '0.0.0';

export type PluginStatus = 'loading' | 'running' | 'error' | 'disabled' | 'tripped';

interface TrippedState {
  tripped: true;
  reason: string;
  at: number;
}

interface Managed {
  id: string;
  status: PluginStatus;
  error?: string;
  loaded?: LoadedPlugin;
  key?: string;
  failMode: 'open' | 'closed';
  stats: PluginStats;
  failures: number;
  generation: number;
  actionIds: string[];
  unwatch?: () => void;
  watching?: string;
}

export interface PluginStatusRow {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  status: PluginStatus;
  mode?: 'in-process' | 'sandbox';
  permissions: PluginPermission[];
  error?: string;
  tripped?: { reason: string; at: number };
  stats: PluginStatsSnapshot;
}

export interface PluginHostOptions {
  kernel: Kernel;
  loader: PluginLoader;
  installer?: PluginInstaller;
  /** Used for the remote catalog and handed to plugins with the `network` permission. */
  fetch?: typeof fetch;
  /** Reads `file://` catalogs (`modules.plugins.catalogUrl`) on runtimes with a file system. */
  readFile?: (path: string) => Promise<string>;
  /** File watcher for hot reload: returns an unsubscribe function. */
  watch?: (path: string, onChange: () => void) => () => void;
  beamhopVersion?: string;
  builtinCatalog?: Catalog;
  /** Enables `test` / `install` / `uninstall` for source-code plugins (AI assistant). */
  authoring?: AuthoringBackend;
}

/** Short SDK guide for plugin authors and the AI assistant (`kernel.use('plugins').sdkGuide`). */
export const SDK_GUIDE = `Beamhop plugin SDK (import only from "@beamhop/plugins/sdk"):
definePlugin({ id, name, description, version?, permissions?, configSchema?, priority?, hooks? | on*() })
- Hooks may be given at the top level or under \`hooks\` (object, or a function (api) => hooks for per-instance state).
- Hook signatures: onConnect(ctx), onAuth(pubkey, ctx), onEvent(event, ctx), onReq(filters, ctx), onUpload(info, ctx), onBlobServe(sha256, ctx).
- ctx is plain data: { relayId, now, tier?, dryRun?, conn?: { id, ipHash, authed: string[] }, config, api }.
- Return nothing to accept, or reject(prefix, message) / shadow() / hold() (also exported). Prefixes: blocked, rate-limited, restricted, invalid, pow, auth-required, mute, error.
- api: clock.now()/nowMs(), log(level, msg), state (Map), events.query/count (needs 'read-events'), events.save ('write-events'), docs.get/put/delete/list ('docs'), fetch ('network').
- AI-written plugins are installed without permissions; keep them self-contained and fast (each call has a ~20 ms budget in the sandbox).
Tests: import { createTestbed } from "@beamhop/plugins/testbed"; const bed = createTestbed(plugin, { config }); await bed.event({ kind, content, tags }) → decision; bed.req(filters), bed.upload(info), bed.store(event) to seed data.`;

export class PluginHost {
  readonly kernel: Kernel;
  readonly loader: PluginLoader;
  readonly installer?: PluginInstaller;
  readonly beamhopVersion: string;
  private readonly fetchFn?: typeof fetch;
  private readonly readFileFn?: (path: string) => Promise<string>;
  private readonly watchFn?: PluginHostOptions['watch'];
  private readonly builtinCatalog: Catalog;
  private readonly plugins = new Map<string, Managed>();
  private readonly tripped = new Map<string, TrippedState>();
  private queue: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;
  private remoteCatalog: { at: number; entries: CatalogEntry[]; error?: string } | null = null;
  private stopped = false;

  constructor(opts: PluginHostOptions) {
    this.kernel = opts.kernel;
    this.loader = opts.loader;
    this.installer = opts.installer;
    this.fetchFn = opts.fetch;
    this.readFileFn = opts.readFile;
    this.watchFn = opts.watch;
    this.beamhopVersion = opts.beamhopVersion ?? BEAMHOP_VERSION;
    this.builtinCatalog = opts.builtinCatalog ?? BUILTIN_CATALOG;
    const a = opts.authoring;
    if (a) {
      this.test = (p) => a.test(p);
      this.install = (p) => this.installSource(a, p);
      this.uninstall = (id) => this.uninstallSource(a, id);
    }
  }

  // ── Source-code plugins (AI assistant contract; present only when supported) ──

  readonly sdkGuide = SDK_GUIDE;
  test?: (p: { id: string; code: string; tests?: string }) => Promise<{
    ok: boolean;
    passed?: number;
    failed?: number;
    output: string;
  }>;
  install?: (p: {
    id: string;
    code: string;
    enabled?: boolean;
    description?: string;
    source?: string;
  }) => Promise<{ id: string }>;
  uninstall?: (id: string) => Promise<void>;

  private async installSource(
    a: AuthoringBackend,
    p: { id: string; code: string; enabled?: boolean; source?: string },
  ): Promise<{ id: string }> {
    if (!PLUGIN_ID_RE.test(p.id) || p.id.includes('/'))
      throw new Error('That plugin id is not valid');
    if (BUILTIN_CATALOG.plugins.some((e) => e.id === p.id)) {
      throw new Error('That id belongs to a built-in plugin');
    }
    const entry = await a.writeLocal(p.id, p.code);
    const rec: InstalledRecord = {
      id: p.id,
      package: `local:${p.id}`,
      version: '0.0.0',
      entry,
      // Source plugins get no permissions until an admin approves them explicitly.
      permissions: [],
      source: 'file',
      installedAt: this.kernel.ports.clock.now(),
    };
    await this.kernel.ports.docs.put(INSTALLED_COLLECTION, p.id, rec);
    await this.untrip(p.id);
    const enabled = p.enabled ?? false;
    await this.commitConfig(
      (c) => {
        const others = c.plugins.filter((x) => x.id !== p.id);
        return { ...c, plugins: [...others, { id: p.id, enabled, config: {} }] };
      },
      {
        principalId: p.source === 'ai' ? 'ai' : 'system',
        summary: `Added plugin ${p.id}${enabled ? '' : ' (turned off)'}`,
      },
    );
    return { id: p.id };
  }

  private async uninstallSource(a: AuthoringBackend, id: string): Promise<void> {
    await this.commitConfig((c) => ({ ...c, plugins: c.plugins.filter((x) => x.id !== id) }), {
      principalId: 'system',
      summary: `Removed plugin ${id}`,
    });
    const rec = await this.installedRecord(id);
    if (rec?.source === 'file') await a.removeLocal(id);
    await this.kernel.ports.docs.delete(INSTALLED_COLLECTION, id);
    await this.untrip(id);
    await this.forget(id);
  }

  settings(config: BeamhopConfig = this.kernel.config()): PluginsModuleSettings {
    return readSettings(config.modules.plugins);
  }

  async start(): Promise<void> {
    this.stopped = false;
    const { items } = await this.kernel.ports.docs.list<TrippedState>(STATE_COLLECTION, {
      limit: 1000,
    });
    for (const { key, value } of items) if (value?.tripped) this.tripped.set(key, value);
    this.unsubscribe = this.kernel.onConfigChange(() => {
      this.reconcile().catch((err) =>
        this.kernel.ports.logger.log('error', 'plugin reconcile failed', { err: String(err) }),
      );
    });
    await this.reconcile();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe?.();
    await this.serial(async () => {
      for (const m of this.plugins.values()) await this.unload(m, 'disabled');
    });
  }

  /** Serialize all load/unload work. */
  private serial(fn: () => Promise<void>): Promise<void> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }

  /** Bring running plugins in line with the current config. */
  reconcile(): Promise<void> {
    return this.serial(() => this.reconcileNow());
  }

  /** Force a reload of one plugin (hot reload). */
  reload(id: string): Promise<void> {
    return this.serial(async () => {
      const m = this.plugins.get(id);
      if (m) m.key = undefined;
      await this.reconcileNow(id);
    });
  }

  private async reconcileNow(only?: string): Promise<void> {
    if (this.stopped) return;
    const config = this.kernel.config();
    const settings = this.settings(config);
    const desired = new Map<string, BeamhopConfig['plugins'][number]>();
    for (const p of config.plugins) if (p.enabled && !desired.has(p.id)) desired.set(p.id, p);

    for (const m of this.plugins.values()) {
      if (only && m.id !== only) continue;
      if (!desired.has(m.id)) await this.unload(m, 'disabled');
    }
    for (const [id, entry] of desired) {
      if (only && id !== only) continue;
      const m = this.managed(id);
      const es = entrySettings(settings, id);
      m.failMode = es.failMode;
      if (this.tripped.has(id)) {
        await this.unload(m, 'tripped');
        continue;
      }
      const installed = await this.installedRecord(id);
      const budget = es.timeBudgetMs ?? settings.timeBudgetMs;
      const key = JSON.stringify([entry.config ?? null, es, installed, budget, settings.hotReload]);
      if (m.key === key && m.status !== 'disabled') continue;
      m.key = key;
      await this.load(m, entry.config, es, installed, budget, settings.hotReload);
    }
  }

  private managed(id: string): Managed {
    let m = this.plugins.get(id);
    if (!m) {
      m = {
        id,
        status: 'disabled',
        failMode: 'open',
        stats: new PluginStats(),
        failures: 0,
        generation: 0,
        actionIds: [],
      };
      this.plugins.set(id, m);
    }
    return m;
  }

  async installedRecord(id: string): Promise<InstalledRecord | null> {
    return this.kernel.ports.docs.get<InstalledRecord>(INSTALLED_COLLECTION, id);
  }

  private makeApi = (id: string) => (permissions: readonly PluginPermission[], config: unknown) =>
    createPluginApi({
      id,
      permissions,
      config,
      events: this.kernel.ports.events,
      docs: this.kernel.ports.docs,
      clock: this.kernel.ports.clock,
      logger: this.kernel.ports.logger,
      fetch: this.fetchFn,
    });

  private async load(
    m: Managed,
    rawConfig: unknown,
    es: PluginEntrySettings,
    installed: InstalledRecord | null,
    timeBudgetMs: number,
    hotReload: boolean,
  ): Promise<void> {
    const log = this.kernel.ports.logger;
    const generation = ++m.generation;
    const req = {
      id: m.id,
      rawConfig,
      settings: es,
      installed,
      approved: es.approvedPermissions ?? installed?.permissions ?? null,
      timeBudgetMs,
      generation,
      makeApi: this.makeApi(m.id),
    };
    this.updateWatch(m, hotReload ? this.loader.watchPath?.(req) : undefined);
    const hadRunning = !!m.loaded;
    if (!hadRunning) m.status = 'loading';
    let loaded: LoadedPlugin;
    try {
      loaded = await this.loader.load(req);
      const manifest = validateManifest(loaded.manifest);
      if (manifest.id !== m.id) {
        await loaded.close().catch(() => {});
        throw new Error(`the code says it is plugin "${manifest.id}", not "${m.id}"`);
      }
      const extra = permissionsExceed(manifest.permissions, req.approved);
      if (extra.length > 0) {
        await loaded.close().catch(() => {});
        throw new Error(`it asks for permissions you have not approved: ${extra.join(', ')}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      m.error = msg;
      if (!hadRunning) m.status = 'error';
      log.log('warn', 'plugin could not be loaded', { plugin: m.id, err: msg });
      return;
    }
    const old = m.loaded;
    m.loaded = loaded;
    m.status = 'running';
    m.error = undefined;
    m.failures = 0;
    const hookId = `plugin.${m.id}`;
    if (loaded.hooks.length > 0) {
      this.kernel.policy.add(
        toPolicyHooks(hookId, loaded.manifest.priority, loaded.hooks, (hook, args, ctx) =>
          this.invoke(m.id, hook, args, ctx),
        ),
      );
    } else {
      this.kernel.policy.remove(hookId);
    }
    this.swapActions(m, loaded);
    log.log('info', 'plugin loaded', {
      plugin: m.id,
      version: loaded.manifest.version,
      mode: loaded.mode,
      hooks: loaded.hooks,
    });
    if (old) await old.close().catch(() => {});
  }

  private swapActions(m: Managed, loaded: LoadedPlugin | null): void {
    for (const id of m.actionIds) this.kernel.actions.unregister(id);
    m.actionIds = [];
    if (!loaded || loaded.mode !== 'in-process') return;
    for (const a of loaded.actions) {
      try {
        this.kernel.actions.register(a);
        m.actionIds.push(a.id);
      } catch (err) {
        this.kernel.ports.logger.log('warn', 'plugin action skipped', {
          plugin: m.id,
          action: a.id,
          err: String(err),
        });
      }
    }
  }

  private updateWatch(m: Managed, path: string | undefined): void {
    if (m.watching === path) return;
    m.unwatch?.();
    m.unwatch = undefined;
    m.watching = undefined;
    if (!path || !this.watchFn) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    m.unwatch = this.watchFn(path, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        this.kernel.ports.logger.log('info', 'plugin file changed; reloading', { plugin: m.id });
        this.reload(m.id).catch(() => {});
      }, 50);
    });
    m.watching = path;
  }

  private async unload(m: Managed, status: 'disabled' | 'tripped'): Promise<void> {
    this.kernel.policy.remove(`plugin.${m.id}`);
    this.swapActions(m, null);
    if (status === 'disabled') this.updateWatch(m, undefined);
    const old = m.loaded;
    m.loaded = undefined;
    m.status = status;
    m.key = undefined;
    if (old) await old.close().catch(() => {});
  }

  /** Hot path: run one hook of one plugin with stats, fail mode and breaker. */
  async invoke(
    id: string,
    hook: HookName,
    args: unknown[],
    ctx: PolicyContext | undefined,
  ): Promise<Decision> {
    const m = this.plugins.get(id);
    const loaded = m?.loaded;
    if (!m || !loaded || m.status !== 'running') return ACCEPT;
    m.stats.calls++;
    const t0 = performance.now();
    try {
      const d = await loaded.call(hook, args, ctx);
      m.stats.record(performance.now() - t0);
      m.failures = 0;
      if (d.action !== 'accept') m.stats.rejections++;
      return d;
    } catch (err) {
      if (err instanceof PluginUnavailableError) {
        return m.failMode === 'closed'
          ? {
              action: 'reject',
              prefix: 'error',
              message: 'a safety check could not run; try again later',
            }
          : ACCEPT;
      }
      m.stats.record(performance.now() - t0);
      const timeout = err instanceof PluginTimeoutError;
      if (timeout) m.stats.timeouts++;
      else m.stats.errors++;
      const msg = err instanceof Error ? err.message : String(err);
      m.stats.lastError = msg;
      m.failures++;
      const threshold = this.settings().breaker.threshold;
      if (m.failures >= threshold && m.loaded === loaded) {
        const reason = timeout
          ? `it ran out of time ${m.failures} times in a row`
          : `it failed ${m.failures} times in a row (${msg})`;
        this.trip(id, reason).catch(() => {});
      }
      if (m.failMode === 'closed') {
        return {
          action: 'reject',
          prefix: 'error',
          message: 'a safety check could not run; try again later',
        };
      }
      return ACCEPT;
    }
  }

  /** Circuit breaker: turn a crash-looping plugin off (persisted until re-enabled). */
  async trip(id: string, reason: string): Promise<void> {
    if (this.tripped.has(id)) return;
    const state: TrippedState = { tripped: true, reason, at: this.kernel.ports.clock.now() };
    this.tripped.set(id, state);
    const m = this.plugins.get(id);
    if (m) {
      // Take hooks out of the pipeline immediately, before the async close.
      this.kernel.policy.remove(`plugin.${id}`);
      m.status = 'tripped';
    }
    this.kernel.ports.logger.log('warn', 'plugin turned off by the safety switch', {
      plugin: id,
      reason,
    });
    this.kernel.bus.emit('error', {
      source: `plugin.${id}`,
      message: `Plugin turned off: ${reason}`,
    });
    await this.kernel.ports.docs.put(STATE_COLLECTION, id, state);
    await this.serial(async () => {
      const mm = this.plugins.get(id);
      if (mm) await this.unload(mm, 'tripped');
    });
  }

  /** Clear the safety switch (called by `plugins.enable`). */
  async untrip(id: string): Promise<void> {
    this.tripped.delete(id);
    const m = this.plugins.get(id);
    if (m) {
      m.failures = 0;
      m.key = undefined;
      if (m.status === 'tripped') m.status = 'disabled';
    }
    await this.kernel.ports.docs.delete(STATE_COLLECTION, id);
  }

  /** Drop all runtime state of a removed plugin (stats included). */
  forget(id: string): Promise<void> {
    return this.serial(async () => {
      const m = this.plugins.get(id);
      if (!m) return;
      await this.unload(m, 'disabled');
      this.plugins.delete(id);
    });
  }

  trippedState(id: string): { reason: string; at: number } | undefined {
    const t = this.tripped.get(id);
    return t ? { reason: t.reason, at: t.at } : undefined;
  }

  manifestOf(id: string): PluginManifest | undefined {
    return this.plugins.get(id)?.loaded?.manifest;
  }

  /** Status rows for every configured or loaded plugin. */
  status(): PluginStatusRow[] {
    const config = this.kernel.config();
    const ids = new Set<string>([...config.plugins.map((p) => p.id), ...this.plugins.keys()]);
    const rows: PluginStatusRow[] = [];
    for (const id of ids) {
      const entry = config.plugins.find((p) => p.id === id);
      const m = this.plugins.get(id);
      const man = m?.loaded?.manifest;
      const cat = this.catalogEntrySync(id);
      const t = this.trippedState(id);
      rows.push({
        id,
        name: man?.name ?? cat?.name ?? id,
        version: man?.version ?? cat?.version ?? '?',
        enabled: !!entry?.enabled,
        status: t ? 'tripped' : (m?.status ?? 'disabled'),
        ...(m?.loaded ? { mode: m.loaded.mode } : {}),
        permissions: man?.permissions ?? cat?.permissions ?? [],
        ...(m?.error ? { error: m.error } : {}),
        ...(t ? { tripped: t } : {}),
        stats: (m?.stats ?? new PluginStats()).snapshot(),
      });
    }
    return rows.sort((a, b) => a.id.localeCompare(b.id));
  }

  // ── Catalog ──

  private catalogEntrySync(id: string): CatalogEntry | undefined {
    return (
      this.builtinCatalog.plugins.find((e) => e.id === id) ??
      this.remoteCatalog?.entries.find((e) => e.id === id)
    );
  }

  /** Built-in catalog merged with the signed remote / local file catalog (cached 10 minutes). */
  async catalog(opts: { refresh?: boolean } = {}): Promise<{
    entries: CatalogEntry[];
    remoteError?: string;
  }> {
    const s = this.settings();
    if (!s.catalogUrl) return { entries: mergeCatalogs(this.builtinCatalog) };
    const now = this.kernel.ports.clock.now();
    if (opts.refresh || !this.remoteCatalog || now - this.remoteCatalog.at > 600) {
      try {
        const remote = await loadCatalog(s.catalogUrl, s.catalogPubkeys, {
          fetch: this.fetchFn ?? fetch,
          ...(this.readFileFn ? { readFile: this.readFileFn } : {}),
        });
        this.remoteCatalog = { at: now, entries: remote.plugins };
      } catch (err) {
        this.remoteCatalog = {
          at: now,
          entries: this.remoteCatalog?.entries ?? [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    const remote = this.remoteCatalog;
    return {
      entries: mergeCatalogs(this.builtinCatalog, { version: 1, plugins: remote.entries }),
      ...(remote.error ? { remoteError: remote.error } : {}),
    };
  }

  async catalogEntry(id: string): Promise<CatalogEntry | undefined> {
    return (await this.catalog()).entries.find((e) => e.id === id);
  }

  // ── Config writes ──

  /** Commit a config change through the admin config service (audited) or the kernel. */
  async commitConfig(
    mutate: (c: BeamhopConfig) => BeamhopConfig,
    opts: { principalId: string; summary: string; reason?: string },
  ): Promise<void> {
    await commitConfig(this.kernel, mutate, opts);
    await this.reconcile();
  }
}
