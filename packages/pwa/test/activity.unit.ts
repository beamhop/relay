// SPDX-License-Identifier: AGPL-3.0-or-later
/** Activity tab logic: bulk plans, selection, alerts mute state, log helpers, on-call turns, notes. */
import { describe, expect, it } from 'vitest';
import {
  LOG_RANGES,
  fieldLines,
  mergeLogs,
  muteFor,
  sinceFor,
  unmuteInput,
} from '../src/lib/components/activity/alerts.ts';
import {
  BULK_MAX,
  isApprovalPending,
  pickFromLive,
  planBulk,
  selectRange,
} from '../src/lib/components/activity/bulk.ts';
import {
  assign,
  currentPeriod,
  toSchedule,
  upcoming,
  weekStart,
} from '../src/lib/components/activity/oncall.ts';
import { countNotes, serverSubject, subjectKey } from '../src/lib/components/notes/notes.svelte.ts';

const E1 = '1'.repeat(64);
const E2 = '2'.repeat(64);
const PK = 'b'.repeat(64);

describe('bulk plans', () => {
  it('keep runs one bulk input per queue item', () => {
    const p = planBulk('keep', [{ itemId: 'q1' }, { itemId: 'q2' }, { eventId: E1 }]);
    expect(p.actionId).toBe('moderation.keep');
    expect(p.inputs).toEqual([{ itemIds: ['q1'] }, { itemIds: ['q2'] }]);
    expect(p.previewInput).toEqual({ itemIds: ['q1', 'q2'] });
    expect(p.skipped).toBe(1);
  });

  it('remove is one moderation.bulk-delete run with unique event ids, capped at 500', () => {
    const p = planBulk('remove', [
      { eventId: E1 },
      { eventId: E1 },
      { eventId: E2 },
      { itemId: 'blob' },
    ]);
    expect(p.actionId).toBe('moderation.bulk-delete');
    expect(p.inputs).toBeUndefined();
    expect(p.previewInput).toEqual({ eventIds: [E1, E2] });
    expect(p.skipped).toBe(1);
    const many = Array.from({ length: 600 }, (_, i) => ({
      eventId: i.toString(16).padStart(64, '0'),
    }));
    const capped = planBulk('remove', many);
    expect((capped.previewInput.eventIds as string[]).length).toBe(BULK_MAX);
    expect(capped.skipped).toBe(100);
  });

  it('ban blocks each author once', () => {
    const p = planBulk('ban', [{ pubkey: PK }, { pubkey: PK }, { pubkey: 'not-hex' }]);
    expect(p.inputs).toEqual([{ pubkeys: [PK] }]);
    expect(p.count).toBe(1);
    expect(p.skipped).toBe(1);
  });

  it('recognizes the two-person rule answer', () => {
    expect(isApprovalPending({ status: 'approval-required', requestId: 'r1' })).toBe(true);
    expect(isApprovalPending({ removed: 2, notFound: 0 })).toBe(false);
    expect(isApprovalPending(null)).toBe(false);
  });

  it('turns stream rows into picks (posts only)', () => {
    expect(pickFromLive('event.held', { event: { id: E1, pubkey: PK } })).toEqual({
      eventId: E1,
      pubkey: PK,
    });
    expect(pickFromLive('event.rejected', { eventId: E2, pubkey: PK })).toEqual({
      eventId: E2,
      pubkey: PK,
    });
    expect(pickFromLive('blob.uploaded', { sha256: E1 })).toBeNull();
  });
});

