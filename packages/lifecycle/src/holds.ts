// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Legal hold hook (§12.7). Providers (the enterprise compliance module) answer
 * "is this data frozen?"; every deletion path — retention, recycle-bin purge,
 * NIP-62 vanish, crypto-shred, storage pruning, blob expiry — asks first.
 *
 * Exposed as `kernel.use<LegalHolds>('lifecycle.holds')`. Default: no holds.
 */
import type { RelayId } from '@beamhop/core';

export interface HoldSubject {
  pubkey?: string;
  eventId?: string;
  /** Event `created_at` (unix seconds) — for date-range holds. */
  createdAt?: number;
  kind?: number;
  /** Blob hash, for media holds. */
  sha256?: string;
}

export interface HoldProvider {
  id: string;
  isHeld(relayId: RelayId, subject: HoldSubject): Promise<boolean> | boolean;
}

export interface LegalHolds {
  /** True when any provider holds the subject. A throwing provider counts as held (fail safe). */
  isHeld(relayId: RelayId, subject: HoldSubject): Promise<boolean>;
  /** Add a provider; returns an unregister function. Re-registering an id replaces it. */
  register(provider: HoldProvider): () => void;
  /** Whether any provider is registered (lets bulk paths skip per-item checks). */
  active(): boolean;
}

export const HOLDS_SERVICE = 'lifecycle.holds';

export function createHolds(onError?: (provider: string, err: unknown) => void): LegalHolds {
  const providers = new Map<string, HoldProvider>();
  return {
    active: () => providers.size > 0,
    register(p) {
      providers.set(p.id, p);
      return () => {
        if (providers.get(p.id) === p) providers.delete(p.id);
      };
    },
    async isHeld(relayId, subject) {
      for (const p of providers.values()) {
        try {
          if (await p.isHeld(relayId, subject)) return true;
        } catch (err) {
          onError?.(p.id, err);
          return true;
        }
      }
      return false;
    },
  };
}
