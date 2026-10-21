// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runtime facts the Bun runtime provides to modules via `kernel.provide()`:
 *
 * - `runtime.disk` → `usage()`: free/total bytes of the filesystem holding the
 *   data directory (`statfs`). Returns both `{ free, total }` and the
 *   `{ freeBytes, totalBytes }` names insights/alerts read.
 * - `runtime.tls` → `{ mode, certExpiry() }`: certificate expiry in unix seconds
 *   when this node manages TLS (ACME), else `null`.
 * - Country: only from a trusted reverse-proxy header (`node.trustProxy` and
 *   `node.countryHeader`), never derived from IPs.
 */
import { statfsSync } from 'node:fs';
import type { BeamhopConfig } from '@beamhop/core';
import type { AcmeManager, EffectiveTls } from './tls.ts';

export const DISK_SERVICE = 'runtime.disk';
export const TLS_SERVICE = 'runtime.tls';

export interface DiskUsage {
  free: number;
  total: number;
  path: string;
  /** Aliases read by insights / alerts. */
  freeBytes: number;
  totalBytes: number;
}

export interface DiskService {
  usage(): Promise<DiskUsage>;
}

export function diskService(path: string, statfs: typeof statfsSync = statfsSync): DiskService {
  return {
    async usage() {
      const s = statfs(path);
      const free = Number(s.bavail) * Number(s.bsize);
      const total = Number(s.blocks) * Number(s.bsize);
      return { free, total, path, freeBytes: free, totalBytes: total };
    },
  };
}

export interface TlsService {
  readonly mode: EffectiveTls;
  /** Unix seconds when the served certificate expires; null when TLS is not managed here. */
  certExpiry(): Promise<number | null>;
}

export function tlsService(
  mode: () => EffectiveTls,
  acme: () => Pick<AcmeManager, 'current'> | undefined,
): TlsService {
  return {
    get mode() {
      return mode();
    },
    async certExpiry() {
      const m = acme();
      if (!m) return null;
      const pair = await m.current();
      return pair ? Math.floor(pair.notAfter.getTime() / 1000) : null;
    },
  };
}

/**
 * ISO 3166-1 alpha-2 country from the trusted proxy header, upper-cased.
 * Ignored unless `node.trustProxy` is on and `node.countryHeader` is set;
 * placeholders such as `XX` (unknown) or `T1` (Tor) are dropped.
 */
export function countryFrom(req: Request, cfg: BeamhopConfig): string | undefined {
  const node = cfg.node;
  if (!node.trustProxy || !node.countryHeader) return undefined;
  const v = req.headers.get(node.countryHeader)?.split(',')[0]?.trim().toUpperCase();
  if (!v || !/^[A-Z]{2}$/.test(v) || v === 'XX') return undefined;
  return v;
}
