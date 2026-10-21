// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import type { PolicyService } from '@beamhop/policy';
import { makeKey } from '@beamhop/testkit';
import { OWNER, VIEWER, setup } from './helpers.ts';

describe('suggestions inbox', () => {
  test('all clear when nothing needs attention', async () => {
    const { act } = await setup();
    const { output } = await act('experience.inbox', {});
    expect(output.allClear).toBe(true);
    expect(output.cards).toEqual([]);
    expect(output.message).toContain('All clear');
  });

  test('batches by relay + batchKey, dedupes ids, ranks by severity then age', async () => {
    const { act, fixture, card, ports } = await setup({
      config: {
        relays: [
          { id: 'main', hosts: ['a.example.com'] },
          { id: 'other', hosts: ['b.example.com'] },
        ],
      },
    });
    const now = ports.clock.now();
    fixture.cards = [
      card({
        id: 'k1',
        batchKey: 'spam',
        createdAt: now - 100,
        primary: { label: 'Block', actionId: 'fixture.flip', input: { name: 'a' } },
      }),
      card({
        id: 'k2',
        batchKey: 'spam',
        createdAt: now - 50,
        severity: 'warning',
        primary: { label: 'Block', actionId: 'fixture.flip', input: { name: 'b' } },
      }),
      card({ id: 'k2', batchKey: 'spam', createdAt: now - 50 }), // duplicate id
      card({ id: 'k3', batchKey: 'spam', relayId: 'other', createdAt: now - 10 }), // other relay: separate
      card({ id: 'old-info', createdAt: now - 5000 }),
      card({ id: 'crit', severity: 'critical', createdAt: now - 1 }),
    ];
    const { output } = await act('experience.inbox', {});
    const keys = output.cards.map((c: { key: string }) => c.key);
    expect(keys).toEqual(['card:crit', 'batch:main:spam', 'card:old-info', 'batch:other:spam']);
    const spam = output.cards[1];
    expect(spam.count).toBe(2);
    expect(spam.members).toEqual(['k2', 'k1']);
    expect(spam.severity).toBe('warning');
    expect(spam.createdAt).toBe(now - 100);
    expect(spam.primary.inputs).toEqual([{ name: 'b' }, { name: 'a' }]);
    expect(spam.primary.label).toBe('Block (all 2)');
    expect(output.counts).toEqual({ critical: 1, warning: 1, info: 2 });
    expect(output.allClear).toBe(false);
  });

  test('a failing source does not break the inbox', async () => {
    const { act, fixture, card } = await setup();
    fixture.failing = true;
    fixture.cards = [card({ id: 'x' })];
    const { output } = await act('experience.inbox', {});
    expect(output.cards).toHaveLength(1);
    expect(output.failedSources).toEqual(['fixture.broken']);
  });

  test('dismiss hides per admin until the batch grows; undo brings it back', async () => {
    const { act, fixture, card } = await setup();
    fixture.cards = [card({ id: 'a1', batchKey: 'reports' })];
    const d = await act('experience.dismiss-card', { key: 'batch:main:reports' });
    expect(d.preview[0]?.text).toContain('hidden');
    expect((await act('experience.inbox', {})).output.allClear).toBe(true);
    expect((await act('experience.inbox', {})).output.hidden.dismissed).toBe(1);
    // Another admin still sees it.
    const other = { ...OWNER, id: 'owner-2' };
    expect((await act('experience.inbox', {}, { principal: other })).output.cards).toHaveLength(1);
    // Undo.
    await d.undo();
    expect((await act('experience.inbox', {})).output.cards).toHaveLength(1);
    // Dismiss again, then a new member joins → visible again.
    await act('experience.dismiss-card', { key: 'a1' }); // member id works too
    expect((await act('experience.inbox', {})).output.allClear).toBe(true);
    fixture.cards.push(card({ id: 'a2', batchKey: 'reports' }));
    const after = (await act('experience.inbox', {})).output;
    expect(after.cards).toHaveLength(1);
    expect(after.cards[0].count).toBe(2);
  });

  test('snooze hides until the time passes', async () => {
    const { act, fixture, card, ports } = await setup();
    fixture.cards = [card({ id: 's1' })];
    await act('experience.snooze-card', { key: 'card:s1', hours: 2 });
    let inbox = (await act('experience.inbox', {})).output;
    expect(inbox.allClear).toBe(true);
    expect(inbox.hidden.snoozed).toBe(1);
    ports.clock.advance(3600);
    expect((await act('experience.inbox', {})).output.allClear).toBe(true);
    ports.clock.advance(3601);
    inbox = (await act('experience.inbox', {})).output;
    expect(inbox.cards.map((c: { key: string }) => c.key)).toEqual(['card:s1']);
  });

  test('cards from relays the admin cannot see are filtered out', async () => {
    const { act, fixture, card } = await setup();
    fixture.cards = [card({ id: 'm' })];
    const scoped = { id: 'mod', roles: { elsewhere: 'admin' as const }, via: 'cli' as const };
    expect((await act('experience.inbox', {}, { principal: scoped })).output.cards).toEqual([]);
  });
});

