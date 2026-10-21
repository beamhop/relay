// SPDX-License-Identifier: AGPL-3.0-or-later
/** One-tap update progress state machine (Settings → Updates & health). */
import { describe, expect, it } from 'vitest';
import {
  MISSES_BEFORE_OFFLINE,
  OFFLINE_TIMEOUT_MS,
  canRollback,
  initialState,
  percent,
  pollDelay,
  reduce,
  steps,
} from '../src/lib/components/system/progress';
import type { UpdatePhase, UpdateStatus } from '../src/lib/components/system/types';
import { resolveScreen } from '../src/lib/screens';

const status = (phase: UpdatePhase, over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  phase,
  from: '0.1.0',
  to: '0.2.0',
  updatedAt: 0,
  message: '',
  current: '0.1.0',
  previousVersion: null,
  busy: !['idle', 'done', 'failed', 'rolled-back'].includes(phase),
  ...over,
});

const marks = (s: ReturnType<typeof initialState>) => steps(s).map((x) => x.status);

describe('update progress', () => {
  it('walks through every step to done', () => {
    let s = reduce(initialState(null), { type: 'started', status: status('backing-up') });
    expect(s.stage).toBe('running');
    expect(marks(s)).toEqual(['active', 'pending', 'pending', 'pending', 'pending', 'pending']);
    expect(pollDelay(s)).toBe(1000);

    s = reduce(s, {
      type: 'status',
      status: status('downloading', { progress: { done: 30, total: 120 } }),
      now: 1,
    });
    expect(marks(s).slice(0, 3)).toEqual(['done', 'active', 'pending']);
    expect(percent(s)).toBe(25);

    s = reduce(s, { type: 'status', status: status('installing'), now: 2 });
    expect(percent(s)).toBeUndefined();
    s = reduce(s, { type: 'status', status: status('restarting'), now: 3 });
    expect(marks(s)).toEqual(['done', 'done', 'done', 'done', 'active', 'pending']);

    // The server goes away while it restarts: expected, not an error.
    s = reduce(s, { type: 'poll-failed', now: 10_000 });
    expect(s.stage).toBe('offline');
    expect(pollDelay(s)).toBe(2000);
    expect(marks(s)[4]).toBe('active');

    s = reduce(s, {
      type: 'status',
      status: status('checking', { current: '0.2.0', previousVersion: '0.1.0' }),
      now: 15_000,
    });
    expect(s.stage).toBe('running');
    expect(marks(s)).toEqual(['done', 'done', 'done', 'done', 'done', 'active']);
    expect(canRollback(s)).toBe(false); // not while it runs

    s = reduce(s, {
      type: 'status',
      status: status('done', { current: '0.2.0', previousVersion: '0.1.0' }),
      now: 30_000,
    });
    expect(s.stage).toBe('done');
    expect(marks(s).every((x) => x === 'done')).toBe(true);
    expect(pollDelay(s)).toBeNull();
    expect(canRollback(s)).toBe(true); // offered until the next update
  });

  it('a failure marks the step it reached', () => {
    let s = reduce(initialState(null), { type: 'started', status: status('backing-up') });
    s = reduce(s, { type: 'status', status: status('downloading'), now: 1 });
    s = reduce(s, { type: 'status', status: status('verifying'), now: 2 });
    s = reduce(s, {
      type: 'status',
      status: status('failed', {
        message: 'The download is not signed by Beamhop; nothing was changed.',
      }),
      now: 3,
    });
    expect(s.stage).toBe('failed');
    expect(marks(s)).toEqual(['done', 'done', 'failed', 'pending', 'pending', 'pending']);
    expect(pollDelay(s)).toBeNull();
  });

  it('automatic rollback after an unhealthy start', () => {
    let s = initialState(status('checking', { current: '0.2.0', previousVersion: '0.1.0' }));
    expect(s.stage).toBe('running');
    s = reduce(s, { type: 'poll-failed', now: 0 }); // restarting into the old version
    s = reduce(s, {
      type: 'status',
      status: status('rolled-back', { autoRolledBack: true, previousVersion: null }),
      now: 5000,
    });
    expect(s.stage).toBe('rolled-back');
    expect(marks(s)[5]).toBe('failed');
    expect(canRollback(s)).toBe(false);
  });

  it('a few failed polls mid-download are tolerated; a server gone too long fails', () => {
    let s = reduce(initialState(null), { type: 'started', status: status('downloading') });
    for (let i = 1; i < MISSES_BEFORE_OFFLINE; i++) {
      s = reduce(s, { type: 'poll-failed', now: i });
      expect(s.stage).toBe('running');
    }
    s = reduce(s, { type: 'poll-failed', now: 100 });
    expect(s.stage).toBe('offline');
    s = reduce(s, { type: 'poll-failed', now: 100 + OFFLINE_TIMEOUT_MS + 1 });
    expect(s.stage).toBe('failed');
    expect(s.error).toBe('gone');
  });

  it('idle states ignore failed polls and do not poll', () => {
    const s = initialState(status('idle', { from: undefined, to: undefined }));
    expect(s.stage).toBe('idle');
    expect(reduce(s, { type: 'poll-failed', now: 1 })).toBe(s);
    expect(pollDelay(s)).toBeNull();
    expect(reduce(s, { type: 'reset' }).stage).toBe('idle');
  });
});

describe('screen links', () => {
  it('update, doctor and advisor links land on Updates & health', () => {
    expect(resolveScreen('/settings/system')).toEqual({
      href: '/settings/system',
      fallback: false,
      tab: '/settings',
    });
    expect(resolveScreen('/settings/update').href).toBe('/settings/system');
    expect(resolveScreen('/settings/doctor').href).toBe('/settings/system#doctor');
    expect(resolveScreen('/settings/advisor').href).toBe('/settings/system#advisor');
    expect(resolveScreen('/home/doctor')).toMatchObject({
      href: '/settings/system#doctor',
      fallback: false,
      tab: '/settings',
    });
  });
});
