// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type Goals, type RelayConfig, RelaySchema } from '@beamhop/core';
import {
  GOAL_TABLE,
  type GoalDrivenField,
  SPAM_TABLE,
  type SpamSettings,
  deriveLimits,
  deriveSpamSettings,
  explainLimits,
  goalOverrides,
  interpolate,
  limitsFromGoals,
  overridesByGoal,
  retentionDaysFor,
} from '../src/goals.ts';
import { setup } from './helpers.ts';

const relayWith = (over: Record<string, unknown> = {}): RelayConfig =>
  RelaySchema.parse({ id: 'main', hosts: ['x.example'], ...over });

const MID: Goals = { openness: 50, spamTolerance: 50, storage: 50, media: 50, speedVsCost: 50 };

describe('interpolate', () => {
  test('hits anchors and interpolates linearly', () => {
    const a = [0, 10, 20, 30, 40] as const;
    expect(interpolate(a, 0)).toBe(0);
    expect(interpolate(a, 25)).toBe(10);
    expect(interpolate(a, 100)).toBe(40);
    expect(interpolate(a, 12.5)).toBe(5);
    expect(interpolate(a, -5)).toBe(0);
    expect(interpolate(a, 500)).toBe(40);
    expect(interpolate(a, Number.NaN)).toBe(0);
  });
});

