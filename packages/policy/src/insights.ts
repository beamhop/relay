// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Moderation health check and attention cards (§6.8/§6.9). Cards are
 * suggestions only: their actions run solely on explicit admin approval.
 */
import type { AttentionCard, CardSource, HealthCheck, RelayId } from '@beamhop/core';
import type { QueueItem } from './moderation.ts';
import { REPORT_TYPE_LABELS } from './moderation.ts';
import type { PolicyRuntime } from './runtime.ts';
import { plural } from './util.ts';

export const BACKLOG_WARN = 25;
export const BACKLOG_CRITICAL = 100;
/** Oldest pending item age (seconds) that makes the backlog a warning. */
export const BACKLOG_STALE_SECONDS = 48 * 3600;

function relayIds(rt: PolicyRuntime, relayId: RelayId | null): RelayId[] {
  return relayId ? [relayId] : rt.kernel.config().relays.map((r) => r.id);
}

export function moderationHealth(rt: PolicyRuntime): HealthCheck {
  return {
    id: 'policy.moderation-backlog',
    subsystem: 'moderation',
    weight: 1,
    async run(relayId) {
      let pending = 0;
      let oldest = Number.POSITIVE_INFINITY;
      for (const id of relayIds(rt, relayId)) {
        const items = await rt.queue.list(id, { status: 'pending' });
        pending += items.length;
        for (const i of items) oldest = Math.min(oldest, i.createdAt);
      }
      const age = pending ? rt.kernel.ports.clock.now() - oldest : 0;
      const technical = `policy.queue pending=${pending} oldestAgeSeconds=${age}`;
      if (pending === 0)
        return { score: 100, status: 'ok', message: 'Nothing waiting for review', technical };
      if (pending >= BACKLOG_CRITICAL)
        return {
          score: 20,
          status: 'critical',
          message: `${plural(pending, 'item')} waiting for review`,
          technical,
        };
      if (pending >= BACKLOG_WARN || age >= BACKLOG_STALE_SECONDS)
        return {
          score: 60,
          status: 'warn',
          message:
            age >= BACKLOG_STALE_SECONDS
              ? `${plural(pending, 'item')} waiting, some for more than 2 days`
              : `${plural(pending, 'item')} waiting for review`,
          technical,
        };
      return {
        score: 90,
        status: 'ok',
        message: `${plural(pending, 'item')} waiting for review`,
        technical,
      };
    },
  };
}

function batchTitle(key: string, n: number): { title: string; body: string } {
  if (key.startsWith('report:')) {
    const type = key.slice('report:'.length);
    const label = REPORT_TYPE_LABELS[type] ?? 'other problems';
    return {
      title: `${plural(n, 'report')} to review`,
      body: `People reported content for ${label}. Keep or remove each one.`,
    };
  }
  if (key.startsWith('held:'))
    return {
      title: `${plural(n, 'post')} waiting for approval`,
      body: 'An automatic filter held these posts. Nobody sees them until you decide.',
    };
  if (key.startsWith('blob:'))
    return {
      title: `${plural(n, 'file')} flagged`,
      body: 'These files matched a safety list and are not being served.',
    };
  return { title: `${plural(n, 'item')} to review`, body: 'Waiting for a decision.' };
}

export function moderationCards(rt: PolicyRuntime): CardSource {
  return {
    id: 'policy.moderation',
    async cards(relayId) {
      const out: AttentionCard[] = [];
      const now = rt.kernel.ports.clock.now();
      for (const id of relayIds(rt, relayId)) {
        const pending = await rt.queue.list(id, { status: 'pending' });
        const batches = new Map<string, QueueItem[]>();
        for (const item of pending) {
          let arr = batches.get(item.batchKey);
          if (!arr) {
            arr = [];
            batches.set(item.batchKey, arr);
          }
          arr.push(item);
        }
        for (const [key, items] of batches) {
          const { title, body } = batchTitle(key, items.length);
          const oldest = items[0]?.createdAt ?? now;
          const severity: AttentionCard['severity'] = key.startsWith('blob:')
            ? 'critical'
            : items.length >= 10 || now - oldest > 86400
              ? 'warning'
              : 'info';
          out.push({
            id: `policy:${id}:${key}`,
            relayId: id,
            severity,
            title,
            body,
            technical: `policy.queue batchKey=${key} count=${items.length}`,
            batchKey: key,
            createdAt: oldest,
            primary: {
              label: 'Review',
              actionId: 'moderation.queue',
              input: { status: 'pending', batchKey: key },
            },
          });
        }
        // Spam wave: many new keys tripping spam filters recently.
        const cfg = rt.config().spamWave;
        const keys = rt.spam.newKeys(id, now, cfg.windowMinutes * 60);
        if (keys.length >= cfg.minKeys) {
          const shown = keys.slice(0, 1000);
          out.push({
            id: `policy:${id}:spam-wave`,
            relayId: id,
            severity: 'warning',
            title: `Spam wave from ${plural(keys.length, 'new key')}`,
            body: `In the last ${plural(cfg.windowMinutes, 'minute')}, ${plural(keys.length, 'new account')} kept hitting the spam filters. Your filters are already blocking them; you can also block these accounts.`,
            technical: `distinct new pubkeys rejected by rate-limit/pow/duplicate/content within ${cfg.windowMinutes}m`,
            batchKey: 'spam-wave',
            createdAt: now,
            primary: {
              label: `Block ${plural(shown.length, 'account')}`,
              actionId: 'moderation.ban-pubkey',
              input: { pubkeys: shown, reason: 'spam wave' },
            },
            secondary: {
              label: 'Show filter activity',
              actionId: 'policy.stats',
              input: {},
            },
          });
        }
      }
      return out;
    },
  };
}
