// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Kernel, LogLevel, Ports, RelayId } from '@beamhop/core';
import { type ComplianceConfig, ComplianceConfigSchema, MODULE_ID } from './config.ts';

/** SIEM record streams (see `SinkSchema.streams`). */
export type SiemStream =
  | 'audit'
  | 'auth'
  | 'signing'
  | 'escrow'
  | 'config'
  | 'deletion'
  | 'compliance';

export interface SiemInput {
  stream: SiemStream;
  /** Short machine name, e.g. `approval.requested`, `auth.success`. */
  type: string;
  relayId?: RelayId | null;
  principalId?: string;
  summary: string;
  data?: Record<string, unknown>;
}

/**
 * Runtime service for work that must finish after the response is sent. On Cloudflare the
 * Worker hands tracked promises to `ctx.waitUntil` (otherwise the isolate may cancel them);
 * on Bun no service exists and promises simply run.
 */
export const BACKGROUND_SERVICE = 'runtime.background';
export interface BackgroundTasksLike {
  waitUntil(p: Promise<unknown>): void;
}

/** Shared module runtime handed to every part of enterprise-compliance. */
export interface Rt {
  kernel: Kernel;
  ports: Ports;
  settings(): ComplianceConfig;
  log(level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  /** Queue a record for SIEM export (no-op until the exporter is attached). */
  record(r: SiemInput): void;
  /** Keep `p` alive past the current request (Cloudflare `waitUntil`); no-op elsewhere. */
  background(p: Promise<unknown>): void;
  now(): number;
}

export function createRt(kernel: Kernel): Rt & { setRecorder(fn: (r: SiemInput) => void): void } {
  let memo: { raw: unknown; parsed: ComplianceConfig } | null = null;
  let recorder: (r: SiemInput) => void = () => {};
  const logger = kernel.ports.logger.child({ module: MODULE_ID });
  return {
    kernel,
    ports: kernel.ports,
    settings() {
      const raw = kernel.moduleConfig<unknown>(MODULE_ID);
      if (!memo || memo.raw !== raw) {
        memo = { raw, parsed: ComplianceConfigSchema.parse(raw ?? {}) };
      }
      return memo.parsed;
    },
    log: (level, msg, fields) => logger.log(level, msg, fields),
    record: (r) => {
      try {
        recorder(r);
      } catch (err) {
        logger.log('warn', 'could not queue a SIEM record', { err: String(err) });
      }
    },
    background: (p) => {
      kernel.use<BackgroundTasksLike>(BACKGROUND_SERVICE)?.waitUntil(p);
    },
    setRecorder(fn) {
      recorder = fn;
    },
    now: () => kernel.ports.clock.now(),
  };
}
