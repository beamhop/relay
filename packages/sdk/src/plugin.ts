import type { Hono } from "hono";
import type { z } from "zod";
import type { Db, Migration } from "./db";
import type { EventStore, KvStore, UserStore, AuditLog } from "./stores";
import type { EventBus } from "./bus";
import type { BlobUploadHook, QueryHook, VisibilityHook, WritePolicy } from "./hooks";
import type { Logger } from "./logger";
import type { RelayEngine, MetricsService, BlossomService } from "./services";
import type { RuntimeSettings, BeamhopConfig } from "./config";

export interface PluginContext<S = Record<string, unknown>> {
  name: string;
  logger: Logger;
  config: Readonly<BeamhopConfig>;
  db: Db;
  events: EventStore;
  users: UserStore;
  kv: KvStore;
  audit: AuditLog;
  bus: EventBus;
  relay: RelayEngine;
  blossom?: BlossomService;
  metrics: MetricsService;
  runtimeSettings(): RuntimeSettings;
  /** This plugin's validated settings */
  settings: { get(): S; onChange(fn: (s: S) => void): () => void };
  hooks: {
    onWrite(fn: WritePolicy, priority?: number): () => void;
    onQuery(fn: QueryHook, priority?: number): () => void;
    onVisibility(fn: VisibilityHook, priority?: number): () => void;
    onBlobUpload(fn: BlobUploadHook, priority?: number): () => void;
  };
  /** Public HTTP routes mounted at /plugins/<name>/ */
  http: Hono;
  /** Admin-only routes mounted at /admin/api/plugins/<name>/ (session + RBAC "plugins.use" applied) */
  adminHttp: Hono;
  jobs: {
    /** run every `intervalMs`; returns cancel */
    every(name: string, intervalMs: number, fn: () => Promise<void> | void): () => void;
  };
  /** register a subscription to bus events that is auto-removed on disable */
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
  setup(ctx: PluginContext<z.infer<S>>): void | Promise<void>;
  teardown?(): void | Promise<void>;
}

export function definePlugin<S extends z.ZodType>(plugin: BeamhopPlugin<S>): BeamhopPlugin<S> {
  return plugin;
}
