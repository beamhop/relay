// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { defineModule } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import { RejectionRing } from '../src/index.ts';
import { setup } from './helpers.ts';

describe('why?', () => {
  test('explains a refused post with options and a technical lens', async () => {
    const { act, kernel } = await setup({ relay: { goals: { openness: 10 } } });
    const pk = makeKey().pk;
    kernel.bus.emit('event.rejected', {
      relayId: 'main',
      eventId: 'e1',
      pubkey: pk,
      kind: 1,
      reason: 'pow: difficulty 3 is less than 20',
      by: 'policy.pow',
    });
    const { output } = await act('experience.why', { subject: 'rejected-event', eventId: 'e1' });
    expect(output.found).toBe(true);
    expect(output.title).toContain('proof of work');
    expect(output.cause).toContain('puzzle');
    expect(output.cause).not.toContain('NIP');
    const allow = output.options.find(
      (o: { actionId?: string }) => o.actionId === 'access.add-allowlist',
    );
    expect(allow.input).toEqual({ pubkeys: [pk] });
    expect(output.technical[0]).toContain('policy.pow');
    expect(output.technical.join('\n')).toContain('minPowDifficulty');
  });

  test('unknown or expired refusals say so', async () => {
    const { act } = await setup();
    const { output } = await act('experience.why', { subject: 'rejected-event', eventId: 'nope' });
    expect(output.found).toBe(false);
    expect(output.cause).toContain('not in the recent list');
  });

  test('held events are remembered too; ring buffer is bounded', async () => {
    const ring = new RejectionRing(3);
    for (let i = 0; i < 5; i++)
      ring.push({
        relayId: 'main',
        eventId: `e${i}`,
        pubkey: 'p',
        kind: 1,
        reason: 'x',
        at: i,
        decision: 'reject',
      });
    expect(ring.find('e0')).toBeUndefined();
    expect(ring.recent(10).map((r) => r.eventId)).toEqual(['e4', 'e3', 'e2']);

    const { act, kernel } = await setup();
    kernel.bus.emit('event.held', {
      relayId: 'main',
      event: { id: 'h1', pubkey: 'p', kind: 1, tags: [], content: '', created_at: 0, sig: '' },
      by: 'policy.duplicate',
      reason: 'looks like a copy of a recent post',
    });
    const { output } = await act('experience.why', { subject: 'rejected-event', eventId: 'h1' });
    expect(output.title).toContain('Held for review');
    const recent = await act('experience.recent-rejections', {});
    expect(recent.output.items[0].eventId).toBe('h1');
  });

  test('explains a limit from the goals engine', async () => {
    const { act } = await setup();
    const { output } = await act('experience.why', { subject: 'limit', field: 'eventsPerMinute' });
    expect(output.found).toBe(true);
    expect(output.cause).toContain('goal');
    expect(output.technical[0]).toContain('eventsPerMinute');
    expect(output.options.some((o: { screen?: string }) => o.screen === '/settings/goals')).toBe(
      true,
    );
    expect(
      output.options.some(
        (o: { actionId?: string }) => o.actionId === 'experience.simulate-change',
      ),
    ).toBe(true);
    const missing = await act('experience.why', { subject: 'limit', field: 'bogus' });
    expect(missing.output.found).toBe(false);
  });

  test('explains a health subsystem and links a playbook', async () => {
    const disk = defineModule({
      id: 'disk',
      register(k) {
        k.health.push({
          id: 'disk.space',
          subsystem: 'storage',
          weight: 1,
          async run() {
            return {
              score: 20,
              status: 'critical',
              message: 'The disk is 96% full.',
              technical: 'free=4%',
            };
          },
        });
      },
    });
    const { act } = await setup({ modules: [disk] });
    const { output } = await act('experience.why', { subject: 'health', subsystem: 'storage' });
    expect(output.cause).toBe('The disk is 96% full.');
    expect(output.title).toContain('Storage');
    expect(output.options[0].playbook).toBe('disk-full');
    expect(output.technical[0]).toContain('free=4%');
  });

  test('explains a card', async () => {
    const { act, fixture, card } = await setup();
    fixture.cards = [
      card({
        id: 'c1',
        title: '3 reports to review',
        body: 'People reported posts.',
        playbook: 'spam-attack',
        primary: { label: 'Review', actionId: 'fixture.flip', input: { name: 'r' } },
      }),
    ];
    const { output } = await act('experience.why', { subject: 'card', cardId: 'c1' });
    expect(output.cause).toBe('People reported posts.');
    expect(output.options.map((o: { label: string }) => o.label)).toEqual([
      'Review',
      'Step-by-step help',
      'Not now',
      'Dismiss',
    ]);
    expect(output.options[0].actionId).toBe('experience.approve-card');
  });
});
