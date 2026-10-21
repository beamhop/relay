// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Health checks (backup freshness/failures, retention lag, storage caps,
 * Litestream lag) and attention cards. Cards are suggestions: their actions
 * run only when an admin approves them (§6.8).
 */
import type { AttentionCard, CardSource, HealthCheck, HealthResult } from '@beamhop/core';
import type { BackupService } from './backup.ts';
import { type LitestreamMonitor, litestreamHealth } from './litestream.ts';
import type { RetentionEngine } from './retention.ts';
import type { LifecycleRuntime } from './runtime.ts';
import { SCHEDULE_SECONDS } from './settings.ts';

export const FAILOVER_PLAYBOOK = 'lifecycle.failover';

function ago(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} minutes`;
  if (seconds < 2 * 86_400) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86_400)} days`;
}

function mb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export async function backupHealth(
  rt: LifecycleRuntime,
  svc: BackupService,
): Promise<HealthResult> {
  const cfg = rt.kernel.config().backups;
  const now = rt.ports.clock.now();
  const last = await svc.last();
  const technical = `backups.enabled=${cfg.enabled} schedule=${cfg.schedule} target=${svc.targetUri() ?? 'none'} last=${JSON.stringify(last)}`;
  if (!cfg.enabled)
    return { score: 40, status: 'warn', message: 'Backups are turned off', technical };
  if (!svc.targetUri())
    return { score: 30, status: 'warn', message: 'Backups have nowhere to go', technical };
  const interval = SCHEDULE_SECONDS[cfg.schedule];
  if (!last) {
    if (now - rt.bootAt < interval + 3600)
      return { score: 80, status: 'ok', message: 'The first backup is scheduled', technical };
    return { score: 40, status: 'warn', message: 'No backup has been made yet', technical };
  }
  const okAge = last.lastOkAt !== undefined ? now - last.lastOkAt : Number.POSITIVE_INFINITY;
  if (!last.ok) {
    if (okAge > 2 * interval)
      return {
        score: 15,
        status: 'critical',
        message:
          last.lastOkAt === undefined
            ? 'Backups are failing'
            : `Backups are failing; the last good one is ${ago(okAge)} old`,
        technical: `${technical} error=${last.error ?? ''}`,
      };
    return {
      score: 60,
      status: 'warn',
      message: 'The last backup failed',
      technical: `${technical} error=${last.error ?? ''}`,
    };
  }
  if (okAge > 4 * interval)
    return {
      score: 20,
      status: 'critical',
      message: `The last backup is ${ago(okAge)} old`,
      technical,
    };
  if (okAge > 2 * interval)
    return {
      score: 60,
      status: 'warn',
      message: `The last backup is ${ago(okAge)} old`,
      technical,
    };
  return { score: 100, status: 'ok', message: `Last backup ${ago(okAge)} ago`, technical };
}

export function createHealthChecks(
  rt: LifecycleRuntime,
  backups: BackupService,
  retention: RetentionEngine,
  litestream: LitestreamMonitor,
): HealthCheck[] {
  const backupCheck: HealthCheck = {
    id: 'lifecycle.backups',
    subsystem: 'backups',
    weight: 2,
    run: () => backupHealth(rt, backups),
  };

  const retentionCheck: HealthCheck = {
    id: 'lifecycle.retention',
    subsystem: 'storage',
    weight: 1,
    async run(relayId) {
      const s = rt.settings().retention;
      const interval = s.intervalMinutes * 60;
      const now = rt.ports.clock.now();
      let worst = 0;
      let relays = 0;
      for (const relay of rt.relays(relayId)) {
        if (!retention.hasRetention(relay)) continue;
        relays++;
        const st = await retention.state(relay.id);
        worst = Math.max(worst, now - (st.lastCompleteAt ?? rt.bootAt));
      }
      const technical = `retention relays=${relays} worstLagSeconds=${worst} intervalSeconds=${interval}`;
      if (!relays || !s.enabled)
        return {
          score: 100,
          status: 'ok',
          message: s.enabled ? 'Posts are kept forever' : 'Old posts are not being removed',
          technical,
        };
      if (worst > 2 * interval + 86_400)
        return {
          score: 30,
          status: 'critical',
          message: `Old posts have not been cleaned up for ${ago(worst)}`,
          technical,
        };
      if (worst > 2 * interval + 3600)
        return { score: 70, status: 'warn', message: 'Cleaning up old posts is behind', technical };
      return { score: 100, status: 'ok', message: 'Old posts are cleaned up on time', technical };
    },
  };

  const capCheck: HealthCheck = {
    id: 'lifecycle.storage-cap',
    subsystem: 'storage',
    weight: 1,
    async run(relayId) {
      let worst: HealthResult = {
        score: 100,
        status: 'ok',
        message: 'Storage is within its limits',
      };
      for (const relay of rt.relays(relayId)) {
        const st = await retention.capStatus(relay.id);
        if (!st) continue;
        const pct = Math.round((st.bytes / st.maxBytes) * 100);
        const technical = `events.stats(${relay.id}).bytes=${st.bytes} cap=${st.maxBytes} (${pct}%)`;
        const r: HealthResult = st.over
          ? {
              score: 40,
              status: 'warn',
              message: `${relay.info.name} uses more space than its limit (${pct}%)`,
              technical,
            }
          : pct >= 90
            ? {
                score: 80,
                status: 'ok',
                message: `${relay.info.name} is at ${pct}% of its space`,
                technical,
              }
            : { score: 100, status: 'ok', message: 'Storage is within its limits', technical };
        if (r.score < worst.score) worst = r;
      }
      return worst;
    },
  };

  const litestreamCheck: HealthCheck = {
    id: 'lifecycle.litestream',
    subsystem: 'backups',
    get weight() {
      return rt.settings().litestream.enabled ? 2 : 0;
    },
    async run() {
      const cfg = rt.settings().litestream;
      if (!cfg.enabled)
        return { score: 100, status: 'ok', message: 'Continuous replication is not used' };
      return litestreamHealth(litestream.status, cfg);
    },
  };

  return [backupCheck, retentionCheck, capCheck, litestreamCheck];
}

