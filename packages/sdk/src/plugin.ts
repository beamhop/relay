import type { Hono } from "hono";
import type { z } from "zod";
import type { Db, Migration } from "./db";
import type { EventStore, KvStore, UserStore, AuditLog } from "./stores";
import type { BusEvents, EventBus } from "./bus";
import type { BlobUploadHook, HookOptions, QueryHook, VisibilityHook, WritePolicy } from "./hooks";
import type { Logger } from "./logger";
import type { RelayEngine, MetricsService, BlossomService } from "./services";
import type { RuntimeSettings, BeamhopConfig } from "./config";

/** The bus as seen by a plugin: subscriptions are removed on disable; only admin alerts may be emitted. */
export interface PluginBus {
  on: EventBus["on"];
  /** Raise an admin alert. Core events (event.*, user.*, …) are emitted by core only; other names throw. */
  emit(name: "alert", payload: BusEvents["alert"]): void;
}

export interface PluginContext<S = Record<string, unknown>> {
  name: string;
  logger: Logger;
  config: Readonly<BeamhopConfig>;
  db: Db;
  events: EventStore;
  users: UserStore;
  kv: KvStore;
  audit: AuditLog;
  bus: PluginBus;
  relay: RelayEngine;
  blossom?: BlossomService;
  metrics: MetricsService;
  runtimeSettings(): RuntimeSettings;
  /** This plugin's validated settings */
  settings: { get(): S; onChange(fn: (s: S) => void | Promise<void>): () => void };
  /**
   * A number is the priority. Each call has a time budget (`timeoutMs`; write/query 2 s, blob 30 s): an overrunning
   * write hook is skipped (and an alert raised), an overrunning query/blob hook fails the request. Hooks get an
   * AbortSignal (`ctx.signal` / `blob.signal`) that fires when the budget is spent.
   */
  hooks: {
    onWrite(fn: WritePolicy, opts?: number | HookOptions): () => void;
    onQuery(fn: QueryHook, opts?: number | HookOptions): () => void;
    onVisibility(fn: VisibilityHook, opts?: number | HookOptions): () => void;
    onBlobUpload(fn: BlobUploadHook, opts?: number | HookOptions): () => void;
  };
  /** Public HTTP routes mounted at /plugins/<name>/ */
  http: Hono;
  /** Admin-only routes mounted at /admin/api/plugins/x/<name>/ (session + RBAC "plugins.use" applied) */
  adminHttp: Hono;
  jobs: {
    /** run every `intervalMs` (a run still in progress is awaited, bounded, on disable/shutdown); returns cancel */
    every(name: string, intervalMs: number, fn: () => Promise<void> | void): () => void;
  };
  /** register a subscription to bus events that is auto-removed on disable (same as `bus.on`) */
  on: EventBus["on"];
}

export interface BeamhopPlugin<S extends z.ZodType = z.ZodType> {
  name: string;
  version: string;
  description?: string;
  /** zod schema for settings; rendered as a form in admin panel */
  settings?: S;
  migrations?: Migration[];
  /**
   * Path (absolute, or relative to plugin package root) of a prebuilt ESM bundle for the admin UI.
   * Bundle must `export default function register(api: AdminUiPluginApi) {}`; see ui-contract.ts.
   */
  ui?: string;
  /** Must finish within 30 s, or the plugin is marked error and everything it registered is removed. */
  setup(ctx: PluginContext<z.infer<S>>): void | Promise<void>;
  /** Runs on disable and at shutdown; given 5 s. */
  teardown?(): void | Promise<void>;
}

export function definePlugin<S extends z.ZodType>(plugin: BeamhopPlugin<S>): BeamhopPlugin<S> {
  return plugin;
}
