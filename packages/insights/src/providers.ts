// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Loose readers for facts other modules/runtimes may provide. Every reader
 * tolerates absence (returns null) because providers are optional and built
 * in parallel.
 *
 * - Disk: `kernel.use('runtime.disk')` → `{ usage(): {freeBytes,totalBytes} }`
 *   (or an injected provider in module options).
 * - TLS: `kernel.use('runtime.tls')` → any of `certExpiry()`, `expiresAt()`
 *   (unix seconds) or `certificates()` → `[{ host, notAfter }]`.
 * - Backups: DocStore `lifecycle.backups` / `last`, written by the lifecycle module.
 */
import type { Kernel } from '@beamhop/core';

export interface DiskInfo {
  freeBytes: number;
  totalBytes: number;
}

export interface DiskProvider {
  usage(): Promise<DiskInfo | null> | DiskInfo | null;
}

export const DISK_SERVICE = 'runtime.disk';
export const TLS_SERVICE = 'runtime.tls';
export const BACKUP_COLLECTION = 'lifecycle.backups';
export const BACKUP_KEY = 'last';

export async function readDisk(kernel: Kernel, injected?: DiskProvider): Promise<DiskInfo | null> {
  const p = injected ?? kernel.use<DiskProvider>(DISK_SERVICE);
  if (!p || typeof p.usage !== 'function') return null;
  try {
    const d = await p.usage();
    if (!d || !Number.isFinite(d.freeBytes) || !Number.isFinite(d.totalBytes)) return null;
    return d;
  } catch {
    return null;
  }
}

export interface CertInfo {
  host: string;
  /** Unix seconds. */
  notAfter: number;
}

type MaybePromise<T> = T | Promise<T>;
interface TlsLike {
  certificates?(): MaybePromise<Array<{ host?: string; notAfter?: number; expiresAt?: number }>>;
  certExpiry?(): MaybePromise<number | null | undefined>;
  expiresAt?(): MaybePromise<number | null | undefined>;
}

const toSeconds = (v: number) => (v > 1e12 ? Math.floor(v / 1000) : v);

/** Certificates known to the runtime, or null when TLS is not managed here. */
export async function readCerts(kernel: Kernel): Promise<CertInfo[] | null> {
  const t = kernel.use<TlsLike>(TLS_SERVICE);
  if (!t) return null;
  try {
    if (typeof t.certificates === 'function') {
      const list = await t.certificates();
      return list
        .map((c) => ({ host: c.host ?? '*', notAfter: toSeconds(c.notAfter ?? c.expiresAt ?? 0) }))
        .filter((c) => c.notAfter > 0);
    }
    const fn = t.certExpiry ?? t.expiresAt;
    if (typeof fn === 'function') {
      const v = await fn.call(t);
      return v ? [{ host: '*', notAfter: toSeconds(v) }] : [];
    }
  } catch {
    return null;
  }
  return null;
}

export interface BackupStatus {
  /** Unix seconds of the last attempt/success. */
  at: number;
  ok: boolean;
  error?: string;
  /** Unix seconds of the last successful backup, if known. */
  lastSuccessAt?: number;
}

/** Normalised backup status from the lifecycle module's DocStore record. */
export async function readBackup(kernel: Kernel): Promise<BackupStatus | null> {
  let raw: Record<string, unknown> | null;
  try {
    raw = await kernel.ports.docs.get<Record<string, unknown>>(BACKUP_COLLECTION, BACKUP_KEY);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const num = (k: string) => (typeof raw[k] === 'number' ? toSeconds(raw[k] as number) : undefined);
  const at = num('at') ?? num('finishedAt') ?? num('completedAt') ?? num('startedAt');
  if (at === undefined) return null;
  const status = typeof raw.status === 'string' ? raw.status : undefined;
  const ok =
    typeof raw.ok === 'boolean'
      ? raw.ok
      : status
        ? ['ok', 'success', 'succeeded', 'done'].includes(status)
        : !raw.error;
  const out: BackupStatus = { at, ok };
  if (typeof raw.error === 'string') out.error = raw.error;
  const last = num('lastSuccessAt') ?? (ok ? at : undefined);
  if (last !== undefined) out.lastSuccessAt = last;
  return out;
}

export const BACKUP_INTERVALS: Record<string, number> = {
  hourly: 3600,
  daily: 86400,
  weekly: 7 * 86400,
};
