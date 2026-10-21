// SPDX-License-Identifier: AGPL-3.0-or-later
/** Shared per-kernel state for the lifecycle module. */
import type { BlobStore, Kernel, RelayConfig, RelayId } from '@beamhop/core';
import { type LegalHolds, createHolds } from './holds.ts';
import { type RetentionProviders, createRetentionProviders } from './retention-providers.ts';
import { type LifecycleConfig, LifecycleConfigSchema, MODULE_ID } from './settings.ts';
import type { SqlExecLike } from './sql.ts';

/** What the runtime provides as `kernel.provide('storage.sql', …)` (optional). */
export interface StorageSqlService {
  exec: SqlExecLike;
  /** SQLite file path (for snapshots / Litestream). */
  path?: string;
  /** Postgres connection URL (for pg_dump). */
  url?: string;
}

export const STORAGE_SQL_SERVICE = 'storage.sql';

/** What the runtime provides as `kernel.provide('runtime', …)` (optional). */
export interface RuntimeInfo {
  name?: string;
  /** Booted with `--safe`: never mark that config as known-good. */
  safe?: boolean;
  dataDir?: string;
}

export interface LifecycleOptions {
  /** Backup target override (tests / custom runtimes). */
  backupTarget?: BlobStore | ((kernel: Kernel) => Promise<BlobStore | null>);
  /** SQL access override (else `kernel.use('storage.sql')`). */
  sql?: StorageSqlService;
  /** `fetch` used for the Litestream metrics endpoint. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Disable Bun-native helpers (VACUUM INTO file, pg_dump). */
  native?: boolean;
}

export class LifecycleRuntime {
  readonly holds: LegalHolds;
  readonly retentionProviders: RetentionProviders;
  /** Restore in progress: writes are refused. */
  restoring = false;
  readonly bootAt: number;
  private memo: { raw: unknown; parsed: LifecycleConfig } | null = null;

  constructor(
    readonly kernel: Kernel,
    readonly opts: LifecycleOptions = {},
  ) {
    this.holds = createHolds((provider, err) =>
      kernel.ports.logger.log('warn', 'legal hold provider failed; treating as held', {
        provider,
        err: String(err),
      }),
    );
    this.retentionProviders = createRetentionProviders((provider, err) =>
      kernel.ports.logger.log('warn', 'retention provider failed; keeping the data', {
        provider,
        err: String(err),
      }),
    );
    this.bootAt = kernel.ports.clock.now();
  }

  get ports() {
    return this.kernel.ports;
  }

  settings(): LifecycleConfig {
    const raw = this.kernel.moduleConfig<unknown>(MODULE_ID);
    if (!this.memo || this.memo.raw !== raw)
      this.memo = { raw, parsed: LifecycleConfigSchema.parse(raw ?? {}) };
    return this.memo.parsed;
  }

  relays(relayId?: RelayId | null): RelayConfig[] {
    const all = this.kernel.config().relays;
    return relayId ? all.filter((r) => r.id === relayId) : all;
  }

  sql(): StorageSqlService | undefined {
    return this.opts.sql ?? this.kernel.use<StorageSqlService>(STORAGE_SQL_SERVICE);
  }

  runtimeInfo(): RuntimeInfo | undefined {
    return this.kernel.use<RuntimeInfo>('runtime');
  }

  /** Tier of an author: first access resolver that answers, else the relay default. */
  async tierOf(relay: RelayConfig, pubkey: string): Promise<string> {
    for (const r of this.kernel.access) {
      if (!r.tierOf) continue;
      const t = await r.tierOf(relay.id, pubkey);
      if (t !== undefined && relay.tiers.some((x) => x.id === t)) return t;
    }
    return relay.defaultTier;
  }

  log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
    this.kernel.ports.logger.log(level, msg, { module: MODULE_ID, ...fields });
  }
}
