// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { defineModule } from '@beamhop/core';
import {
  PLAYBOOKS,
  SIMPLE_SCREEN_BUDGET,
  assertComplexityBudget,
  checkComplexityBudget,
  hasConfigPath,
  simpleScreens,
  weekStartOf,
} from '../src/index.ts';
import { OWNER, setup } from './helpers.ts';

describe('playbooks', () => {
  test('registers the six guided playbooks with plain steps', async () => {
    const { kernel, svc } = await setup();
    const ids = kernel.playbooks.map((p) => p.id);
    for (const id of [
      'spam-attack',
      'disk-full',
      'moving-servers',
      'lost-admin-access',
      'relay-is-slow',
      'certificate-problem',
    ])
      expect(ids).toContain(id);
    expect(svc.playbooksAdded).toHaveLength(6);
    for (const p of PLAYBOOKS) {
      expect(p.steps.length).toBeGreaterThanOrEqual(5);
      for (const s of p.steps) expect(s.body).not.toMatch(/NIP-|kind \d/);
    }
  });

  test('step actions exist (when their module is enabled)', async () => {
    const { kernel } = await setup();
    const external = new Set(['admins.invite', 'admins.recovery-codes']); // admin-api, not loaded here
    for (const p of PLAYBOOKS)
      for (const s of p.steps)
        if (s.actionId && !external.has(s.actionId)) {
          const def = kernel.actions.get(s.actionId);
          expect(def, `${p.id}: ${s.actionId}`).toBeDefined();
          expect(() => def!.input.parse(s.input ?? {})).not.toThrow();
        }
  });

  test('skips ids another module already registered', async () => {
    const other = defineModule({
      id: 'alerts-like',
      register(k) {
        k.playbooks.push({ id: 'disk-full', title: 'Disk (alerts)', steps: [] });
      },
    });
    const { kernel, svc } = await setup({ modules: [other] });
    expect(kernel.playbooks.filter((p) => p.id === 'disk-full')).toHaveLength(1);
    expect(kernel.playbooks.find((p) => p.id === 'disk-full')?.title).toBe('Disk (alerts)');
    expect(svc.playbooksAdded).not.toContain('disk-full');
  });
});

describe('weekly admin minutes (local only)', () => {
  test('weeks start on Monday UTC', () => {
    // 2023-11-14 22:13:20 UTC (Tuesday) → Monday 2023-11-13 00:00 UTC.
    expect(weekStartOf(1_700_000_000)).toBe(1_699_833_600);
    expect(new Date(weekStartOf(1_700_000_000) * 1000).getUTCDay()).toBe(1);
  });

  test('sessions from actions and pings; only my own stats', async () => {
    const { act, kernel, ports, svc } = await setup();
    const emit = (principalId: string) =>
      kernel.bus.emit('admin.action', {
        relayId: null,
        actionId: 'x',
        principalId,
        input: {},
        summary: 'x',
        ok: true,
      });
    emit(OWNER.id); // session 1 starts: +60s
    ports.clock.advance(120);
    await act('experience.ping', {}); // +120s
    ports.clock.advance(180);
    emit(OWNER.id); // +180s
    ports.clock.advance(3600); // gap → new session
    emit(OWNER.id); // +60s
    emit('system'); // never counted
    emit('someone-else');
    await svc.idle();

    const { output } = await act('experience.my-stats', {});
    expect(output.thisWeek.sessions).toBe(2);
    expect(output.thisWeek.actions).toBe(3);
    expect(output.thisWeek.tasksDone).toBe(3);
    expect(output.thisWeek.suggestionsApproved).toBe(0);
    expect(output.thisWeek.minutesSaved).toBe(0);
    expect(output.thisWeek.minutes).toBe(7);
    expect(output.onTrack).toBe(true);
    expect(output.goalMinutes).toBe(10);
    expect(output.privacy).toContain('Never sent');
    expect(output.previousWeeks).toHaveLength(4);

    const other = await act(
      'experience.my-stats',
      {},
      { principal: { ...OWNER, id: 'someone-else' } },
    );
    expect(other.output.thisWeek.sessions).toBe(1);

    // Over budget.
    for (let i = 0; i < 12; i++) {
      ports.clock.advance(60);
      await act('experience.ping', {});
    }
    expect((await act('experience.my-stats', {})).output.onTrack).toBe(false);
  });
});

describe('time saved by suggestions (local only)', () => {
  test('approved suggestions count as tasks and estimated minutes saved', async () => {
    const { act, kernel, svc } = await setup();
    for (const actionId of ['experience.approve-card', 'experience.approve-card', 'x'])
      kernel.bus.emit('admin.action', {
        relayId: null,
        actionId,
        principalId: OWNER.id,
        input: {},
        summary: 'x',
        ok: true,
      });
    await svc.idle();
    const { output } = await act('experience.my-stats', {});
    expect(output.thisWeek.tasksDone).toBe(3);
    expect(output.thisWeek.suggestionsApproved).toBe(2);
    expect(output.thisWeek.minutesSaved).toBe(6);
    expect(output.privacy).toContain('Never sent');
  });
});

describe('complexity budget', () => {
  test('every simple screen has at most 7 settings that exist in the config schema', () => {
    expect(SIMPLE_SCREEN_BUDGET).toBe(7);
    expect(checkComplexityBudget()).toEqual([]);
    expect(() => assertComplexityBudget()).not.toThrow();
    for (const s of simpleScreens) expect(s.settings.length).toBeLessThanOrEqual(7);
  });

  test('flags screens over budget, unknown and duplicate settings', () => {
    const v = checkComplexityBudget([
      {
        id: 'bloated',
        title: 'Too much',
        path: '/x',
        settings: [
          'relays[].goals.openness',
          'relays[].goals.spamTolerance',
          'relays[].goals.storage',
          'relays[].goals.media',
          'relays[].goals.speedVsCost',
          'relays[].persona',
          'relays[].info.name',
          'relays[].info.name',
          'relays[].nonsense',
        ],
      },
    ]);
    expect(v.map((x) => x.problem).sort()).toEqual([
      'duplicate-setting',
      'over-budget',
      'unknown-setting',
    ]);
    expect(() =>
      assertComplexityBudget([{ id: 'x', title: 'x', path: '/x', settings: ['nope'] }]),
    ).toThrow(/Complexity budget broken/);
  });

  test('path resolution', () => {
    expect(hasConfigPath('backups.enabled')).toBe(true);
    expect(hasConfigPath('relays[].access.wot.depth')).toBe(true);
    expect(hasConfigPath('relays.access')).toBe(false);
    expect(hasConfigPath('alerts.channels')).toBe(true);
  });
});
