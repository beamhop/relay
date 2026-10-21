// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Built-in alert rules. Each rule looks at one relay (or the node) and either
 * returns a hit (plain-language title/body + technical lens + playbook) or null.
 * Rules never change anything — existing filters keep enforcing (§6.8).
 */
import type { Kernel, RelayId } from '@beamhop/core';
import {
  BACKUP_INTERVALS,
  type DiskInfo,
  formatBytes,
  readBackup,
  readCerts,
  readDisk,
} from '@beamhop/insights';
import { type Baseline, WARMUP_SAMPLES, linearRegression } from './baseline.ts';
import type { AlertsModuleConfig, Severity } from './config.ts';

export type Category = 'ops' | 'safety';

export interface RuleHit {
  severity: Exclude<Severity, 'info'>;
  title: string;
  body: string;
  technical: string;
  playbook?: string;
}

/** Per-minute rates for the last evaluation window. */
export interface Signals {
  rejectedPerMin: number;
  errorsPerMin: number;
  acceptedPerMin: number;
  connections: number;
}

export interface RuleContext {
  kernel: Kernel;
  cfg: AlertsModuleConfig;
  now: number;
  relayId: RelayId | null;
  signals: Signals;
  baseline(signal: keyof Signals): Baseline;
  storageSeries(): Promise<Array<{ t: number; v: number }>>;
  disk(): Promise<DiskInfo | null>;
}

