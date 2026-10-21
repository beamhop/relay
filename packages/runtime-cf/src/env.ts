// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  D1DatabaseLike,
  DurableObjectNamespaceLike,
  ImagesBindingLike,
  R2BucketLike,
} from './cf-types.ts';

/**
 * Worker bindings and vars (see `deploy/cloudflare/wrangler.toml`).
 * Everything except `RELAY_ROOM` is optional: missing storage bindings fall
 * back to in-memory adapters with a warning (useful for `wrangler dev`).
 */
export interface CfEnv {
  /** Durable Object namespace for `RelayRoom` (one object per relay shard). */
  RELAY_ROOM: DurableObjectNamespaceLike;
  /** D1 database for events, blob index, documents and metrics. */
  DB?: D1DatabaseLike;
  /** R2 bucket for blobs. */
  BLOBS?: R2BucketLike;
  /** Cloudflare Images binding (optional media resize/thumbnail). */
  IMAGES?: ImagesBindingLike;
  /** JSON config override (wins over the config bundled at build time). Var or secret. */
  BEAMHOP_CONFIG?: string;
  /** Secret salt for privacy-preserving IP hashes. Set with `wrangler secret put IP_HASH_SALT`. */
  IP_HASH_SALT?: string;
  /** Number of Durable Object shards per virtual relay (default 1). */
  RELAY_SHARDS?: string;
  /** Minimum log level: debug | info | warn | error (default info). */
  LOG_LEVEL?: string;
  /** Per-query CPU budget in ms for chunked event queries (default 2000). */
  QUERY_BUDGET_MS?: string;
}

export function shardCount(env: Pick<CfEnv, 'RELAY_SHARDS'>): number {
  const n = Number.parseInt(env.RELAY_SHARDS ?? '1', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 64) : 1;
}

export function numberVar(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) && n > 0 ? n : fallback;
}
