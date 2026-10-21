// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Retention by group (§12.7): IdP group → retention days (e.g. Finance 7 years,
 * default 90 days). When a person is in several mapped groups the LONGEST period
 * wins (safe for compliance). Legal holds always override retention (lifecycle asks
 * `lifecycle.holds` before deleting).
 *
 * Exposed as `kernel.use<GroupRetention>('compliance.retention')` and, when the lifecycle
 * module offers it, registered into `kernel.use('lifecycle.retentionProviders')`.
 */
import type { RelayId } from '@beamhop/core';
import { groupsOf } from './identity.ts';
import type { Rt } from './runtime.ts';

export const RETENTION_SERVICE = 'compliance.retention';
export const LIFECYCLE_RETENTION_PROVIDERS = 'lifecycle.retentionProviders';

/** Proposed lifecycle extension point (structural). */
export interface RetentionProvider {
  id: string;
  /** Days to keep this author's events on this relay, or undefined to abstain. */
  retentionDays(relayId: RelayId, pubkey: string): Promise<number | undefined>;
}

export interface RetentionProvidersLike {
  register(provider: RetentionProvider): () => void;
}

export function groupRetention(rt: Rt): RetentionProvider {
  return {
    id: 'enterprise-compliance.group-retention',
    async retentionDays(_relayId, pubkey) {
      const cfg = rt.settings().retention;
      if (!cfg.groups.length) return cfg.defaultDays;
      const mine = new Set(await groupsOf(rt.kernel, pubkey));
      let days: number | undefined;
      for (const m of cfg.groups) {
        if (mine.has(m.group)) days = Math.max(days ?? 0, m.days);
      }
      return days ?? cfg.defaultDays;
    },
  };
}
