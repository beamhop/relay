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

/** Every permission a plugin can ask for. */
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
  /** Connection id, stable while the connection is open. */
  id: string;
  /** Salted, rotating hash of the client address. The raw IP is never given to plugins. */
  ipHash: string;
  /** The client's `User-Agent`, when it sent one. */
  userAgent?: string;
  /** When the connection opened (Unix seconds). */
  openedAt: number;
  /** Public keys (hex) that signed in on this connection (NIP-42 AUTH). */
  authed: string[];
}

/** Serializable policy context handed to plugins (in-process and sandboxed alike). */
export interface CtxView {
  /** The relay on this server the activity is for (one server can host several). */
  relayId: RelayId;
  /** Current time (Unix seconds). Use it instead of `Date.now()` so tests can move time. */
  now: number;
  /** Membership tier of the person, when the relay uses tiers. */
  tier?: string;
  /** True for previews and "what would happen" checks: decide, but change nothing. */
  dryRun?: boolean;
  /** The WebSocket connection, for relay activity (absent for Blossom HTTP requests). */
  conn?: ConnView;
}

/** Stored posts and profiles of the relay (`api.events`). */
export interface PluginEventsApi {
  /**
   * Find stored events matching NIP-01 filters. Requires `read-events`.
   * At most `maxLimit` events (default 500, capped at 5000).
   */
  query(relayId: RelayId, filters: Filter[], opts?: { maxLimit?: number }): Promise<NostrEvent[]>;
  /** Count stored events matching NIP-01 filters (NIP-45 semantics). Requires `read-events`. */
  count(relayId: RelayId, filters: Filter[]): Promise<number>;
  /**
   * Store an event as if it was published. Requires `write-events`. The event must be
   * signed and valid. Resolves to the store status (e.g. `saved`, `duplicate`).
   */
  save(relayId: RelayId, event: NostrEvent): Promise<string>;
}

/**
 * The plugin's own saved data (`api.docs`), kept in the DocStore collection
 * `plugin.<id>`. Every method requires the `docs` permission. Values must be JSON.
 */
export interface PluginDocsApi {
  /** Read one value, or `null` when the key is not set. */
  get<T = unknown>(key: string): Promise<T | null>;
  /** Create or replace a value. */
  put<T = unknown>(key: string, value: T): Promise<void>;
  /** Remove a value. Resolves to false when it did not exist. */
  delete(key: string): Promise<boolean>;
  /** List values, optionally only keys starting with `prefix`. */
  list<T = unknown>(opts?: { prefix?: string; limit?: number }): Promise<
    Array<{ key: string; value: T }>
  >;
}

/**
 * Capabilities handed to a plugin instance. Methods outside the granted
 * permissions throw {@link PluginPermissionError}.
 */
export interface PluginApi<C = unknown> {
  /** The plugin id from the manifest. */
  readonly id: string;
  /** The plugin's settings, already checked against its `configSchema` (defaults filled in). */
  readonly config: C;
  /** Permissions the admin granted at install time. */
  readonly permissions: readonly PluginPermission[];
  /** Server time: `now()` in Unix seconds, `nowMs()` in milliseconds. Tests can move it. */
  readonly clock: { now(): number; nowMs(): number };
  /** Write to the server log, tagged with the plugin id. Never log personal data. */
  log(
    level: 'debug' | 'info' | 'warn' | 'error',
    msg: string,
    fields?: Record<string, unknown>,
  ): void;
  /** Stored posts and profiles (`read-events` / `write-events`). */
  readonly events: PluginEventsApi;
  /** The plugin's own saved data (`docs`). */
  readonly docs: PluginDocsApi;
  /** Web request to another server. Requires `network`. */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Per-instance scratch space; cleared on reload. */
  readonly state: Map<string, unknown>;
}

/** Second (last) argument of every hook: the context plus settings and capabilities. */
export interface PluginHookContext<C = unknown> extends CtxView {
  /** The plugin's settings (same as `api.config`). */
  config: C;
  /** Capabilities, limited to the granted permissions. */
  api: PluginApi<C>;
}