describe('goals mapping tables', () => {
  for (const [field, m] of Object.entries(GOAL_TABLE) as Array<
    [GoalDrivenField, (typeof GOAL_TABLE)[GoalDrivenField]]
  >) {
    test(`${field} is monotonic in ${m.goal}`, () => {
      const dir = Math.sign(m.anchors[4] - m.anchors[0]);
      expect(dir).not.toBe(0);
      // anchors themselves are monotonic
      for (let i = 1; i < 5; i++)
        expect(Math.sign(m.anchors[i]! - m.anchors[i - 1]!) * dir).toBeGreaterThanOrEqual(0);
      let prev: number | undefined;
      for (let x = 0; x <= 100; x++) {
        const v = limitsFromGoals({ ...MID, [m.goal]: x })[field] as number;
        if (prev !== undefined) expect((v - prev) * dir).toBeGreaterThanOrEqual(0);
        prev = v;
      }
    });
    test(`${field} does not depend on other goals`, () => {
      const base = limitsFromGoals(MID)[field];
      for (const g of Object.keys(MID) as Array<keyof Goals>) {
        if (g === m.goal) continue;
        for (const x of [0, 100]) {
          if (field === 'newKeyPowDifficulty') continue; // clamped ≥ minPow (same goal)
          expect(limitsFromGoals({ ...MID, [g]: x })[field]).toBe(base);
        }
      }
    });
  }

  test('stricter openness never lowers puzzles or raises post rate', () => {
    const strict = limitsFromGoals({ ...MID, openness: 0 });
    const open = limitsFromGoals({ ...MID, openness: 100 });
    expect(strict.eventsPerMinute).toBeLessThan(open.eventsPerMinute);
    expect(strict.newKeyPowDifficulty).toBeGreaterThan(open.newKeyPowDifficulty);
    expect(strict.minPowDifficulty).toBeGreaterThanOrEqual(open.minPowDifficulty);
  });

  test('newKeyPowDifficulty is never below minPowDifficulty', () => {
    for (let x = 0; x <= 100; x++) {
      const l = limitsFromGoals({ ...MID, openness: x });
      expect(l.newKeyPowDifficulty).toBeGreaterThanOrEqual(l.minPowDifficulty);
    }
  });

  test('retention is monotonic with keep-forever at the top', () => {
    let prev = 0;
    for (let x = 0; x <= 100; x++) {
      const v = retentionDaysFor(x) ?? Number.POSITIVE_INFINITY;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(retentionDaysFor(0)).toBe(30);
    expect(retentionDaysFor(100)).toBeUndefined();
  });

  for (const [field, m] of Object.entries(SPAM_TABLE) as Array<
    [keyof SpamSettings, (typeof SPAM_TABLE)[keyof SpamSettings]]
  >) {
    test(`spam setting ${field} is monotonic in ${m.goal}`, () => {
      const dir = Math.sign(m.anchors[4] - m.anchors[0]);
      let prev: number | undefined;
      for (let x = 0; x <= 100; x += 5) {
        const v = deriveSpamSettings(relayWith({ goals: { ...MID, [m.goal]: x } }))[field];
        if (prev !== undefined) expect((v - prev) * dir).toBeGreaterThanOrEqual(0);
        prev = v;
      }
    });
  }

  test('aggressive spam settings are stricter than relaxed', () => {
    const agg = deriveSpamSettings(relayWith({ goals: { spamTolerance: 0 } }));
    const rel = deriveSpamSettings(relayWith({ goals: { spamTolerance: 100 } }));
    expect(agg.duplicateWindowSeconds).toBeGreaterThan(rel.duplicateWindowSeconds);
    expect(agg.nearDuplicateDistance).toBeGreaterThan(rel.nearDuplicateDistance);
    expect(agg.maxLinks).toBeLessThan(rel.maxLinks);
    expect(rel.nearDuplicateDistance).toBe(0);
  });

  test('values are integers (except spam threshold)', () => {
    for (let x = 0; x <= 100; x += 7) {
      const l = limitsFromGoals({
        openness: x,
        spamTolerance: x,
        storage: x,
        media: x,
        speedVsCost: x,
      });
      for (const f of Object.keys(GOAL_TABLE) as GoalDrivenField[]) {
        if (f === 'spamThreshold') continue;
        expect(Number.isInteger(l[f])).toBe(true);
      }
      expect(l.spamThreshold).toBeGreaterThan(0);
      expect(l.spamThreshold).toBeLessThan(1);
    }
  });
});

describe('deriveLimits', () => {
  test('defaults come from goals with nothing overridden', () => {
    const l = deriveLimits(relayWith());
    expect(l.overridden).toEqual([]);
    expect(l.eventsPerMinute).toBe(limitsFromGoals(relayWith().goals).eventsPerMinute);
    expect(l.blockedKinds).toEqual([]);
    expect(l.allowedKinds).toBeUndefined();
  });

  test('tier values apply, then overrides win and are recorded', () => {
    const relay = relayWith({
      tiers: [
        { id: 'default', name: 'Default' },
        {
          id: 'plus',
          name: 'Plus',
          eventsPerMinute: 999,
          maxEventBytes: 4096,
          allowedKinds: [1, 7],
          blobQuotaBytes: 123,
          maxBlobBytes: 456,
          retentionDays: 7,
        },
      ],
      limits: { maxEventBytes: 2048, blockedKinds: [4] },
    });
    const def = deriveLimits(relay);
    const plus = deriveLimits(relay, 'plus');
    expect(def.eventsPerMinute).not.toBe(999);
    expect(plus.eventsPerMinute).toBe(999);
    expect(plus.allowedKinds).toEqual([1, 7]);
    expect(plus.defaultBlobQuotaBytes).toBe(123);
    expect(plus.maxBlobBytes).toBe(456);
    expect(plus.defaultRetentionDays).toBe(7);
    // override beats tier
    expect(plus.maxEventBytes).toBe(2048);
    expect(plus.blockedKinds).toEqual([4]);
    expect(plus.overridden).toEqual(['blockedKinds', 'maxEventBytes']);
    // unknown tier falls back to default tier
    expect(deriveLimits(relay, 'nope').eventsPerMinute).toBe(def.eventsPerMinute);
  });

  test('blossom settings apply below tier', () => {
    const relay = relayWith({ blossom: { maxBlobBytes: 1000, defaultQuotaBytes: 5000 } });
    const l = deriveLimits(relay);
    expect(l.maxBlobBytes).toBe(1000);
    expect(l.defaultBlobQuotaBytes).toBe(5000);
    expect(l.overridden).toEqual([]);
  });

  test('is memoized per config object', () => {
    const relay = relayWith();
    expect(deriveLimits(relay)).toBe(deriveLimits(relay));
    expect(deriveLimits(relay, 'default')).toEqual(deriveLimits(relay));
  });
});

describe('explainLimits', () => {
  test('every value has plain text, technical text and a source', () => {
    const relay = relayWith({ limits: { eventsPerMinute: 5 } });
    const lines = explainLimits(relay);
    expect(lines.length).toBeGreaterThan(Object.keys(GOAL_TABLE).length);
    for (const l of lines) {
      expect(l.text.length).toBeGreaterThan(5);
      expect(l.technical.length).toBeGreaterThan(5);
      expect(l.text).not.toContain('NIP-');
    }
    const epm = lines.find((l) => l.field === 'eventsPerMinute');
    expect(epm?.source).toBe('override');
    expect(epm?.text).toContain('overridden');
    const pow = lines.find((l) => l.field === 'newKeyPowDifficulty');
    expect(pow?.source).toBe('goal');
    expect(pow?.goal).toBe('openness');
    expect(pow?.technical).toContain('NIP-13');
  });
});

describe('goal overrides', () => {
  test('reports which goal an override replaced and what the goal would set', () => {
    const relay = relayWith({ goals: MID, limits: { eventsPerMinute: 5, maxEventBytes: 1000 } });
    const ov = goalOverrides(relay);
    const epm = ov.find((o) => o.field === 'eventsPerMinute');
    expect(epm).toEqual({
      field: 'eventsPerMinute',
      goal: GOAL_TABLE.eventsPerMinute.goal,
      value: 5,
      goalValue: limitsFromGoals(MID).eventsPerMinute,
    });
    expect(ov.find((o) => o.field === 'maxEventBytes')?.goal).toBe(GOAL_TABLE.maxEventBytes.goal);
    const counts = overridesByGoal(relay);
    expect(Object.values(counts).reduce((a, b) => a + (b ?? 0), 0)).toBe(2);
    expect(goalOverrides(relayWith())).toEqual([]);
    const line = explainLimits(relay).find((l) => l.field === 'eventsPerMinute');
    expect(line?.goal).toBeUndefined();
    expect(line?.goalWouldSet?.goal).toBe(GOAL_TABLE.eventsPerMinute.goal);
  });
});

describe('kernel integration', () => {
  test('policy module registers the limits resolver', async () => {
    const { kernel } = await setup({ goals: { openness: 0 }, limits: { maxLimit: 7 } });
    const l = kernel.limits('main');
    expect(l.eventsPerMinute).toBe(6);
    expect(l.maxLimit).toBe(7);
    expect(l.overridden).toEqual(['maxLimit']);
  });
});
