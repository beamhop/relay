// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Data residency (§12.7): each pinned relay declares a region; the node's storage
 * adapters (database, blob store, backup target) must be in that region. Checked at
 * boot and on every config change; mismatches show up in the health score, as an
 * attention card and in the log.
 *
 * Where regions come from:
 * - database: `residency.databaseRegion` (the DB adapter config has no region field);
 *   D1 / Postgres location is declared by the operator.
 * - blobs: `blobStorage.region` (S3/GCS/R2). `fs`/`memory` blobs live with the database.
 * - backups: `backups.target.region` when backups are enabled.
 */
import type { BeamhopConfig, HealthCheck, HealthResult } from '@beamhop/core';
import type { ComplianceConfig } from './config.ts';

export interface ResidencyIssue {
  relayId: string;
  severity: 'warning' | 'critical';
  /** Plain language. */
  message: string;
  technical: string;
}

/** R2 location hints / jurisdictions → broad region prefixes. */
const ALIASES: Record<string, string> = {
  weur: 'eu',
  eeur: 'eu',
  eu: 'eu',
  wnam: 'us',
  enam: 'us',
  apac: 'ap',
  oc: 'ap',
  fedramp: 'us',
};

function norm(r: string): string {
  return r.trim().toLowerCase();
}

/** `want` "eu" matches "eu-west-1", "europe-west3", "weur"; exact match otherwise. */
export function regionMatches(want: string, have: string): boolean {
  const w = norm(want);
  const h = norm(have);
  if (w === h) return true;
  if (h.startsWith(`${w}-`)) return true;
  const ha = ALIASES[h];
  if (ha && (ha === w || ALIASES[w] === ha)) return true;
  if (w === 'eu' && h.startsWith('europe-')) return true;
  if (w === 'us' && /^(us|northamerica)-/.test(h)) return true;
  if (w === 'ap' && /^(asia|australia|ap)-/.test(h)) return true;
  return false;
}

export function checkResidency(config: BeamhopConfig, cfg: ComplianceConfig): ResidencyIssue[] {
  const issues: ResidencyIssue[] = [];
  const pins = cfg.residency.relays;
  const dbRegion = cfg.residency.databaseRegion;
  const blob = config.blobStorage;
  const blobRegion =
    blob.driver === 'fs' || blob.driver === 'memory' ? dbRegion : (blob.region ?? undefined);
  const backup = config.backups.enabled ? config.backups.target : undefined;
  for (const [relayId, pin] of Object.entries(pins)) {
    if (!config.relays.some((r) => r.id === relayId)) {
      issues.push({
        relayId,
        severity: 'warning',
        message: `A region is set for “${relayId}”, but there is no such relay`,
        technical: `residency.relays.${relayId} has no matching relay`,
      });
      continue;
    }
    const want = pin.region;
    const check = (what: string, have: string | undefined, field: string) => {
      if (!have) {
        issues.push({
          relayId,
          severity: 'warning',
          message: `Can't confirm the ${what} for “${relayId}” is in ${want}: its region is not set`,
          technical: `${field} unset (required for residency pin ${want})`,
        });
      } else if (!regionMatches(want, have)) {
        issues.push({
          relayId,
          severity: 'critical',
          message: `Data for “${relayId}” must stay in ${want}, but the ${what} is in ${have}`,
          technical: `${field}=${have} ≠ residency.relays.${relayId}.region=${want}`,
        });
      }
    };
    check('database', dbRegion, 'residency.databaseRegion');
    check(
      'media storage',
      blobRegion,
      blob.driver === 'fs' || blob.driver === 'memory'
        ? 'residency.databaseRegion (local blobs)'
        : 'blobStorage.region',
    );
    if (backup) {
      const br = backup.driver === 'fs' || backup.driver === 'memory' ? dbRegion : backup.region;
      check('backup storage', br, 'backups.target.region');
    }
  }
  return issues;
}

export function residencyHealth(getIssues: () => ResidencyIssue[]): HealthCheck {
  return {
    id: 'enterprise-compliance.residency',
    subsystem: 'storage',
    weight: 2,
    async run(relayId): Promise<HealthResult> {
      const issues = getIssues().filter((i) => !relayId || i.relayId === relayId);
      const critical = issues.filter((i) => i.severity === 'critical');
      if (critical.length)
        return {
          score: 20,
          status: 'critical',
          message: critical[0]!.message,
          technical: critical.map((i) => i.technical).join('; '),
        };
      if (issues.length)
        return {
          score: 70,
          status: 'warn',
          message: issues[0]!.message,
          technical: issues.map((i) => i.technical).join('; '),
        };
      return { score: 100, status: 'ok', message: 'Data stays in the required regions' };
    },
  };
}
