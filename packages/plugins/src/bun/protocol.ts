// SPDX-License-Identifier: AGPL-3.0-or-later
/** Messages between the plugin host and a sandbox worker (structured-cloned). */
import type { Decision, HookName } from '@beamhop/core';
import type { CtxView, PluginManifest, PluginPermission } from '../sdk/index.ts';

export type HostToWorker =
  | {
      t: 'init';
      id: string;
      entry: string;
      config: unknown;
      approved: PluginPermission[] | null;
      priority?: number;
      nowMs: number;
      memoryReportMs: number;
    }
  | { t: 'call'; id: number; hook: HookName; args: unknown[]; ctx: CtxView; nowMs: number }
  | { t: 'rpc-res'; id: number; ok: boolean; value?: unknown; error?: string };

export type RpcMethod =
  | 'events.query'
  | 'events.count'
  | 'events.save'
  | 'docs.get'
  | 'docs.put'
  | 'docs.delete'
  | 'docs.list';

export type WorkerToHost =
  | { t: 'ready'; manifest: PluginManifest; hooks: HookName[] }
  | { t: 'init-error'; error: string }
  | { t: 'result'; id: number; ok: true; decision: Decision }
  | { t: 'result'; id: number; ok: false; error: string }
  | { t: 'rpc'; id: number; method: RpcMethod; args: unknown[] }
  | {
      t: 'log';
      level: 'debug' | 'info' | 'warn' | 'error';
      msg: string;
      fields?: Record<string, unknown>;
    }
  | { t: 'mem'; heapUsed: number };