export interface Rule {
  id: string;
  scope: 'relay' | 'node';
  /** Plain name shown in mute lists. */
  name: string;
  category: Category;
  /** Whether an alert of this rule becomes an attention card. */
  card: boolean;
  enabled(cfg: AlertsModuleConfig): boolean;
  evaluate(ctx: RuleContext): Promise<RuleHit | null>;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export const spamWaveRule: Rule = {
  id: 'spam-wave',
  scope: 'relay',
  name: 'Spam waves',
  category: 'ops',
  card: true,
  enabled: (c) => c.rules.spamWave.enabled,
  async evaluate(ctx) {
    const c = ctx.cfg.rules.spamWave;
    const x = ctx.signals.rejectedPerMin;
    const { z, exp } = ctx.baseline('rejectedPerMin').score(x, ctx.now);
    const warmed = exp.n >= WARMUP_SAMPLES;
    const anomalous = warmed && x >= c.minPerMinute && x >= c.factor * exp.mean && z >= 4;
    const huge = x >= c.minPerMinute * 10 && x >= c.factor * exp.mean;
    if (!anomalous && !huge) return null;
    return {
      severity: 'warning',
      title: 'Spam wave in progress',
      body: `About ${Math.round(x)} posts a minute are being turned away (normally about ${Math.round(exp.mean)}). Your filters are blocking them; you may want to tighten things for a while.`,
      technical: `rejections/min=${r1(x)} baseline=${r1(exp.mean)}±${r1(exp.std)} z=${r1(z)} seasonal=${exp.seasonal} (excludes duplicate)`,
      playbook: 'spam-attack',
    };
  },
};

export const errorSpikeRule: Rule = {
  id: 'error-spike',
  scope: 'relay',
  name: 'Error spikes',
  category: 'ops',
  card: true,
  enabled: (c) => c.rules.errorSpike.enabled,
  async evaluate(ctx) {
    const c = ctx.cfg.rules.errorSpike;
    const x = ctx.signals.errorsPerMin;
    const { z, exp } = ctx.baseline('errorsPerMin').score(x, ctx.now);
    const technical = `errors/min=${r1(x)} baseline=${r1(exp.mean)}±${r1(exp.std)} z=${r1(z)}`;
    if (x >= c.criticalPerMinute)
      return {
        severity: 'critical',
        title: 'Many errors right now',
        body: `The relay hit ${Math.round(x)} errors in the last minute. People may be unable to post or read.`,
        technical,
        playbook: 'slow-relay',
      };
    const warmed = exp.n >= WARMUP_SAMPLES;
    if (warmed && x >= c.minPerMinute && x >= 3 * exp.mean && z >= 4)
      return {
        severity: 'warning',
        title: 'More errors than usual',
        body: `About ${Math.round(x)} errors a minute, normally about ${Math.round(exp.mean)}.`,
        technical,
        playbook: 'slow-relay',
      };
    return null;
  },
};

export const connectionDropRule: Rule = {
  id: 'connection-drop',
  scope: 'relay',
  name: 'Connection drops',
  category: 'ops',
  card: true,
  enabled: (c) => c.rules.connectionDrop.enabled,
  async evaluate(ctx) {
    const c = ctx.cfg.rules.connectionDrop;
    const x = ctx.signals.connections;
    const exp = ctx.baseline('connections').expected(ctx.now);
    if (exp.n < WARMUP_SAMPLES || exp.mean < c.minBaseline) return null;
    const technical = `connections=${x} baseline=${r1(exp.mean)} ratio=${r1(x / exp.mean)}`;
    if (x === 0)
      return {
        severity: 'critical',
        title: 'Nobody is connected',
        body: `Usually about ${Math.round(exp.mean)} people are connected, now none are. The relay may be unreachable.`,
        technical,
        playbook: 'slow-relay',
      };
    if (x <= c.dropRatio * exp.mean)
      return {
        severity: 'warning',
        title: 'Connections dropped sharply',
        body: `${x} people connected, usually about ${Math.round(exp.mean)}.`,
        technical,
        playbook: 'slow-relay',
      };
    return null;
  },
};

export const diskFillRule: Rule = {
  id: 'disk-fill',
  scope: 'node',
  name: 'Disk filling up',
  category: 'ops',
  card: true,
  enabled: (c) => c.rules.diskFill.enabled,
  async evaluate(ctx) {
    const c = ctx.cfg.rules.diskFill;
    const series = await ctx.storageSeries();
    const disk = await ctx.disk();
    const last = series[series.length - 1]?.v;
    let free: number | null = disk ? disk.freeBytes : null;
    const budget = ctx.kernel.moduleConfig<{ storageBudgetBytes?: number }>(
      'insights',
    )?.storageBudgetBytes;
    if (free === null && budget && last !== undefined) free = Math.max(0, budget - last);
    if (free === null) return null;
    if (disk && disk.totalBytes > 0 && free / disk.totalBytes < 0.03)
      return {
        severity: 'critical',
        title: 'Disk is almost full',
        body: `Only ${formatBytes(free)} left. When it runs out, the relay stops saving posts.`,
        technical: `disk free=${free} total=${disk.totalBytes}`,
        playbook: 'disk-full',
      };
    if (series.length < 6 || series[series.length - 1]!.t - series[0]!.t < 3600) return null;
    const fit = linearRegression(series);
    if (!fit || fit.slope <= 0) return null;
    const etaSeconds = free / fit.slope;
    const technical = `growth=${Math.round(fit.slope * 86400)} B/day (OLS over ${series.length} points, r²=${r1(fit.r2)}), free=${free}, ETA=${Math.round(etaSeconds / 3600)}h`;
    const when =
      etaSeconds < 86400
        ? `about ${Math.max(1, Math.round(etaSeconds / 3600))} hours`
        : `about ${Math.round(etaSeconds / 86400)} days`;
    if (etaSeconds < c.criticalHours * 3600)
      return {
        severity: 'critical',
        title: 'Disk will be full very soon',
        body: `At the current pace the disk fills up in ${when}.`,
        technical,
        playbook: 'disk-full',
      };
    if (etaSeconds < c.warnDays * 86400)
      return {
        severity: 'warning',
        title: 'Disk is filling up',
        body: `At the current pace the disk fills up in ${when}. Now is a good time to make room.`,
        technical,
        playbook: 'disk-full',
      };
    return null;
  },
};

export const certRule: Rule = {
  id: 'cert-expiry',
  scope: 'node',
  name: 'Certificate expiry',
  category: 'ops',
  card: true,
  enabled: (c) => c.rules.cert.enabled,
  async evaluate(ctx) {
    const c = ctx.cfg.rules.cert;
    const certs = await readCerts(ctx.kernel);
    if (!certs?.length) return null;
    const soonest = certs.reduce((a, b) => (b.notAfter < a.notAfter ? b : a));
    const days = (soonest.notAfter - ctx.now) / 86400;
    const technical = `certificate host=${soonest.host} notAfter=${soonest.notAfter} daysLeft=${r1(days)}`;
    if (days <= 0)
      return {
        severity: 'critical',
        title: 'Security certificate expired',
        body: `Apps can't connect securely to ${soonest.host} until the certificate is renewed.`,
        technical,
        playbook: 'cert-problem',
      };
    if (days < c.criticalDays)
      return {
        severity: 'critical',
        title: 'Security certificate expires very soon',
        body: `The certificate for ${soonest.host} expires in ${days < 1 ? 'less than a day' : `${Math.floor(days)} days`} and hasn't renewed yet.`,
        technical,
        playbook: 'cert-problem',
      };
    if (days < c.warnDays)
      return {
        severity: 'warning',
        title: 'Security certificate expires soon',
        body: `The certificate for ${soonest.host} expires in ${Math.floor(days)} days and hasn't renewed yet.`,
        technical,
        playbook: 'cert-problem',
      };
    return null;
  },
};

export const backupRule: Rule = {
  id: 'backup',
  scope: 'node',
  name: 'Backups',
  category: 'ops',
  card: true,
  enabled: (c) => c.rules.backup.enabled,
  async evaluate(ctx) {
    const cfg = ctx.kernel.config().backups;
    const last = await readBackup(ctx.kernel);
    if (last && !last.ok)
      return {
        severity: 'critical',
        title: 'Backup failed',
        body: 'The last backup did not finish. Your data is not safely copied right now.',
        technical: `lifecycle.backups/last ok=false at=${last.at}${last.error ? ` error=${last.error}` : ''}`,
      };
    if (!cfg.enabled) return null;
    const interval = BACKUP_INTERVALS[cfg.schedule] ?? 86400;
    if (!last) return null;
    const age = ctx.now - (last.lastSuccessAt ?? last.at);
    if (age > interval * 2)
      return {
        severity: 'warning',
        title: 'Backups are behind',
        body: `The last good backup is ${Math.round(age / 3600)} hours old (expected ${cfg.schedule}).`,
        technical: `last success age=${age}s schedule=${cfg.schedule}`,
      };
    return null;
  },
};

export const moderationBacklogRule: Rule = {
  id: 'moderation-backlog',
  scope: 'relay',
  name: 'Review queue piling up',
  category: 'safety',
  // The policy module already shows review cards; this only notifies.
  card: false,
  enabled: (c) => c.rules.moderationBacklog.enabled,
  async evaluate(ctx) {
    const check = ctx.kernel.health.find((h) => h.id === 'policy.moderation-backlog');
    if (!check) return null;
    const r = await check.run(ctx.relayId);
    if (r.status === 'ok') return null;
    return {
      severity: r.status === 'critical' ? 'critical' : 'warning',
      title: 'Review queue is piling up',
      body: `${r.message}. Reported posts stay as they are until someone decides.`,
      technical: r.technical ?? 'policy.moderation-backlog',
    };
  },
};

export const BUILTIN_RULES: Rule[] = [
  spamWaveRule,
  errorSpikeRule,
  connectionDropRule,
  diskFillRule,
  certRule,
  backupRule,
  moderationBacklogRule,
];
