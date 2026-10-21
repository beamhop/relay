// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Sandbox worker: imports one untrusted plugin and answers hook calls. Runs
 * in a Bun Worker with an empty environment; every capability goes through
 * the host (RPC) except `fetch`, which is only restored when the plugin has
 * the `network` permission.
 */
import {
  type PluginApi,
  type PluginInstance,
  type PluginPermission,
  instantiate,
  isPluginDefinition,
  parsePluginConfig,
} from '../sdk/index.ts';
import type { HostToWorker, RpcMethod, WorkerToHost } from './protocol.ts';

interface WorkerScope {
  postMessage(m: WorkerToHost): void;
  onmessage: ((e: MessageEvent<HostToWorker>) => void) | null;
}
const scope = globalThis as unknown as WorkerScope;
const post = (m: WorkerToHost) => scope.postMessage(m);

const realFetch = globalThis.fetch;
const blockedFetch = (() =>
  Promise.reject(
    new Error('this plugin does not have the network permission'),
  )) as unknown as typeof fetch;
// No network until the manifest says otherwise (also covers top-level code at import).
globalThis.fetch = blockedFetch;

let instance: PluginInstance | null = null;
let clockOffset = 0;
let rpcSeq = 0;
const rpcPending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();

function rpc(method: RpcMethod, ...args: unknown[]): Promise<never> {
  const id = ++rpcSeq;
  return new Promise((resolve, reject) => {
    rpcPending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ t: 'rpc', id, method, args });
  });
}

function makeApi(id: string, permissions: PluginPermission[], config: unknown): PluginApi<unknown> {
  const has = (p: PluginPermission) => permissions.includes(p);
  return {
    id,
    config,
    permissions,
    clock: {
      now: () => Math.floor((Date.now() + clockOffset) / 1000),
      nowMs: () => Date.now() + clockOffset,
    },
    log: (level, msg, fields) => post({ t: 'log', level, msg, ...(fields ? { fields } : {}) }),
    state: new Map(),
    events: {
      query: (relayId, filters, opts) => rpc('events.query', relayId, filters, opts),
      count: (relayId, filters) => rpc('events.count', relayId, filters),
      save: (relayId, event) => rpc('events.save', relayId, event),
    },
    docs: {
      get: (key) => rpc('docs.get', key),
      put: (key, value) => rpc('docs.put', key, value),
      delete: (key) => rpc('docs.delete', key),
      list: (opts) => rpc('docs.list', opts),
    },
    fetch: (input, init) =>
      has('network')
        ? realFetch(input as Request, init)
        : Promise.reject(new Error('this plugin does not have the network permission')),
  };
}

async function init(m: Extract<HostToWorker, { t: 'init' }>): Promise<void> {
  clockOffset = m.nowMs - Date.now();
  const ns = (await import(m.entry)) as Record<string, unknown>;
  const candidates = ['default' in ns ? ns.default : undefined, ...Object.values(ns)];
  let def = candidates.find(isPluginDefinition);
  if (!def) {
    // Factory export `(config) => definition`.
    for (const c of candidates) {
      if (typeof c !== 'function') continue;
      try {
        const made = await (c as (x: unknown) => unknown)(m.config);
        if (isPluginDefinition(made)) {
          def = made;
          break;
        }
      } catch {
        // not a factory
      }
    }
  }
  if (!def) throw new Error('The package does not export a plugin made with definePlugin()');
  const wanted = def.manifest.permissions;
  if (m.approved) {
    const extra = wanted.filter((p) => !m.approved?.includes(p));
    if (extra.length > 0) {
      throw new Error(`The plugin asks for permissions you have not approved: ${extra.join(', ')}`);
    }
  }
  if (wanted.includes('network')) globalThis.fetch = realFetch;
  const config = parsePluginConfig(def.spec, m.config);
  instance = await instantiate(def, makeApi(def.manifest.id, wanted, config), {
    priority: m.priority,
  });
  post({ t: 'ready', manifest: instance.manifest, hooks: instance.hooks });
  if (m.memoryReportMs > 0) {
    setInterval(
      () => post({ t: 'mem', heapUsed: process.memoryUsage().heapUsed }),
      m.memoryReportMs,
    );
  }
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.t === 'init') {
    init(m).catch((err) =>
      post({ t: 'init-error', error: err instanceof Error ? err.message : String(err) }),
    );
    return;
  }
  if (m.t === 'rpc-res') {
    const p = rpcPending.get(m.id);
    if (!p) return;
    rpcPending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(new Error(m.error ?? 'host call failed'));
    return;
  }
  if (m.t === 'call') {
    clockOffset = m.nowMs - Date.now();
    const inst = instance;
    if (!inst) {
      post({ t: 'result', id: m.id, ok: false, error: 'plugin is not ready' });
      return;
    }
    inst.call(m.hook, m.args, m.ctx).then(
      (decision) => post({ t: 'result', id: m.id, ok: true, decision }),
      (err) =>
        post({
          t: 'result',
          id: m.id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }),
    );
  }
};
