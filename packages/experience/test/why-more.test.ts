// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { defineModule } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import { METRIC_INFO, formatMetric, metricInfo } from '../src/index.ts';
import { OWNER, setup } from './helpers.ts';

const ALERT = {
  id: 'al-1',
  key: 'spam-wave:main',
  rule: 'spam-wave',
  category: 'ops',
  relayId: 'main',
  severity: 'warning' as const,
  title: 'Spam wave',
  body: 'Many posts were refused in the last few minutes.',
  technical: 'rejectedPerMin z=6.2 (mean 1.1)',
  playbook: 'spam-attack',
  firstAt: 0,
  lastAt: 0,
  count: 3,
};

/** Duck-typed alerts + insights services, as the real modules provide them. */
function fakes(o: { baseline?: boolean } = {}) {
  return defineModule({
    id: 'fakes',
    register(k) {
      const now = k.ports.clock.now();
      k.provide('alerts', {
        engine: {
          rules: [{ id: 'spam-wave', name: 'Spam waves' }],
          async active() {
            return [{ ...ALERT, firstAt: now - 600, lastAt: now - 60 }];
          },
          async history() {
            return [
              {
                ...ALERT,
                id: 'al-old',
                key: 'disk:*',
                rule: 'disk',
                relayId: null,
                title: 'Disk filling up',
                body: 'The disk was 92% full.',
                firstAt: now - 7200,
                lastAt: now - 3600,
                resolvedAt: now - 1800,
                count: 1,
              },
            ];
          },
          baseline(_relayId: string, signal: string) {
            return {
              expected: () =>
                o.baseline && signal === 'connections'
                  ? { mean: 10, std: 2, n: 500, seasonal: true }
                  : { mean: 0, std: 0, n: 0, seasonal: false },
            };
          },
        },
      });
      k.provide('insights', {
        live: () => ({
          at: now,
          relays: [
            {
              relayId: 'main',
              connections: 42,
              eventsPerSecond: 1.5,
              rejectedPerSecond: 0.2,
              acceptRatio: 0.88,
              p50Ms: 3,
              p95Ms: 40,
              errorsPerMinute: 0,
              errorRate: 0,
              blobBytes: 2048,
            },
          ],
          storage: { events: 100, bytes: 1024 * 1024 },
          disk: null,
        }),
      });
    },
  });
}

type Opt = { actionId?: string; playbook?: string; label: string; input?: unknown };

describe('why? — alerts', () => {
  test('explains an active alert with mute, snooze and playbook options', async () => {
    const { act } = await setup({ modules: [fakes()] });
    const { output } = await act('experience.why', { subject: 'alert', alertId: 'al-1' });
    expect(output.found).toBe(true);
    expect(output.title).toBe('Spam wave');
    expect(output.cause).toContain('Many posts were refused');
    expect(output.cause).toContain('3 times');
    const ids = output.options.map((x: Opt) => x.actionId ?? x.playbook);
    expect(ids).toContain('alerts.snooze');
    expect(ids).toContain('alerts.mute');
    expect(ids).toContain('spam-attack');
    const mute = output.options.find((x: Opt) => x.actionId === 'alerts.mute');
    expect(mute.input).toEqual({ rule: 'spam-wave', relayId: 'main' });
    expect(mute.label).toContain('Spam waves');
    expect(output.technical.join('\n')).toContain('z=6.2');
  });

  test('finds alerts by key and in history (resolved: no mute)', async () => {
    const { act } = await setup({ modules: [fakes()] });
    const byKey = await act('experience.why', { subject: 'alert', alertId: 'spam-wave:main' });
    expect(byKey.output.found).toBe(true);
    const old = await act('experience.why', { subject: 'alert', alertId: 'al-old' });
    expect(old.output.found).toBe(true);
    expect(old.output.cause).toContain('cleared');
    expect(old.output.options.some((x: Opt) => x.actionId === 'alerts.mute')).toBe(false);
  });

  test('unknown alert ids and a missing alerts module answer plainly', async () => {
    const { act } = await setup({ modules: [fakes()] });
    const r = await act('experience.why', { subject: 'alert', alertId: 'nope' });
    expect(r.output.found).toBe(false);
    expect(r.output.cause).toContain('no longer on record');
    const bare = await setup();
    const r2 = await bare.act('experience.why', { subject: 'alert', alertId: 'al-1' });
    expect(r2.output.found).toBe(false);
    expect(r2.output.cause).toContain('not turned on');
  });
});