/**
 * What a hook returns: nothing (or `accept()`) lets the activity through;
 * `reject()`, `shadow()` or `hold()` stop it. May be a promise.
 */
// biome-ignore lint/suspicious/noConfusingVoidType: lets hooks simply `return;` (or omit a return).
export type HookResult = Decision | undefined | void | Promise<Decision | undefined | void>;

/**
 * Same hook names as core `PolicyHooks`, but with a serializable plugin context.
 * Hooks run in priority order across all policies; the first one that does not
 * accept decides, and later hooks are not called.
 */
export interface PluginHooks<C = unknown> {
  /**
   * Runs when an app opens a WebSocket connection to the relay, before any message.
   * Returning `reject()` sends a `NOTICE` and closes the connection; `shadow()` and `hold()` act as accept.
   */
  onConnect?(ctx: PluginHookContext<C>): HookResult;
  /**
   * Runs when someone signs in on a connection (NIP-42 AUTH), with their public key (hex).
   * Returning `reject()` refuses the sign-in (`OK false`); the connection stays open. `shadow()` and `hold()` act as accept.
   */
  onAuth?(pubkey: string, ctx: PluginHookContext<C>): HookResult;
  /**
   * Runs for every new post or other event sent to the relay (NIP-01 `EVENT`), after the
   * signature and built-in limits were checked and before it is stored. `reject()` refuses
   * it with an `OK false` message; `shadow()` tells the sender it was saved but nobody else
   * sees it; `hold()` stores it hidden in the review queue.
   */
  onEvent?(event: NostrEvent, ctx: PluginHookContext<C>): HookResult;
  /**
   * Runs when an app asks for events (NIP-01 `REQ`), with its filters. `reject()` refuses
   * the subscription with a `CLOSED` message; `shadow()` or `hold()` silently return no events.
   */
  onReq?(filters: Filter[], ctx: PluginHookContext<C>): HookResult;
  /**
   * Runs before a file upload to the media server is stored (Blossom BUD-02/BUD-05), with
   * its hash, size, type and uploader. `reject()` refuses the upload (HTTP 403 with your message).
   */
  onUpload?(info: UploadInfo, ctx: PluginHookContext<C>): HookResult;
  /**
   * Runs before a stored file is served (Blossom `GET /<sha256>`). Anything but accept answers
   * HTTP 403 instead of the file (with your message for `reject()`).
   */
  onBlobServe?(sha256: string, ctx: PluginHookContext<C>): HookResult;
}

/** Every hook a plugin can implement, in documentation order. */
export const HOOK_NAMES: readonly HookName[] = [
  'onConnect',
  'onAuth',
  'onEvent',
  'onReq',
  'onUpload',
  'onBlobServe',
];

/** Everything a plugin is: what `definePlugin` stores as `definition.spec`. */
export interface PluginSpec<S extends z.ZodType = z.ZodType> {
  /** Lowercase id, e.g. `keyword-filter`. Hook id becomes `plugin.<id>`. */
  id: string;
  /** Short plain-language name shown to admins. */
  name: string;
  /** One or two sentences saying what it does, shown before install. */
  description: string;
  /** Semver, e.g. `1.0.0`. Default `0.0.0`. */
  version: string;
  /** What the plugin may touch; admins approve this list at install. Default: none. */
  permissions: PluginPermission[];
  /** zod schema that validates `config.plugins[].config`. Default: any settings. */
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
  /** Lowercase id; may be npm-scoped (`@acme/filter`). */
  id: string;
  /** Short plain-language name. */
  name: string;
  /** What it does, shown before install. */
  description: string;
  /** Semver version. */
  version: string;
  /** Requested permissions (duplicates removed). */
  permissions: PluginPermission[];
  /** Pipeline position, clamped to the plugin band (300 and up). */
  priority: number;
}
