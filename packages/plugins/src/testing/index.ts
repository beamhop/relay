// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Plugin test harness (`@beamhop/plugins/testing`, alias `@beamhop/plugins/testbed`).
 *
 *   const tb = await createPluginTestbed({ plugin: myPlugin, config: { … } });
 *   expectReject(await tb.event({ content: 'spam' }), 'blocked');
 *
 * A real kernel with in-memory ports runs the plugin through the same host the
 * relay uses, so decisions, stats and the circuit breaker behave as in production.
 */
import {
  type BeamhopModule,
  type Decision,
  type Filter,
  type Kernel,
  type NostrEvent,
  type PolicyContext,
  type UploadInfo,
  createKernel,
  parseConfig,
} from '@beamhop/core';
import { type TestKey, makeEvent, makeKey, memoryPorts } from '@beamhop/testkit';
import { createBundledPluginHost } from '../bundled.ts';
import type { PluginHost } from '../host/host.ts';
import { PLUGINS_SERVICE } from '../host/module.ts';
import type { PluginEntrySettings } from '../host/settings.ts';
import type { DefinitionLike } from '../sdk/index.ts';

type MemPorts = ReturnType<typeof memoryPorts>;

export interface TestbedPlugin {
  plugin: DefinitionLike;
  config?: unknown;
  /** Host run settings (fail mode, priority…). */
  run?: Partial<PluginEntrySettings>;
  enabled?: boolean;
}

export interface TestbedOptions {
  /** One plugin… */
  plugin?: DefinitionLike;
  config?: unknown;
  run?: Partial<PluginEntrySettings>;
  /** …or several. */
  plugins?: TestbedPlugin[];
  /** Fetch handed to plugins with the `network` permission (default: throws). */
  fetch?: typeof fetch;
  /** Extra modules to register before the plugin host. */
  modules?: BeamhopModule[];
  relayId?: string;
  ports?: Partial<MemPorts>;
}

export type EventInput =
  | NostrEvent
  | Partial<Pick<NostrEvent, 'kind' | 'tags' | 'content' | 'created_at'>>;

export interface CtxInput {
  relayId?: string;
  tier?: string;
  dryRun?: boolean;
  /** Connection fields (a fake connection is created when any is given). */
  conn?: { id?: string; ipHash?: string; authed?: string[]; userAgent?: string };
}

export interface PluginTestbed {
  kernel: Kernel;
  ports: MemPorts;
  host: PluginHost;
  /** Default author for events built from partials. */
  key: TestKey;
  newKey(): TestKey;
  /** Sign (when partial) and run `onEvent`. */
  event(e?: EventInput, opts?: CtxInput & { key?: TestKey }): Promise<Decision & { by?: string }>;
  req(filters: Filter[], opts?: CtxInput): Promise<Decision & { by?: string }>;
  upload(info: Partial<UploadInfo>, opts?: CtxInput): Promise<Decision & { by?: string }>;
  connect(opts?: CtxInput): Promise<Decision & { by?: string }>;
  auth(pubkey: string, opts?: CtxInput): Promise<Decision & { by?: string }>;
  blobServe(sha256: string, opts?: CtxInput): Promise<Decision & { by?: string }>;
  /** Store an event directly (e.g. follow lists, profiles) without running hooks. */
  store(e: EventInput, opts?: { key?: TestKey; relayId?: string }): Promise<NostrEvent>;
  /** Build and sign an event without running hooks. */
  sign(e?: EventInput, key?: TestKey): NostrEvent;
  /** Change plugin settings (hot reload through the config path). */
  configure(id: string, config: unknown): Promise<void>;
  status(): ReturnType<PluginHost['status']>;
  close(): Promise<void>;
}

function fakeConn(c: NonNullable<CtxInput['conn']>, relayId: string, now: number) {
  return {
    id: c.id ?? 'conn-1',
    relayId,
    ipHash: c.ipHash ?? 'iphash-1',
    userAgent: c.userAgent,
    openedAt: now,
    authed: new Set(c.authed ?? []),
    challenge: 'challenge',
    state: new Map(),
    send() {},
    bufferedAmount: () => 0,
    close() {},
  };
}

