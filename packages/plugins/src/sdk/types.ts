// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Plugin SDK types. A plugin is a small, self-describing bundle of policy hooks
 * (§9). The same definition runs in-process (trusted / Cloudflare bundle) or in
 * a sandboxed Bun Worker (untrusted), so hook inputs are plain data only.
 */
import type {
  ActionDef,
  Decision,
  Filter,
  HookName,
  NostrEvent,
  RelayId,
  UploadInfo,
} from '@beamhop/core';
import type { z } from 'zod';

/** What a plugin may touch. Shown to admins in plain language before install. */
export type PluginPermission = 'read-events' | 'write-events' | 'network' | 'docs';

export const PLUGIN_PERMISSIONS: readonly PluginPermission[] = [
  'read-events',
  'write-events',
  'network',
  'docs',
];

/** Plain-language + technical description of each permission (install preview). */
export const PERMISSION_TEXT: Record<
  PluginPermission,
  { text: string; technical: string; risky: boolean }
> = {
  'read-events': {
    text: 'Read posts and profiles stored on this relay',
    technical: 'EventStore.query/count (read-events)',
    risky: false,
  },
  'write-events': {
    text: 'Publish new events to this relay on its own',
    technical: 'EventStore.save of signed events (write-events)',
    risky: true,
  },
  network: {
    text: 'Connect to other websites and servers on the internet',
    technical: 'fetch() to arbitrary URLs (network)',
    risky: true,
  },
  docs: {
    text: 'Keep its own saved data on this server',
    technical: 'DocStore collection plugin.<id> (docs)',
    risky: false,
  },
};

/** Serializable view of the connection (no sockets cross the sandbox boundary). */
export interface ConnView {
  id: string;
  ipHash: string;
  userAgent?: string;
  openedAt: number;
  /** NIP-42 authenticated pubkeys. */
  authed: string[];
}

/** Serializable policy context handed to plugins (in-process and sandboxed alike). */
export interface CtxView {
  relayId: RelayId;
  now: number;
  tier?: string;
  dryRun?: boolean;
  conn?: ConnView;
}

export interface PluginEventsApi {
  query(relayId: RelayId, filters: Filter[], opts?: { maxLimit?: number }): Promise<NostrEvent[]>;
  count(relayId: RelayId, filters: Filter[]): Promise<number>;
  /** Requires `write-events`. The event must be signed and valid. */
  save(relayId: RelayId, event: NostrEvent): Promise<string>;
}

export interface PluginDocsApi {
  get<T = unknown>(key: string): Promise<T | null>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T = unknown>(opts?: { prefix?: string; limit?: number }): Promise<
    Array<{ key: string; value: T }>
  >;
}

/**
 * Capabilities handed to a plugin instance. Methods outside the granted
 * permissions throw {@link PluginPermissionError}.
 */
export interface PluginApi<C = unknown> {
  readonly id: string;
  readonly config: C;
  readonly permissions: readonly PluginPermission[];
  readonly clock: { now(): number; nowMs(): number };
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    fields?: Record<string, unknown>,
  ): void;
  readonly events: PluginEventsApi;
  readonly docs: PluginDocsApi;
  /** Requires `network`. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Per-instance scratch space; cleared on reload. */
  readonly state: Map<string, unknown>;
}

export interface PluginHookContext<C = unknown> extends CtxView {
  config: C;
  api: PluginApi<C>;
}

/** Returning nothing means "accept". */
// biome-ignore lint/suspicious/noConfusingVoidType: lets hooks simply `return;` (or omit a return).
export type HookResult = Decision | undefined | void | Promise<Decision | undefined | void>;

/** Same hook names as core `PolicyHooks`, but with a serializable plugin context. */
export interface PluginHooks<C = unknown> {
  onConnect?(ctx: PluginHookContext<C>): HookResult;
  onAuth?(pubkey: string, ctx: PluginHookContext<C>): HookResult;
  onEvent?(event: NostrEvent, ctx: PluginHookContext<C>): HookResult;
  onReq?(filters: Filter[], ctx: PluginHookContext<C>): HookResult;
  onUpload?(info: UploadInfo, ctx: PluginHookContext<C>): HookResult;
  onBlobServe?(sha256: string, ctx: PluginHookContext<C>): HookResult;
}

export const HOOK_NAMES: readonly HookName[] = [
  'onConnect',
  'onAuth',
  'onEvent',
  'onReq',
  'onUpload',
  'onBlobServe',
];

export interface PluginSpec<S extends z.ZodType = z.ZodType> {
  /** Lowercase id, e.g. `keyword-filter`. Hook id becomes `plugin.<id>`. */
  id: string;
  name: string;
  description: string;
  /** Semver, e.g. `1.0.0`. */
  version: string;
  permissions: PluginPermission[];
  /** Validates `config.plugins[].config`. */
  configSchema: S;
  /**
   * Static hooks, or a factory called once per instance (use it to keep state
   * that must reset on reload). Factories may be async.
   */
  hooks:
    | PluginHooks<z.output<S>>
    | ((
        api: PluginApi<z.output<S>>,
      ) => PluginHooks<z.output<S>> | Promise<PluginHooks<z.output<S>>>);
  /** Pipeline priority; clamped to the plugin band (300+). Default 300. */
  priority?: number;
  /**
   * Admin actions (trusted/in-process plugins only). Ids are prefixed with
   * `plugin.<id>.` on registration.
   */
  actions?: ActionDef[] | ((api: PluginApi<z.output<S>>) => ActionDef[]);
  /** Called when the instance is unloaded (reload, disable, shutdown). */
  dispose?(api: PluginApi<z.output<S>>): void | Promise<void>;
}

/**
 * What `definePlugin` accepts: the full spec, or a shorthand with hooks at the
 * top level and `version` (default `0.0.0`), `permissions` (default none) and
 * `configSchema` (default: any settings) left out.
 */
export type PluginInput<S extends z.ZodType = z.ZodType> = Omit<
  PluginSpec<S>,
  'version' | 'permissions' | 'configSchema' | 'hooks'
> &
  PluginHooks<z.output<S>> & {
    version?: string;
    permissions?: PluginPermission[];
    configSchema?: S;
    hooks?: PluginSpec<S>['hooks'];
  };

/** Serializable manifest (what the host validates and shows). */
export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  permissions: PluginPermission[];
  priority: number;
}