describe('selection', () => {
  const order = ['a', 'b', 'c', 'd'];
  it('toggles one item', () => {
    const s = selectRange(new Set(['a']), order, null, 'a', false);
    expect([...s]).toEqual([]);
  });
  it('shift-click selects a range from the anchor', () => {
    const s = selectRange(new Set(['b']), order, 'b', 'd', true);
    expect([...s].sort()).toEqual(['b', 'c', 'd']);
    const back = selectRange(new Set(), order, 'c', 'a', true);
    expect([...back].sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('alert mutes', () => {
  const now = 1000;
  const mutes = [
    { rule: 'spam-wave', relayId: 'main', until: null },
    { rule: 'disk', relayId: '*all' as const, until: 2000 },
    { rule: 'old', relayId: 'main', until: 500 },
  ];
  it('finds the mute for an alert', () => {
    expect(muteFor(mutes, 'spam-wave', 'main', now)?.until).toBeNull();
    expect(muteFor(mutes, 'spam-wave', 'other', now)).toBeUndefined();
    expect(muteFor(mutes, 'disk', null, now)?.until).toBe(2000);
    expect(muteFor(mutes, 'old', 'main', now)).toBeUndefined();
  });
  it('unmutes exactly that mute', () => {
    expect(unmuteInput(mutes[0]!)).toEqual({ rule: 'spam-wave', relayId: 'main' });
    expect(unmuteInput(mutes[1]!)).toEqual({ rule: 'disk', allRelays: true });
  });
});

describe('log helpers', () => {
  it('computes the time range', () => {
    expect(sinceFor('1h', 10_000_000)).toBe(10_000_000 - 3_600_000);
    expect(sinceFor('all', 10_000_000)).toBeUndefined();
    expect(LOG_RANGES.map((r) => r.id)).toEqual(['15m', '1h', '24h', 'all']);
  });
  it('renders fields as lens lines', () => {
    expect(fieldLines({ a: 'x', n: 2, o: { k: 1 } })).toEqual(['a: x', 'n: 2', 'o: {"k":1}']);
  });
  it('merges polled lines without duplicates, newest first', () => {
    const a = { at: 1, source: 's', message: 'one' };
    const b = { at: 2, source: 's', message: 'two' };
    const c = { at: 3, source: 's', message: 'three' };
    expect(mergeLogs([b, a], [c, b]).map((r) => r.message)).toEqual(['three', 'two', 'one']);
    expect(mergeLogs([b, a], [c], 2)).toHaveLength(2);
  });
});

describe('on-call turns', () => {
  const DAY = 86400;
  const sched = {
    startAt: 1_000_000,
    periodDays: 7,
    rotation: [
      { principalId: 'ayse', channels: ['ops'] },
      { principalId: 'bob', channels: ['ops'] },
      { principalId: 'cem', channels: ['push'] },
    ],
  };

  it('lists turns starting with the one on duty now', () => {
    const now = sched.startAt + 8 * DAY; // second week → bob
    expect(currentPeriod(sched, now)).toBe(1);
    const list = upcoming(sched, now);
    expect(list.map((s) => s.turn.principalId)).toEqual(['bob', 'cem', 'ayse']);
    expect(list[0]?.start).toBe(sched.startAt + 7 * DAY);
    expect(list[1]?.start).toBe(sched.startAt + 14 * DAY);
    expect(upcoming(null, now)).toEqual([]);
  });

  it('saves the displayed order with the current turn keeping its start', () => {
    const now = sched.startAt + 8 * DAY;
    const turns = upcoming(sched, now).map((s) => s.turn);
    const next = toSchedule(turns, 7, now, sched);
    expect(next.startAt).toBe(sched.startAt + 7 * DAY);
    expect(upcoming(next, now).map((s) => s.turn.principalId)).toEqual(['bob', 'cem', 'ayse']);
  });

  it('a new period starts this Monday (weekly) or today (daily)', () => {
    const now = Math.floor(new Date(2026, 9, 21, 15, 0).getTime() / 1000); // a Wednesday
    const monday = weekStart(now);
    expect(new Date(monday * 1000).getDay()).toBe(1);
    expect(now - monday).toBeLessThan(7 * DAY);
    const t = [{ principalId: 'ayse', channels: ['ops'] }];
    expect(toSchedule(t, 7, now, null).startAt).toBe(monday);
    const daily = toSchedule(t, 1, now, sched);
    expect(new Date(daily.startAt * 1000).getHours()).toBe(0);
  });

  it('assigns a person to a turn, keeping their channels', () => {
    const out = assign(sched.rotation, 0, 'cem', ['ops']);
    expect(out[0]).toEqual({ principalId: 'cem', channels: ['push'] });
    expect(assign(sched.rotation, 1, 'dan', ['ops'])[1]).toEqual({
      principalId: 'dan',
      channels: ['ops'],
    });
  });
});

describe('notes', () => {
  it('counts notes per subject and maps people to the server name', () => {
    expect(serverSubject({ type: 'pubkey', id: PK })).toEqual({ type: 'user', id: PK });
    expect(subjectKey({ type: 'pubkey', id: PK })).toBe(`user|${PK}`);
    const counts = countNotes([
      {
        id: '1',
        relayId: 'main',
        subject: { type: 'event', id: E1 },
        text: 'a',
        author: 'x',
        at: 1,
      },
      {
        id: '2',
        relayId: 'main',
        subject: { type: 'event', id: E1 },
        text: 'b',
        author: 'x',
        at: 2,
      },
      {
        id: '3',
        relayId: 'main',
        subject: { type: 'user', id: PK },
        text: 'c',
        author: 'x',
        at: 3,
      },
    ]);
    expect(counts).toEqual({ [`event|${E1}`]: 2, [`user|${PK}`]: 1 });
  });
});
