// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Daily/weekly digest (§6.9): health, growth, what changed, alerts, waiting
 * cards, and one optional tip. Plain language; sent through the routed channels.
 */
import type { AttentionCard, Kernel, Notification } from '@beamhop/core';
import type { AnalyticsReport, HealthReport, InsightsService } from '@beamhop/insights';
import type { AlertsEngine } from './engine.ts';

export const STATE_COLLECTION = 'alerts.state';
export const TIPS_COLLECTION = 'alerts.tips';

export interface Tip {
  id: string;
  text: string;
}

export const TIPS: Tip[] = [
  {
    id: 'phone-alerts',
    text: 'Turn on phone alerts so urgent problems reach you even when the app is closed.',
  },
  {
    id: 'backups',
    text: 'Backups are your safety net. Check that one finished recently and that you know how to restore it.',
  },
  {
    id: 'recovery-codes',
    text: 'Keep your recovery codes somewhere safe — they let you back in if you lose your key.',
  },
  {
    id: 'goals',
    text: 'Not sure about a setting? Adjust the goals sliders instead; Beamhop picks the exact limits for you.',
  },
  {
    id: 'second-admin',
    text: 'Invite a second admin or moderator so someone can step in while you are away.',
  },
  {
    id: 'oncall',
    text: 'With more than one admin, set an on-call rotation so alerts go to whoever is on duty.',
  },
  {
    id: 'landing-page',
    text: 'Share your landing page so people know what your relay is for and how to join.',
  },
  {
    id: 'playbooks',
    text: 'When something goes wrong, open the matching guide from the alert — it walks you through the fix.',
  },
  {
    id: 'undo',
    text: 'Most changes can be undone for a few minutes, and the config history can restore any earlier setup.',
  },
  { id: 'snooze', text: 'Alerts you already know about can be snoozed for a day with one tap.' },
];

export interface DigestContent {
  period: 'daily' | 'weekly';
  title: string;
  body: string;
  sections: Array<{ heading: string; lines: string[] }>;
  tipId?: string;
  severity: Notification['severity'];
}

function pctChange(cur: number, prev: number): string {
  if (prev === 0) return cur === 0 ? 'no change' : 'new';
  const p = Math.round(((cur - prev) / prev) * 100);
  if (p === 0) return 'about the same';
  return p > 0 ? `up ${p}%` : `down ${-p}%`;
}

const plural = (n: number, w: string) => `${n.toLocaleString('en')} ${w}${n === 1 ? '' : 's'}`;

export async function pickTip(kernel: Kernel, seq: number): Promise<Tip | undefined> {
  const dismissed = (await kernel.ports.docs.get<string[]>(TIPS_COLLECTION, 'dismissed')) ?? [];
  const open = TIPS.filter((t) => !dismissed.includes(t.id));
  if (open.length === 0) return undefined;
  return open[seq % open.length];
}

