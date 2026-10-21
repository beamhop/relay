// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Host side of the Bun Worker sandbox for untrusted plugins.
 *
 * - Each call gets a time budget; past it the call fails (fail mode applies).
 *   If the late answer still has not arrived after `hardKillMs`, the worker is
 *   assumed stuck (e.g. an endless loop) and is terminated and respawned.
 * - Memory: the worker reports its heap; above `maxMemoryMb` it is restarted
 *   (soft limit — Bun has no hard per-worker heap cap).
 * - Only plain data crosses the boundary (structured clone): the event,
 *   filters and a context without connection objects.
 */
import type { ActionDef, Decision, HookName, PolicyContext } from '@beamhop/core';
import {
  type LoadedPlugin,
  PluginCrashError,
  PluginLoadError,
  PluginTimeoutError,
  PluginUnavailableError,
} from '../host/types.ts';
import type { PluginApi, PluginManifest } from '../sdk/index.ts';
import { toCtxView } from '../sdk/index.ts';
import type { HostToWorker, RpcMethod, WorkerToHost } from './protocol.ts';

const WORKER_URL = new URL('./worker-entry.ts', import.meta.url).href;

export interface SandboxOptions {
  id: string;
  /** Absolute path of the plugin module. */
  entry: string;
  config: unknown;
  approved: PluginManifest['permissions'] | null;
  priority?: number;
  timeBudgetMs: number;
  /** Default max(1000, 25 × budget). */
  hardKillMs?: number;
  /** Load (import + setup) timeout. Default 10 s. */
  initTimeoutMs?: number;
  maxMemoryMb?: number;
  /** Host-side API used to serve the worker's RPC calls. */
  makeApi(
    permissions: readonly PluginManifest['permissions'][number][],
    config: unknown,
  ): PluginApi<unknown>;
  nowMs(): number;
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    fields?: Record<string, unknown>,
  ): void;
}

interface Pending {
  resolve(d: Decision): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
  killTimer?: ReturnType<typeof setTimeout>;
  timedOut: boolean;
}

export class WorkerSandbox implements LoadedPlugin {
  readonly mode = 'sandbox' as const;
  readonly actions: ActionDef[] = [];
  manifest!: PluginManifest;
  hooks: HookName[] = [];
  private worker: Worker | null = null;
  private state: 'starting' | 'ready' | 'restarting' | 'broken' | 'closed' = 'starting';
  private pending = new Map<number, Pending>();
  private seq = 0;
  private api: PluginApi<unknown> | null = null;
  private brokenReason = '';

  private constructor(private readonly opts: SandboxOptions) {}

  static async start(opts: SandboxOptions): Promise<WorkerSandbox> {
    const s = new WorkerSandbox(opts);
    await s.spawn();
    return s;
  }

