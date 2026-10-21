// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Backups screen (§6.13, vanilla): the shapes `backups.list` returns and the
 * pure helpers behind the list (state of each backup, the status line, the
 * technical lens lines). Kept free of Svelte so they are unit-tested.
 */

/** One catalogued backup (`BackupRecord` in packages/lifecycle/src/backup.ts). */
export interface BackupRow {
  id: string;
  at: number;
  ok: true;
  trigger: 'scheduled' | 'manual';
  sha256: string;
  size: number;
  location: string;
  dbFormat: string;
  driver: string;
  events: number;
  docs?: number;
  blobs: number;
  configRevision?: number;
  encrypted?: boolean;
  secrets?: 'included' | 'masked';
  durationMs: number;
  verifiedAt?: number;
  verifiedOk?: boolean;
}

export interface BackupLast {
  at: number;
  ok: boolean;
  size?: number;
  error?: string;
  id?: string;
  lastOkAt?: number;
}

export interface BackupsList {
  backups: BackupRow[];
  /** Archives found in backup storage that this server does not know (e.g. after a move). */
  unknownArchives: Array<{ sha256: string; size: number }>;
  last: BackupLast | null;
  /** Backup storage, or null when none is configured. */
  target: string | null;
  schedule?: { enabled: boolean; schedule: 'hourly' | 'daily' | 'weekly'; keep: number };
  running?: boolean;
  /** Standby server (Litestream) replication. */
  standby?: {
    enabled: boolean;
    status?: 'ok' | 'warn' | 'critical';
    message?: string;
    technical?: string;
  };
}

/** `backups.verify` output. */
export interface VerifyOutput {
  ok: boolean;
  problems: string[];
}

export type CheckState = 'ok' | 'bad' | 'unchecked';

/** Has this backup been checked, and did it pass? */
export function checkState(b: Pick<BackupRow, 'verifiedAt' | 'verifiedOk'>): CheckState {
  if (b.verifiedAt === undefined || b.verifiedOk === undefined) return 'unchecked';
  return b.verifiedOk ? 'ok' : 'bad';
}

export type Health = 'off' | 'never' | 'failed' | 'ok';

/** Overall state for the top card. */
export function health(l: Pick<BackupsList, 'target' | 'last' | 'backups' | 'schedule'>): Health {
  if (!l.target && !l.backups.length) return 'off';
  if (l.last && !l.last.ok) return 'failed';
  if (!l.backups.length && !l.last) return 'never';
  return 'ok';
}

/** Unix seconds → local date and time ("21 Oct 2026, 14:05"). */
export function when(at: number, locale?: string): string {
  return new Date(at * 1000).toLocaleString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Technical lens lines for one backup (ids, format, counts). */
export function lensLines(b: BackupRow): string[] {
  const lines = [
    `id ${b.id}`,
    `sha256 ${b.sha256.slice(0, 16)}…`,
    `format ${b.dbFormat} · driver ${b.driver} · ${b.trigger}`,
    `${b.events} events · ${b.blobs} blobs${b.docs !== undefined ? ` · ${b.docs} docs` : ''}`,
    `took ${Math.max(1, Math.round(b.durationMs))} ms`,
  ];
  if (b.configRevision !== undefined) lines.push(`config revision ${b.configRevision}`);
  if (b.encrypted) lines.push('sealed with the key service');
  if (b.secrets) lines.push(`secrets ${b.secrets}`);
  if (b.verifiedAt !== undefined)
    lines.push(`verified ${b.verifiedOk ? 'ok' : 'FAILED'} at ${b.verifiedAt}`);
  lines.push(b.location);
  return lines;
}

/** Newest first; never mutates the input. */
export function sorted(rows: readonly BackupRow[]): BackupRow[] {
  return [...rows].sort((a, b) => b.at - a.at);
}

/** Poll again while a backup is being made. */
export const POLL_MS = 3000;