export async function buildDigest(
  kernel: Kernel,
  engine: AlertsEngine,
  period: 'daily' | 'weekly',
  opts: { now: number; tips: boolean; seq: number },
): Promise<DigestContent> {
  const days = period === 'daily' ? 1 : 7;
  const since = opts.now - days * 86400;
  const sections: DigestContent['sections'] = [];
  const insights = kernel.use<InsightsService>('insights');
  const periodWord = period === 'daily' ? 'today' : 'this week';

  // Health
  let health: HealthReport | null = null;
  if (insights) {
    try {
      health = await insights.score(null);
    } catch {
      health = null;
    }
  }
  if (health) {
    const lines = [`Health score ${health.score}/100 — ${health.message}.`];
    for (const c of health.checks.filter((x) => x.status !== 'ok').slice(0, 3))
      lines.push(`• ${c.message}`);
    sections.push({ heading: 'Health', lines });
  }

  // Growth
  if (insights) {
    const lines: string[] = [];
    for (const relay of kernel.config().relays) {
      let r: AnalyticsReport;
      try {
        r = await insights.analytics(relay.id, { days: days * 2 });
      } catch {
        continue;
      }
      const cur = r.dailyActive.slice(-days);
      const prev = r.dailyActive.slice(0, -days);
      const sum = (xs: typeof cur, k: 'events' | 'newUsers') => xs.reduce((a, d) => a + d[k], 0);
      const active = period === 'daily' ? r.activeUsers.daily : r.activeUsers.weekly;
      const name = kernel.config().relays.length > 1 ? `${relay.info.name}: ` : '';
      lines.push(
        `${name}${plural(active, 'active person')} ${periodWord}, ${plural(sum(cur, 'newUsers'), 'newcomer')}, ${plural(sum(cur, 'events'), 'post')} (${pctChange(sum(cur, 'events'), sum(prev, 'events'))}).`,
      );
    }
    if (lines.length) sections.push({ heading: 'Growth', lines });
  }

  // What changed
  const changes = await engine.changesSince(since);
  if (changes.length) {
    const lines = changes.slice(0, 5).map((c) => `• ${c.summary}`);
    if (changes.length > 5) lines.push(`…and ${changes.length - 5} more changes.`);
    sections.push({ heading: 'What changed', lines });
  }

  // Alerts
  const active = await engine.active();
  const resolved = await engine.history(since);
  if (active.length || resolved.length) {
    const lines: string[] = [];
    for (const a of active.slice(0, 5)) lines.push(`• Still open: ${a.title}`);
    if (resolved.length)
      lines.push(`${plural(resolved.length, 'problem')} came up and cleared ${periodWord}.`);
    sections.push({ heading: 'Alerts', lines });
  }

  // Waiting for you
  const cards: AttentionCard[] = [];
  for (const src of kernel.cards) {
    try {
      cards.push(...(await src.cards(null)));
    } catch {
      // a broken source never blocks the digest
    }
  }
  const rank = { critical: 0, warning: 1, info: 2 } as const;
  cards.sort((a, b) => rank[a.severity] - rank[b.severity]);
  sections.push({
    heading: 'Waiting for you',
    lines: cards.length
      ? [
          `${plural(cards.length, 'item')} on your home screen:`,
          ...cards.slice(0, 3).map((c) => `• ${c.title}`),
        ]
      : ['Nothing — your inbox is clear.'],
  });

  // Tip
  let tipId: string | undefined;
  if (opts.tips) {
    const tip = await pickTip(kernel, opts.seq);
    if (tip) {
      tipId = tip.id;
      sections.push({ heading: 'Tip', lines: [tip.text] });
    }
  }

  const status = health?.status ?? 'ok';
  const word = status === 'ok' ? 'healthy' : status === 'warn' ? 'needs a look' : 'needs attention';
  const title = `Your relay ${period === 'daily' ? 'today' : 'this week'}: ${word}${health ? ` (${health.score}/100)` : ''}`;
  const body = sections.map((s) => `${s.heading}\n${s.lines.join('\n')}`).join('\n\n');
  return {
    period,
    title,
    body,
    sections,
    ...(tipId ? { tipId } : {}),
    severity: 'info',
  };
}

/** Whether a digest is due at `now` (hourly job). */
export function digestDue(
  cadence: 'off' | 'daily' | 'weekly',
  now: number,
  lastSentAt: number | null,
  hourUtc: number,
  weekday: number,
): boolean {
  if (cadence === 'off') return false;
  const d = new Date(now * 1000);
  const minGap = cadence === 'daily' ? 20 * 3600 : 6 * 86400;
  if (lastSentAt !== null && now - lastSentAt < minGap) return false;
  if (d.getUTCHours() !== hourUtc) {
    // Catch up if we missed the slot entirely (server was down).
    const overdue = cadence === 'daily' ? 26 * 3600 : 8 * 86400;
    return lastSentAt !== null && now - lastSentAt > overdue;
  }
  return cadence === 'daily' || d.getUTCDay() === weekday;
}