  private spawn(): Promise<void> {
    const o = this.opts;
    const worker = new Worker(WORKER_URL, { smol: true, env: {} } as WorkerOptions);
    this.worker = worker;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(initTimer);
        this.kill(worker);
        reject(new PluginLoadError(msg));
      };
      const initTimer = setTimeout(
        () => fail('The plugin took too long to start'),
        o.initTimeoutMs ?? 10_000,
      );
      worker.onmessage = (e: MessageEvent<WorkerToHost>) => {
        const m = e.data;
        if (m.t === 'ready') {
          if (settled) return;
          settled = true;
          clearTimeout(initTimer);
          this.manifest = m.manifest;
          this.hooks = m.hooks;
          this.api = o.makeApi(m.manifest.permissions, o.config);
          this.state = 'ready';
          resolve();
          return;
        }
        if (m.t === 'init-error') return fail(m.error);
        this.onMessage(worker, m);
      };
      worker.addEventListener('error', (e) => {
        const msg = (e as ErrorEvent).message ?? 'worker error';
        if (!settled) return fail(msg);
        o.log('warn', 'plugin sandbox error', { plugin: o.id, err: msg });
      });
      worker.addEventListener('close', () => {
        if (!settled) return fail('The plugin sandbox stopped while starting');
        if (this.worker === worker && this.state === 'ready') this.crashed('stopped unexpectedly');
      });
      const init: HostToWorker = {
        t: 'init',
        id: o.id,
        entry: o.entry,
        config: o.config,
        approved: o.approved,
        nowMs: o.nowMs(),
        memoryReportMs: o.maxMemoryMb ? 1000 : 0,
        ...(o.priority !== undefined ? { priority: o.priority } : {}),
      };
      worker.postMessage(init);
    });
  }

  private kill(worker: Worker): void {
    worker.onmessage = null;
    try {
      worker.terminate();
    } catch {
      // already gone
    }
  }

  /** The worker died or was killed: fail in-flight calls, respawn in the background. */
  private crashed(reason: string): void {
    if (this.state === 'closed' || this.state === 'restarting') return;
    const o = this.opts;
    o.log('warn', 'plugin sandbox restarted', { plugin: o.id, reason });
    if (this.worker) this.kill(this.worker);
    this.worker = null;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      if (p.killTimer) clearTimeout(p.killTimer);
      if (!p.timedOut) p.reject(new PluginCrashError(`plugin sandbox ${reason}`));
      this.pending.delete(id);
    }
    this.state = 'restarting';
    this.spawn().then(
      () => {
        if (this.state === 'closed' && this.worker) this.kill(this.worker);
      },
      (err) => {
        if (this.state === 'closed') return;
        this.state = 'broken';
        this.brokenReason = err instanceof Error ? err.message : String(err);
        o.log('warn', 'plugin sandbox could not restart', { plugin: o.id, err: this.brokenReason });
      },
    );
  }

  private onMessage(worker: Worker, m: WorkerToHost): void {
    if (worker !== this.worker) return;
    switch (m.t) {
      case 'result': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        clearTimeout(p.timer);
        if (p.killTimer) clearTimeout(p.killTimer);
        if (p.timedOut) return;
        if (m.ok) p.resolve(m.decision);
        else p.reject(new Error(m.error));
        return;
      }
      case 'rpc':
        this.serveRpc(worker, m.id, m.method, m.args);
        return;
      case 'log':
        this.opts.log(m.level, m.msg, { ...m.fields, plugin: this.opts.id });
        return;
      case 'mem': {
        const max = this.opts.maxMemoryMb;
        if (max && m.heapUsed > max * 1024 * 1024) {
          this.crashed(`used too much memory (${Math.round(m.heapUsed / 1048576)} MB)`);
        }
        return;
      }
      default:
        return;
    }
  }

  private serveRpc(worker: Worker, id: number, method: RpcMethod, args: unknown[]): void {
    const api = this.api;
    const run = async (): Promise<unknown> => {
      if (!api) throw new Error('not ready');
      const a = args as [never, never, never];
      switch (method) {
        case 'events.query':
          return api.events.query(a[0], a[1], a[2]);
        case 'events.count':
          return api.events.count(a[0], a[1]);
        case 'events.save':
          return api.events.save(a[0], a[1]);
        case 'docs.get':
          return api.docs.get(a[0]);
        case 'docs.put':
          return api.docs.put(a[0], a[1]);
        case 'docs.delete':
          return api.docs.delete(a[0]);
        case 'docs.list':
          return api.docs.list(a[0]);
        default:
          throw new Error(`unknown host call ${String(method)}`);
      }
    };
    run().then(
      (value) => {
        if (worker === this.worker) worker.postMessage({ t: 'rpc-res', id, ok: true, value });
      },
      (err) => {
        if (worker === this.worker) {
          worker.postMessage({
            t: 'rpc-res',
            id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },
    );
  }

  call(hook: HookName, args: unknown[], ctx: PolicyContext | undefined): Promise<Decision> {
    if (this.state === 'restarting') return Promise.reject(new PluginUnavailableError());
    if (this.state === 'broken') {
      return Promise.reject(new PluginCrashError(`plugin sandbox is broken: ${this.brokenReason}`));
    }
    if (this.state !== 'ready' || !this.worker) {
      return Promise.reject(new PluginUnavailableError('plugin sandbox is not running'));
    }
    const worker = this.worker;
    const id = ++this.seq;
    const budget = this.opts.timeBudgetMs;
    const hardKill = this.opts.hardKillMs ?? Math.max(1000, budget * 25);
    return new Promise<Decision>((resolve, reject) => {
      const p: Pending = {
        resolve,
        reject,
        timedOut: false,
        timer: setTimeout(() => {
          p.timedOut = true;
          reject(new PluginTimeoutError(budget));
          // Still no answer much later → the worker is stuck; restart it.
          p.killTimer = setTimeout(() => {
            if (this.pending.get(id) === p && this.worker === worker) {
              this.crashed('was stuck and had to be stopped');
            }
          }, hardKill);
        }, budget),
      };
      this.pending.set(id, p);
      const msg: HostToWorker = {
        t: 'call',
        id,
        hook,
        args,
        ctx: toCtxView(ctx),
        nowMs: this.opts.nowMs(),
      };
      try {
        worker.postMessage(msg);
      } catch (err) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async close(): Promise<void> {
    this.state = 'closed';
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      if (p.killTimer) clearTimeout(p.killTimer);
      if (!p.timedOut) p.reject(new PluginUnavailableError('plugin was unloaded'));
    }
    this.pending.clear();
    if (this.worker) this.kill(this.worker);
    this.worker = null;
  }
}
