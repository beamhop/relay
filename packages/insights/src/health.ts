// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Health checks (§8) and the overall health score.
 *
 * ## Health score algorithm
 * 1. Every registered `HealthCheck` (from any module) runs with a 5 s timeout.
 *    A check that throws or times out counts as `warn` with score 50.
 * 2. `mean = Σ(weight·score) / Σ(weight)` over checks with weight > 0.
 * 3. Worst-check cap: `overall = min(mean, min_i(score_i + 40))` — one badly
 *    failing subsystem cannot be hidden by many healthy ones (a critical check
 *    scoring 10 caps the relay at 50).
 * 4. Status: `critical` if any check is critical or overall < 50; `warn` if any
 *    check warns or overall < 80; otherwise `ok`.
 * 5. The result is rounded to an integer 0..100.
 */
import type { HealthCheck, HealthResult, Kernel, RelayId, StoreStats } from '@beamhop/core';
import type { InsightsConfig } from './config.ts';
import { METRICS, type MetricsRegistry } from './metrics.ts';
import {
  BACKUP_INTERVALS,
  type DiskProvider,
  readBackup,
  readCerts,
  readDisk,
} from './providers.ts';

export const CHECK_TIMEOUT_MS = 5000;
/** Points above a check's score that the overall score may not exceed. */
export const WORST_CAP_MARGIN = 40;

export interface CheckOutcome extends HealthResult {
  id: string;
  subsystem: HealthCheck['subsystem'];
  weight: number;
}

export interface HealthReport {
  relayId: RelayId | null;
  score: number;
  status: HealthResult['status'];
  /** Plain-language one-liner. */
  message: string;
  checks: CheckOutcome[];
  at: number;
}

export function computeScore(checks: CheckOutcome[]): Pick<HealthReport, 'score' | 'status'> {
  const weighted = checks.filter((c) => c.weight > 0);
  if (weighted.length === 0) return { score: 100, status: 'ok' };
  const totalW = weighted.reduce((a, c) => a + c.weight, 0);
  const mean = weighted.reduce((a, c) => a + c.weight * clamp(c.score), 0) / totalW;
  const cap = Math.min(...weighted.map((c) => clamp(c.score) + WORST_CAP_MARGIN));
  const score = Math.round(Math.max(0, Math.min(100, mean, cap)));
  const anyCritical = checks.some((c) => c.status === 'critical');
  const anyWarn = checks.some((c) => c.status === 'warn');
  const status: HealthResult['status'] =
    anyCritical || score < 50 ? 'critical' : anyWarn || score < 80 ? 'warn' : 'ok';
  return { score, status };
}

