// SPDX-License-Identifier: AGPL-3.0-or-later
/** Insights screen logic, launch kit links, "Your week" and goal override markers. */
import { explainLimits } from '$goals';
import { RelaySchema } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import type { RelayConfig } from '../src/lib/api/types.ts';
import { LAUNCH_ITEMS, polishTarget } from '../src/lib/checklist.ts';
import {
  type LiveSnapshot,
  barWidth,
  cohortPercents,
  emptyHistory,
  pushHistory,
  summarizeLive,
  topApps,
} from '../src/lib/insights.ts';
import { resolveScreen } from '../src/lib/screens.ts';
import {
  goalLines,
  overrideCounts,
  revertOverride,
} from '../src/routes/settings/goals/overrides.ts';

const snap = (over: Partial<LiveSnapshot['relays'][number]> = {}): LiveSnapshot => ({
  at: 1,
  relays: [
    {
      relayId: 'main',
      connections: 10,
      eventsPerSecond: 3,
      rejectedPerSecond: 1,
      rejectedByReason: { 'rate-limited': 0.7, pow: 0.3 },
      acceptRatio: 0.75,
      reqPerSecond: 6,
      p50Ms: 4,
      p95Ms: 40,
      errorsPerMinute: 6,
      ...over,
    },
  ],
  storage: { events: 10, bytes: 2048 },
  disk: { freeBytes: 50, totalBytes: 100 },
});

describe('live ops summary', () => {
  it('sums relays and splits refusals by reason, biggest first', () => {
    const ops = summarizeLive(snap());
    expect(ops.connections).toBe(10);
    expect(ops.acceptRatio).toBe(0.75);
    expect(ops.reasons.map((r) => r.reason)).toEqual(['rate-limited', 'pow']);
    expect(ops.reasons[0]?.share).toBe(0.7);
    expect(ops.p95Ms).toBe(40);
    // 6 errors/min = 0.1/s over 10 handled/s.
    expect(ops.errorRate).toBe(0.01);
    expect(ops.dbBytes).toBe(2048);
    expect(ops.blobBytes).toBeNull();
    expect(ops.diskFreeBytes).toBe(50);
  });

  it('prefers per-relay numbers from newer servers', () => {
    const ops = summarizeLive(
      snap({ errorRate: 0.02, storageBytes: 999, blobBytes: 5, blobFiles: 1 }),
    );
    expect(ops.errorRate).toBe(0.02);
    expect(ops.dbBytes).toBe(999);
    expect(ops.blobBytes).toBe(5);
    expect(ops.blobFiles).toBe(1);
  });

  it('is calm when idle and keeps a bounded history', () => {
    const idle = summarizeLive({ at: 1, relays: [], storage: null });
    expect(idle.acceptRatio).toBe(1);
    expect(idle.errorRate).toBeNull();
    expect(idle.p95Ms).toBeNull();
    let h = emptyHistory();
    for (let i = 0; i < 5; i++) h = pushHistory(h, summarizeLive(snap({ eventsPerSecond: i })), 3);
    expect(h.events).toEqual([2, 3, 4]);
  });
});

describe('community helpers', () => {
  it('turns cohorts into percentages', () => {
    expect(cohortPercents([{ weekStart: 'w', size: 40, retained: [20, 10] }])).toEqual([
      { weekStart: 'w', size: 40, cells: [50, 25] },
    ]);
    expect(cohortPercents([{ weekStart: 'w', size: 0, retained: [0] }])[0]?.cells).toEqual([0]);
  });

  it('merges client tags and user agents into one list of apps', () => {
    const apps = topApps({
      topClients: [{ name: 'Amethyst', count: 12 }],
      topUserAgents: [
        { name: 'amethyst', count: 4 },
        { name: 'Damus', count: 8 },
      ],
    });
    expect(apps.map((a) => a.name)).toEqual(['Amethyst', 'Damus']);
    expect(apps[0]?.from).toEqual(['tag', 'agent']);
  });

  it('bar widths', () => {
    expect(barWidth(5, 10)).toBe(50);
    expect(barWidth(0, 10)).toBe(0);
    expect(barWidth(0.01, 10)).toBe(2);
    expect(barWidth(1, 0)).toBe(0);
  });
});

describe('screens and launch kit', () => {
  it('insights and the launch kit are real screens', () => {
    expect(resolveScreen('/insights')).toMatchObject({
      href: '/insights',
      fallback: false,
      tab: '/',
    });
    expect(resolveScreen('/launch').fallback).toBe(false);
    expect(resolveScreen('/home/launch-kit').href).toBe('/launch');
  });

  it('polish items open the profile setting; NIP names only in the lens', () => {
    const t = polishTarget({
      field: 'icon',
      text: 'Add an icon',
      technical: 'NIP-11 `icon` (URL) is missing',
      path: 'info.icon',
      importance: 'recommended',
    });
    expect(t.href).toBe('/settings/profile?field=info.icon');
    expect(t.lens[0]).toBe('NIP-11 icon');
    expect(LAUNCH_ITEMS.has('test-relay')).toBe(true);
  });
});

describe('goal override markers', () => {
  const relay = (limits: Record<string, unknown> = {}) =>
    RelaySchema.parse({ id: 'main', hosts: ['x'], limits }) as unknown as RelayConfig;
  const explain = (r: RelayConfig) => explainLimits(r as never) as never;

  it('marks overridden values with the goal they replaced and its value', () => {
    const lines = goalLines(relay({ eventsPerMinute: 5 }), explain);
    const epm = lines.find((l) => l.field === 'eventsPerMinute');
    expect(epm?.source).toBe('override');
    expect(epm?.revertible).toBe(true);
    expect(epm?.fromGoal).toBeDefined();
    expect(epm?.goalText).toBeTruthy();
    expect(epm?.goalText).not.toBe(epm?.text);
    expect(epm?.text).not.toContain('—');
    const counts = overrideCounts(lines);
    expect(Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)).toBe(1);
    expect(counts[epm!.fromGoal!]).toBe(1);
  });

  it('goal-derived values name their goal and nothing is marked without overrides', () => {
    const lines = goalLines(relay(), explain);
    expect(lines.some((l) => l.source === 'goal' && l.goal)).toBe(true);
    expect(lines.some((l) => l.source === 'override')).toBe(false);
    expect(overrideCounts(lines)).toEqual({});
  });

  it('going back removes the override with a merge patch', () => {
    expect(revertOverride('eventsPerMinute')).toEqual({ limits: { eventsPerMinute: null } });
  });
});