describe('approve card', () => {
  test('runs the primary action for every batched member, audited, with one undo', async () => {
    const { act, fixture, card, kernel } = await setup();
    const audit: Array<{ actionId: string; summary: string }> = [];
    kernel.bus.on('admin.action', (e) => audit.push(e));
    fixture.cards = [
      card({
        id: 'f1',
        batchKey: 'b',
        primary: { label: 'Flip', actionId: 'fixture.flip', input: { name: 'x' } },
      }),
      card({
        id: 'f2',
        batchKey: 'b',
        primary: { label: 'Flip', actionId: 'fixture.flip', input: { name: 'y' } },
      }),
    ];
    // Nothing changes until approval.
    await act('experience.inbox', {});
    expect(fixture.flips.size).toBe(0);

    const r = await act('experience.approve-card', { key: 'batch:main:b' });
    expect(r.preview.map((l) => l.text)).toEqual(['flip x', 'flip y']);
    expect(fixture.flips.get('x')).toBe(1);
    expect(fixture.flips.get('y')).toBe(1);
    expect(r.output.runs).toBe(2);
    expect(r.output.outputs[0].relayId).toBe('main');
    expect(audit.filter((a) => a.actionId === 'fixture.flip')).toHaveLength(2);
    expect(r.result.undo?.actionId).toBe('experience.approve-card');
    // Approved card leaves the inbox.
    expect((await act('experience.inbox', {})).output.allClear).toBe(true);

    await r.undo();
    expect(fixture.flips.get('x')).toBe(0);
    expect(fixture.flips.get('y')).toBe(0);
    expect((await act('experience.inbox', {})).output.cards).toHaveLength(1);
  });

  test('uses the admin’s own permissions for the underlying action', async () => {
    const { act, fixture, card } = await setup();
    fixture.cards = [
      card({ id: 'p', primary: { label: 'Flip', actionId: 'fixture.flip', input: { name: 'z' } } }),
    ];
    await expect(
      act('experience.approve-card', { key: 'card:p' }, { principal: VIEWER }),
    ).rejects.toThrow(/permission/);
    expect(fixture.flips.size).toBe(0);
  });

  test('approving a real policy card bans and undo unbans', async () => {
    const { act, fixture, card, kernel } = await setup();
    const spammer = makeKey().pk;
    fixture.cards = [
      card({
        id: 'wave',
        primary: {
          label: 'Block 1 account',
          actionId: 'moderation.ban-pubkey',
          input: { pubkeys: [spammer], reason: 'spam' },
        },
      }),
    ];
    const policy = kernel.use<PolicyService>('policy')!;
    const r = await act('experience.approve-card', { key: 'card:wave' });
    expect(await policy.state.isBanned('main', spammer)).toBe(true);
    await r.undo();
    expect(await policy.state.isBanned('main', spammer)).toBe(false);
  });

  test('a card that disappeared cannot be approved', async () => {
    const { act } = await setup();
    await expect(act('experience.approve-card', { key: 'card:nope' })).rejects.toThrow(/gone/);
  });
});