describe('why? — numbers', () => {
  test('every number shown in the app has a plain explanation', () => {
    for (const id of [
      'connections',
      'eventsPerSecond',
      'errorsPerMinute',
      'error-rate',
      'latency.p50',
      'latency.p95',
      'storage.used',
      'storage.hot',
      'storage.cold',
      'db.size',
      'storage.bytes',
      'accept-ratio',
      'active-users.daily',
      'active-users.weekly',
      'active-users.monthly',
      'blobs.bytes',
      'retention',
    ])
      expect(metricInfo(id)).toBeDefined();
    for (const m of METRIC_INFO) {
      expect(m.plain).not.toMatch(/NIP-?\d|kind \d/);
      expect(m.technical.length).toBeGreaterThan(0);
    }
    expect(formatMetric('bytes', 1536)).toBe('1.5 KB');
    expect(formatMetric('ratio', 0.875)).toBe('87.5%');
  });

  test('reads the current value from insights and says what is normal', async () => {
    const { act } = await setup({ modules: [fakes()] });
    const { output } = await act('experience.why', { subject: 'metric', metric: 'connections' });
    expect(output.found).toBe(true);
    expect(output.title).toBe('Connections');
    expect(output.cause).toContain('Right now: 42');
    expect(output.technical.join('\n')).toContain('insights.live()');
    const p95 = await act('experience.why', { subject: 'metric', metric: 'p95Ms' });
    expect(p95.output.cause).toContain('40 ms');
    expect(p95.output.options.some((x: Opt) => x.playbook === 'relay-is-slow')).toBe(true);
    const shown = await act('experience.why', {
      subject: 'metric',
      metric: 'db.size',
      value: 2048,
    });
    expect(shown.output.cause).toContain('2 KB');
  });

  test('uses the learned baseline when there is one', async () => {
    const { act } = await setup({ modules: [fakes({ baseline: true })] });
    const { output } = await act('experience.why', { subject: 'metric', metric: 'connections' });
    expect(output.cause).toContain('Usually about 10');
    expect(output.cause).toContain('at this time of the week');
    expect(output.cause).toContain('higher than usual');
    expect(output.technical.join('\n')).toContain('baseline alerts.connections');
  });

  test('unknown metrics answer plainly', async () => {
    const { act } = await setup();
    const { output } = await act('experience.why', { subject: 'metric', metric: 'flux.capacitor' });
    expect(output.found).toBe(false);
    expect(output.cause).toContain('no explanation');
  });
});

describe('why? — blocked people', () => {
  test('a blocked person: who and when, with unblock', async () => {
    const { act } = await setup();
    const pk = makeKey().pk;
    await act('moderation.ban-pubkey', { pubkeys: [pk], reason: 'spam links' });
    const { output } = await act('experience.why', { subject: 'block', pubkey: pk });
    expect(output.found).toBe(true);
    expect(output.title).toBe('Blocked');
    expect(output.cause).toContain('you blocked them');
    expect(output.cause).toContain('spam links');
    const unban = output.options.find((x: Opt) => x.actionId === 'moderation.unban-pubkey');
    expect(unban.input).toEqual({ pubkeys: [pk] });
    expect(output.technical.join('\n')).toContain(`by=${OWNER.id}`);
  });

  test('a muted person, with unmute', async () => {
    const { act } = await setup();
    const pk = makeKey().pk;
    await act('moderation.mute-pubkey', { pubkeys: [pk] });
    const { output } = await act('experience.why', { subject: 'block', pubkey: pk });
    expect(output.title).toBe('Muted');
    expect(output.options[0].actionId).toBe('moderation.unmute-pubkey');
  });

  test('not a member on a members-only relay, with add-member', async () => {
    const { act } = await setup({ relay: { access: { mode: 'allowlist' } } });
    const pk = makeKey().pk;
    const { output } = await act('experience.why', { subject: 'block', pubkey: pk });
    expect(output.found).toBe(true);
    expect(output.title).toBe('Not allowed to post');
    expect(output.cause).toContain('Only members');
    expect(output.options[0]).toMatchObject({
      actionId: 'access.add-allowlist',
      input: { pubkeys: [pk] },
    });
    expect(output.technical.join('\n')).toContain('policy.allowlist → canWrite=false');
  });

  test('nothing blocking, or not a key, answers plainly', async () => {
    const { act } = await setup();
    const free = await act('experience.why', { subject: 'block', pubkey: makeKey().pk });
    expect(free.output.found).toBe(false);
    expect(free.output.cause).toContain('Nothing is stopping');
    const bad = await act('experience.why', { subject: 'block', pubkey: 'hello' });
    expect(bad.output.found).toBe(false);
  });

  test('mentions their latest refused post when nothing else blocks them', async () => {
    const { act, kernel } = await setup();
    const pk = makeKey().pk;
    kernel.bus.emit('event.rejected', {
      relayId: 'main',
      eventId: 'e9',
      pubkey: pk,
      kind: 1,
      reason: 'rate-limited',
      by: 'policy.rate-limit',
    });
    const { output } = await act('experience.why', { subject: 'block', pubkey: pk });
    expect(output.found).toBe(true);
    expect(output.title).toBe('Post refused');
    expect(output.technical.join('\n')).toContain('policy.rate-limit');
  });
});