export function createCardSource(
  rt: LifecycleRuntime,
  backups: BackupService,
  retention: RetentionEngine,
  litestream: LitestreamMonitor,
): CardSource {
  return {
    id: 'lifecycle',
    async cards(relayId) {
      const now = rt.ports.clock.now();
      const cards: AttentionCard[] = [];
      const cfg = rt.kernel.config().backups;
      const setup = {
        label: 'Set up backups',
        actionId: 'backups.setup',
        input: { enabled: true, schedule: 'daily', keep: cfg.keep },
      };
      if (!cfg.enabled) {
        cards.push({
          id: 'lifecycle.no-backups',
          relayId: null,
          severity: 'warning',
          title: 'No backups configured',
          body: 'If this server breaks, posts, media lists and settings are lost. Turn on daily backups — you can review the change before it is saved.',
          technical: 'config.backups.enabled=false; primary action previews a config patch',
          batchKey: 'lifecycle.backups',
          createdAt: now,
          primary: setup,
        });
      } else {
        const last = await backups.last();
        if (last && !last.ok) {
          cards.push({
            id: 'lifecycle.backup-failed',
            relayId: null,
            severity: 'critical',
            title: 'Last backup failed',
            body: `The backup on ${new Date(last.at * 1000).toUTCString()} did not finish: ${last.error ?? 'unknown error'}.`,
            technical: `lifecycle.backups/last ${JSON.stringify(last)}`,
            batchKey: 'lifecycle.backups',
            createdAt: last.at,
            primary: { label: 'Try again', actionId: 'backups.run-now', input: {} },
            secondary: { ...setup, label: 'Change backup settings' },
          });
        } else if (!backups.targetUri()) {
          cards.push({
            id: 'lifecycle.backup-no-target',
            relayId: null,
            severity: 'warning',
            title: 'Backups have nowhere to go',
            body: 'Choose a storage bucket (S3, R2 or Google Cloud) for backups.',
            batchKey: 'lifecycle.backups',
            createdAt: now,
            primary: { ...setup, label: 'Choose backup storage' },
          });
        }
      }

      for (const relay of rt.relays(relayId)) {
        const cap = retention.capFor(relay.id);
        if (!cap || cap.autoPrune) continue;
        const st = await retention.capStatus(relay.id);
        if (!st?.over) continue;
        cards.push({
          id: `lifecycle.storage-over:${relay.id}`,
          relayId: relay.id,
          severity: 'warning',
          title: 'Storage is over its limit',
          body: `${relay.info.name} uses ${mb(st.bytes)} of ${mb(st.maxBytes)}. Removing the oldest reactions and reposts would free about ${mb(st.bytes - st.targetBytes)}.`,
          technical: `prune kinds ${cap.lowValueKinds.join(',')} oldest-first to ${cap.targetPercent}% (lifecycle.prune-storage)`,
          batchKey: 'lifecycle.storage',
          createdAt: now,
          primary: {
            label: 'Remove oldest reactions',
            actionId: 'lifecycle.prune-storage',
            input: {},
          },
          playbook: 'disk-filling-up',
        });
      }

      const lit = rt.settings().litestream;
      if (lit.enabled && litestream.status.lastSampleAt !== undefined) {
        const h = litestreamHealth(litestream.status, lit);
        if (h.status !== 'ok')
          cards.push({
            id: 'lifecycle.litestream',
            relayId: null,
            severity: h.status === 'critical' ? 'critical' : 'warning',
            title: 'Standby server is falling behind',
            body: `${h.message}. If this server fails now, recent posts may be missing on the standby.`,
            ...(h.technical ? { technical: h.technical } : {}),
            batchKey: 'lifecycle.litestream',
            createdAt: now,
            playbook: FAILOVER_PLAYBOOK,
          });
      }
      return cards;
    },
  };
}
