// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Retention providers (§12.7): other modules (the enterprise compliance module's
 * retention-by-group) tell the retention job how long to keep an author's data.
 *
 * Exposed as `kernel.use<RetentionProviders>('lifecycle.retentionProviders')`.
 *
 * Semantics (same as compliance retention by group): providers answer days or
 * abstain (`undefined`); several answers → the LONGEST wins, and the result is
 * combined with the relay's own value (tier / relay-wide rule / goals / kind rule)
 * by taking the longest again — nothing is ever deleted earlier than any source
 * wants it kept. A provider that throws counts as "keep" (fail safe). Legal holds
 * still override everything.
 */
import type { RelayId } from '@beamhop/core';

export const RETENTION_PROVIDERS_SERVICE = 'lifecycle.retentionProviders';

export interface RetentionProvider {
  id: string;
  /** Days to keep this author's events/files on this relay, or undefined to abstain. */
  retentionDays(relayId: RelayId, pubkey: string): Promise<number | undefined> | number | undefined;
  /**
   * Optional: the shortest period this provider can answer for the relay, so the
   * sweep knows where to start looking. Without it the sweep scans from one day back.
   */
  minDays?(relayId: RelayId): Promise<number | undefined> | number | undefined;
}

export interface RetentionProviders {
  /** Add a provider; returns an unregister function. Re-registering an id replaces it. */
  register(provider: RetentionProvider): () => void;
  active(): boolean;
  /** Longest provider answer (Infinity when a provider failed), or undefined when all abstain. */
  daysFor(relayId: RelayId, pubkey: string): Promise<number | undefined>;
  /** Shortest period any provider may answer for the relay (undefined: none registered). */
  minDays(relayId: RelayId): Promise<number | undefined>;
}

/** Without a provider `minDays`, the general sweep looks at everything older than this. */
export const DEFAULT_PROVIDER_MIN_DAYS = 1;

export function createRetentionProviders(
  onError?: (provider: string, err: unknown) => void,
): RetentionProviders {
  const providers = new Map<string, RetentionProvider>();
  return {
    register(p) {
      providers.set(p.id, p);
      return () => {
        if (providers.get(p.id) === p) providers.delete(p.id);
      };
    },
    active: () => providers.size > 0,
    async daysFor(relayId, pubkey) {
      let out: number | undefined;
      for (const p of providers.values()) {
        let d: number | undefined;
        try {
          d = await p.retentionDays(relayId, pubkey);
        } catch (err) {
          onError?.(p.id, err);
          return Number.POSITIVE_INFINITY;
        }
        if (typeof d === 'number' && Number.isFinite(d) && d >= 0) out = Math.max(out ?? 0, d);
      }
      return out;
    },
    async minDays(relayId) {
      if (providers.size === 0) return undefined;
      let out: number | undefined;
      for (const p of providers.values()) {
        let d: number | undefined = DEFAULT_PROVIDER_MIN_DAYS;
        try {
          if (p.minDays) d = (await p.minDays(relayId)) ?? undefined;
        } catch (err) {
          onError?.(p.id, err);
          d = DEFAULT_PROVIDER_MIN_DAYS;
        }
        if (d !== undefined) out = Math.min(out ?? d, d);
      }
      return out;
    },
  };
}

/** Longest of the defined values (undefined when none). */
export function longest(...days: Array<number | undefined>): number | undefined {
  let out: number | undefined;
  for (const d of days) if (d !== undefined) out = Math.max(out ?? 0, d);
  return out;
}