function clamp(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timed out')), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runChecks(
  kernel: Kernel,
  relayId: RelayId | null,
  now: number,
): Promise<HealthReport> {
  const checks = await Promise.all(
    kernel.health.map(async (c): Promise<CheckOutcome> => {
      try {
        const r = await withTimeout(c.run(relayId), CHECK_TIMEOUT_MS);
        return { id: c.id, subsystem: c.subsystem, weight: c.weight, ...r };
      } catch (err) {
        return {
          id: c.id,
          subsystem: c.subsystem,
          weight: c.weight,
          score: 50,
          status: 'warn',
          message: 'This check could not run',
          technical: `${c.id}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }),
  );
  const { score, status } = computeScore(checks);
  const worst = [...checks].filter((c) => c.status !== 'ok').sort((a, b) => a.score - b.score)[0];
  const message =
    status === 'ok'
      ? 'Everything looks good'
      : worst
        ? worst.message
        : status === 'warn'
          ? 'Some things need attention'
          : 'Your relay needs attention now';
  return { relayId, score, status, message, checks, at: now };
}

// ───────────────────────────── Built-in checks ─────────────────────────────

export interface HealthDeps {
  kernel: Kernel;
  registry: MetricsRegistry;
  config(): InsightsConfig;
  disk?: DiskProvider;
  storageStats(): Promise<StoreStats>;
}

const FIVE_MIN = 30; // windows of 10 s

function relayMatch(relayId: RelayId | null): Record<string, string> {
  return relayId ? { relay: relayId } : {};
}

export function formatBytes(n: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

export function availabilityCheck(d: HealthDeps): HealthCheck {
  return {
    id: 'insights.availability',
    subsystem: 'relay',
    weight: 3,
    async run(relayId) {
      const k = d.kernel;
      if (!k.isEnabled('relay'))
        return {
          score: 100,
          status: 'ok',
          message: 'The relay is not running on this server',
          technical: 'relay module not registered',
        };
      if (!k.ws)
        return {
          score: 0,
          status: 'critical',
          message: 'The relay is not accepting connections',
          technical: 'kernel.ws handler missing',
        };
      if (relayId && !k.relay(relayId))
        return { score: 0, status: 'critical', message: 'This relay is not configured' };
      const conns = d.registry.gauge(METRICS.connections, { relay: relayId ?? '' });
      return {
        score: 100,
        status: 'ok',
        message: 'The relay is up and accepting connections',
        technical: `kernel.ws present${conns !== undefined ? `; open connections=${conns}` : ''}`,
      };
    },
  };
}

export function errorRateCheck(d: HealthDeps): HealthCheck {
  return {
    id: 'insights.error-rate',
    subsystem: 'relay',
    weight: 2,
    async run(relayId) {
      const m = relayMatch(relayId);
      const r = d.registry;
      const errors = r.recentSum(METRICS.errors, m, FIVE_MIN);
      const ops =
        r.recentSum(METRICS.eventsAccepted, m, FIVE_MIN) +
        r.recentSum(METRICS.eventsRejected, m, FIVE_MIN) +
        r.recentSum(METRICS.reqServed, m, FIVE_MIN);
      const technical = `errors=${errors} operations=${ops} over the last 5 minutes`;
      if (errors === 0) return { score: 100, status: 'ok', message: 'No errors', technical };
      const rate = ops >= 20 ? errors / ops : errors >= 10 ? 0.06 : 0.005;
      const pct = (rate * 100).toFixed(rate < 0.01 ? 2 : 1);
      if (rate < 0.001) return { score: 100, status: 'ok', message: 'Almost no errors', technical };
      if (rate < 0.01)
        return { score: 85, status: 'ok', message: `A few errors (${pct}%)`, technical };
      if (rate < 0.05)
        return { score: 60, status: 'warn', message: `Some requests fail (${pct}%)`, technical };
      return { score: 20, status: 'critical', message: `Many requests fail (${pct}%)`, technical };
    },
  };
}

export function latencyCheck(d: HealthDeps): HealthCheck {
  return {
    id: 'insights.latency',
    subsystem: 'relay',
    weight: 2,
    async run(relayId) {
      const m = relayMatch(relayId);
      let sk = d.registry.recentSketch(METRICS.eventLatency, m);
      let what = 'posting';
      if (sk.count === 0) {
        sk = d.registry.recentSketch(METRICS.reqLatency, m);
        what = 'reading';
      }
      if (sk.count === 0)
        return { score: 100, status: 'ok', message: 'No recent traffic to measure' };
      const p95 = Math.round(sk.quantile(0.95));
      const p50 = Math.round(sk.quantile(0.5));
      const technical = `${what} latency p50=${p50}ms p95=${p95}ms (n=${sk.count}, last 5 min)`;
      if (p95 < 200) return { score: 100, status: 'ok', message: 'Fast', technical };
      if (p95 < 500) return { score: 85, status: 'ok', message: 'A little slow', technical };
      if (p95 < 1500)
        return {
          score: 60,
          status: 'warn',
          message: `Slow: ${what} takes up to ${p95} ms`,
          technical,
        };
      return {
        score: 25,
        status: 'critical',
        message: `Very slow: ${what} takes up to ${(p95 / 1000).toFixed(1)} s`,
        technical,
      };
    },
  };
}

function headroomResult(free: number, total: number, technical: string): HealthResult {
  const ratio = total > 0 ? free / total : 1;
  const pct = Math.round(ratio * 100);
  const msg = `${formatBytes(free)} free (${pct}%)`;
  if (ratio >= 0.2)
    return { score: 100, status: 'ok', message: `Plenty of space: ${msg}`, technical };
  if (ratio >= 0.1)
    return { score: 70, status: 'warn', message: `Space is getting low: ${msg}`, technical };
  if (ratio >= 0.05)
    return { score: 40, status: 'warn', message: `Space is low: ${msg}`, technical };
  return { score: 10, status: 'critical', message: `Almost out of space: ${msg}`, technical };
}

export function storageCheck(d: HealthDeps): HealthCheck {
  return {
    id: 'insights.storage',
    subsystem: 'storage',
    weight: 2,
    async run() {
      const stats = await d.storageStats();
      const disk = await readDisk(d.kernel, d.disk);
      const used = `db events=${stats.events} bytes=${stats.bytes}`;
      if (disk)
        return headroomResult(
          disk.freeBytes,
          disk.totalBytes,
          `${used}; disk free=${disk.freeBytes} total=${disk.totalBytes}`,
        );
      const budget = d.config().storageBudgetBytes;
      if (budget)
        return headroomResult(
          Math.max(0, budget - stats.bytes),
          budget,
          `${used}; storageBudgetBytes=${budget}`,
        );
      return {
        score: 100,
        status: 'ok',
        message: `Using ${formatBytes(stats.bytes)} for ${stats.events.toLocaleString('en')} posts`,
        technical: `${used}; free disk unknown (no runtime.disk provider)`,
      };
    },
  };
}

export function backupCheck(d: HealthDeps): HealthCheck {
  return {
    id: 'insights.backups',
    subsystem: 'backups',
    weight: 1,
    async run() {
      const cfg = d.kernel.config().backups;
      const last = await readBackup(d.kernel);
      const now = d.kernel.ports.clock.now();
      if (!cfg.enabled && !last)
        return {
          score: 80,
          status: 'ok',
          message: 'Backups are turned off',
          technical: 'config.backups.enabled=false',
        };
      if (!last)
        return {
          score: 60,
          status: 'warn',
          message: 'No backup has finished yet',
          technical: 'lifecycle.backups/last missing',
        };
      if (!last.ok)
        return {
          score: 15,
          status: 'critical',
          message: 'The last backup failed',
          technical: `lifecycle.backups/last ok=false at=${last.at}${last.error ? ` error=${last.error}` : ''}`,
        };
      const interval = BACKUP_INTERVALS[cfg.schedule] ?? 86400;
      const age = now - (last.lastSuccessAt ?? last.at);
      const technical = `last success ${age}s ago; schedule=${cfg.schedule}`;
      const hours = Math.round(age / 3600);
      if (age <= interval * 1.5)
        return { score: 100, status: 'ok', message: 'Backups are up to date', technical };
      if (age <= interval * 3)
        return {
          score: 60,
          status: 'warn',
          message: `Last backup was ${hours} hours ago`,
          technical,
        };
      return {
        score: 20,
        status: 'critical',
        message: `No backup for ${Math.round(age / 86400)} days`,
        technical,
      };
    },
  };
}

export function certCheck(d: HealthDeps): HealthCheck {
  return {
    id: 'insights.certificates',
    subsystem: 'security',
    weight: 2,
    async run() {
      const certs = await readCerts(d.kernel);
      if (!certs || certs.length === 0)
        return {
          score: 100,
          status: 'ok',
          message: 'Secure connections are handled by your host',
          technical: 'no runtime.tls provider or no managed certificates',
        };
      const now = d.kernel.ports.clock.now();
      const soonest = certs.reduce((a, b) => (b.notAfter < a.notAfter ? b : a));
      const days = Math.floor((soonest.notAfter - now) / 86400);
      const technical = `certificate ${soonest.host} notAfter=${soonest.notAfter} (${days} days)`;
      if (soonest.notAfter <= now)
        return {
          score: 0,
          status: 'critical',
          message: 'The security certificate has expired',
          technical,
        };
      if (days < 3)
        return {
          score: 10,
          status: 'critical',
          message: `The security certificate expires in ${days < 1 ? 'less than a day' : `${days} days`}`,
          technical,
        };
      if (days < 14)
        return {
          score: 50,
          status: 'warn',
          message: `The security certificate expires in ${days} days`,
          technical,
        };
      if (days < 30)
        return {
          score: 90,
          status: 'ok',
          message: `Certificate renews soon (${days} days left)`,
          technical,
        };
      return { score: 100, status: 'ok', message: 'Security certificate is valid', technical };
    },
  };
}

export function builtinChecks(d: HealthDeps): HealthCheck[] {
  return [
    availabilityCheck(d),
    errorRateCheck(d),
    latencyCheck(d),
    storageCheck(d),
    backupCheck(d),
    certCheck(d),
  ];
}