export async function createPluginTestbed(opts: TestbedOptions): Promise<PluginTestbed> {
  const list: TestbedPlugin[] = [
    ...(opts.plugin ? [{ plugin: opts.plugin, config: opts.config, run: opts.run }] : []),
    ...(opts.plugins ?? []),
  ];
  if (list.length === 0) throw new Error('createPluginTestbed: pass `plugin` or `plugins`');
  const relayId = opts.relayId ?? 'default';
  const ports = memoryPorts(opts.ports as Partial<MemPorts>) as MemPorts;
  const builtins: Record<string, DefinitionLike> = {};
  const entries: Record<string, unknown> = {};
  for (const p of list) {
    builtins[p.plugin.manifest.id] = p.plugin;
    if (p.run) entries[p.plugin.manifest.id] = p.run;
  }
  const config = parseConfig({
    relays: [{ id: relayId, hosts: ['*'] }],
    plugins: list.map((p) => ({
      id: p.plugin.manifest.id,
      enabled: p.enabled ?? true,
      config: p.config ?? {},
    })),
    modules: { plugins: { entries } },
  });
  const noNetwork = (() =>
    Promise.reject(
      new Error('no network in tests: pass `fetch` to the testbed'),
    )) as unknown as typeof fetch;
  const kernel = await createKernel({
    runtime: 'test',
    ports,
    config,
    modules: [
      ...(opts.modules ?? []),
      createBundledPluginHost({}, { builtins, fetch: opts.fetch ?? noNetwork }),
    ],
  });
  const host = kernel.use<PluginHost>(PLUGINS_SERVICE)!;
  const key = makeKey();

  const ctx = (o: CtxInput = {}): PolicyContext => {
    const rid = o.relayId ?? relayId;
    const now = ports.clock.now();
    return {
      relayId: rid,
      now,
      ...(o.tier ? { tier: o.tier } : {}),
      ...(o.dryRun ? { dryRun: true } : {}),
      ...(o.conn ? { conn: fakeConn(o.conn, rid, now) } : {}),
    };
  };
  const sign = (e: EventInput = {}, k: TestKey = key): NostrEvent =>
    'sig' in e && typeof e.sig === 'string'
      ? (e as NostrEvent)
      : makeEvent(k, { created_at: ports.clock.now(), ...(e as object) });

  return {
    kernel,
    ports,
    host,
    key,
    newKey: makeKey,
    sign,
    event: (e, o = {}) => kernel.policy.run('onEvent', [sign(e, o.key), ctx(o)]),
    req: (filters, o) => kernel.policy.run('onReq', [filters, ctx(o)]),
    upload: (info, o) =>
      kernel.policy.run('onUpload', [
        { sha256: 'a'.repeat(64), size: 1024, type: 'image/png', pubkey: key.pk, ...info },
        ctx(o),
      ]),
    connect: (o) => kernel.policy.run('onConnect', [ctx(o)]),
    auth: (pubkey, o) => kernel.policy.run('onAuth', [pubkey, ctx(o)]),
    blobServe: (sha, o) => kernel.policy.run('onBlobServe', [sha, ctx(o)]),
    async store(e, o = {}) {
      const ev = sign(e, o.key);
      await ports.events.save(o.relayId ?? relayId, ev);
      return ev;
    },
    async configure(id, cfg) {
      const cur = kernel.config();
      await kernel.applyConfig(
        parseConfig({
          ...cur,
          plugins: cur.plugins.map((p) => (p.id === id ? { ...p, config: cfg } : p)),
        }),
      );
      await host.reconcile();
    },
    status: () => host.status(),
    close: () => host.stop(),
  };
}

// ── Assertions (framework-agnostic: they throw) ──

export function expectAccept(d: Decision): void {
  if (d.action !== 'accept') {
    throw new Error(
      `expected accept, got ${d.action}${'message' in d && d.message ? `: ${d.message}` : ''}`,
    );
  }
}

export function expectReject(d: Decision, prefix?: string, message?: string | RegExp): void {
  if (d.action !== 'reject') throw new Error(`expected reject, got ${d.action}`);
  if (prefix && d.prefix !== prefix) throw new Error(`expected prefix ${prefix}, got ${d.prefix}`);
  if (
    message &&
    !(typeof message === 'string' ? d.message.includes(message) : message.test(d.message))
  ) {
    throw new Error(`reject message “${d.message}” does not match ${String(message)}`);
  }
}

export function expectDecision(d: Decision, action: Decision['action']): void {
  if (d.action !== action) throw new Error(`expected ${action}, got ${d.action}`);
}

// ── Simple synchronous form (used by AI-generated tests) ──

export interface SimpleTestbed {
  event(e?: EventInput, opts?: CtxInput & { key?: TestKey }): Promise<Decision & { by?: string }>;
  req(filters: Filter[], opts?: CtxInput): Promise<Decision & { by?: string }>;
  upload(info: Partial<UploadInfo>, opts?: CtxInput): Promise<Decision & { by?: string }>;
  connect(opts?: CtxInput): Promise<Decision & { by?: string }>;
  auth(pubkey: string, opts?: CtxInput): Promise<Decision & { by?: string }>;
  blobServe(sha256: string, opts?: CtxInput): Promise<Decision & { by?: string }>;
  store(e: EventInput, opts?: { key?: TestKey }): Promise<NostrEvent>;
  /** The full testbed (created on first use). */
  ready(): Promise<PluginTestbed>;
}

/** `createTestbed(plugin)` — synchronous; the kernel starts on the first call. */
export function createTestbed(
  plugin: DefinitionLike,
  opts: Omit<TestbedOptions, 'plugin' | 'plugins'> = {},
): SimpleTestbed {
  let tb: Promise<PluginTestbed> | null = null;
  const ready = () => {
    tb ??= createPluginTestbed({ ...opts, plugin });
    return tb;
  };
  return {
    ready,
    event: async (e, o) => (await ready()).event(e, o),
    req: async (f, o) => (await ready()).req(f, o),
    upload: async (i, o) => (await ready()).upload(i, o),
    connect: async (o) => (await ready()).connect(o),
    auth: async (p, o) => (await ready()).auth(p, o),
    blobServe: async (s, o) => (await ready()).blobServe(s, o),
    store: async (e, o) => (await ready()).store(e, o),
  };
}
