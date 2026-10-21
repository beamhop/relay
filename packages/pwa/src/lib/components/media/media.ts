// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Media screen helpers (§6.1): shapes of the storage-tier, cleanup and
 * quarantine actions, tier bars in QuotaBar form, relative times both ways,
 * and the per-file technical lens lines.
 */
import type { BlobItem } from '../../api/types.ts';
import type { QuotaInfo } from '../people/users.ts';

export type Tier = 'hot' | 'cold';

/** `media.storage-tiers` output (blossom TieringStatusOutput). */
export interface TierStatus {
  tier: Tier;
  label: string;
  configured: boolean;
  usedBytes: number | null;
  count: number | null;
  maxBytes: number | null;
  fraction: number | null;
  technical: string;
}

export interface StorageTiers {
  enabled: boolean;
  tiers: TierStatus[];
  afterDays: number | null;
  whenHotFull: 'cold' | 'refuse';
  job: {
    lastRun: number | null;
    nextRun: number | null;
    moved: number;
    movedBytes: number;
    failed: number;
    lastError: string | null;
    totalMoved: number;
    totalFailed: number;
    inProgress: boolean;
  };
  countedAt: number | null;
  error: string | null;
}

/** `media.cleanup-status` output. */
export interface CleanupStatus {
  lastRun: number | null;
  nextRun: number | null;
  freedBytes: number;
  erased: number;
  expired: number;
  scanned: number;
  orphans: number;
  heldRecords: number;
  totalFreedBytes: number;
  inProgress: boolean;
}

/** `media.list-quarantine` item. */
export interface QuarantineItem {
  sha256: string;
  size: number | null;
  type: string | null;
  uploader: string | null;
  uploaders: number;
  reason: string;
  source: 'abuse-list' | 'rule' | 'other';
  abuse: boolean;
  previewable: boolean;
  at: number;
  technical: string;
}

/** A blob row from `media.list-blobs` (with the tier fields newer servers send). */
export interface MediaFile extends BlobItem {
  tier?: Tier;
  owners?: number;
  url?: string | null;
  thumbUrl?: string;
}

/** Tier usage in the shape QuotaBar draws, or null when there is no cap or no count yet. */
export function tierQuota(t: Pick<TierStatus, 'usedBytes' | 'maxBytes'>): QuotaInfo | null {
  if (t.usedBytes === null || t.maxBytes === null || !(t.maxBytes > 0)) return null;
  const used = t.usedBytes;
  const quota = t.maxBytes;
  return {
    used,
    quota,
    left: Math.max(0, quota - used),
    over: used > quota,
    fraction: Math.min(1, used / quota),
  };
}

/** Severity of a tier's fill level (matches the server's 80% / 95% health thresholds). */
export function tierLevel(fraction: number | null): 'ok' | 'warn' | 'critical' {
  if (fraction === null) return 'ok';
  if (fraction >= 0.95) return 'critical';
  if (fraction >= 0.8) return 'warn';
  return 'ok';
}

/** "in 5m" / "in 3h" / "in 2d" for a future unix time; "soon" when due. */
export function until(t: number, now = Date.now()): string | null {
  const ms = t < 1e12 ? t * 1000 : t;
  const s = Math.round((ms - now) / 1000);
  if (s <= 60) return null;
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Technical lens lines for one file (hash, mime, tier, owners). */
export function fileLensLines(f: MediaFile): string[] {
  const lines = [`sha256 ${f.sha256}`, `mime ${f.type ?? 'unknown'}`];
  lines.push(`tier ${f.tier ?? 'hot'}`);
  if (f.owners !== undefined) lines.push(`owners ${f.owners} (BlobIndex rows on this relay)`);
  if (f.quarantined) lines.push('quarantined (docs blossom.quarantine)');
  return lines;
}

/** Abuse-list matches never render the file; other images may be previewed blurred. */
export function canShowImage(q: Pick<QuarantineItem, 'abuse' | 'previewable'>): boolean {
  return !q.abuse && q.previewable;
}
