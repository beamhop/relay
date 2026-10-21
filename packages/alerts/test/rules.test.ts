// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import type { Notification } from '@beamhop/core';
import type { MemoryTimeSeries } from '@beamhop/testkit';
import { type AlertRecord, Baseline, hourOfWeek, linearRegression } from '../src/index.ts';
import { setup } from './helpers.ts';

const DISCORD = { type: 'discord', id: 'ops', webhookUrl: 'https://discord.example/hook' };

describe('baselines', () => {
  test('EWMA converges and scores spikes', () => {
    const b = new Baseline();
    let t = 1_700_000_000;
    for (let i = 0; i < 120; i++) {
      b.update(10 + (i % 3), t);
      t += 60;
    }
    const exp = b.expected(t);
    expect(exp.mean).toBeGreaterThan(10);
    expect(exp.mean).toBeLessThan(12);
    expect(b.score(11, t).z).toBeLessThan(1);
    expect(b.score(100, t).z).toBeGreaterThan(10);
  });

  test('hour-of-week seasonality learns a busy hour', () => {
    const b = new Baseline();
    // Monday 2026-10-19 00:00 UTC
    const start = Date.UTC(2026, 9, 19) / 1000;
    expect(hourOfWeek(start)).toBe(0);
    for (let week = 0; week < 3; week++)
      for (let m = 0; m < 7 * 24 * 60; m++) {
        const t = start + week * 7 * 86400 + m * 60;
        const busy = Math.floor(m / 60) % 24 === 20;
        b.update(busy ? 100 : 10, t);
      }
    const at20 = start + 21 * 86400 + 20 * 3600 + 600;
    const at03 = start + 21 * 86400 + 3 * 3600 + 600;
    expect(b.expected(at20).seasonal).toBe(true);
    expect(b.score(100, at20).z).toBeLessThan(b.score(100, at03).z);
    expect(b.expected(at20).mean).toBeGreaterThan(b.expected(at03).mean * 2);
  });

  test('linear regression slope', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({
      t: 1000 + i * 600,
      v: 5000 + i * 600 * 2,
    }));
    const fit = linearRegression(pts)!;
    expect(fit.slope).toBeCloseTo(2, 6);
    expect(fit.r2).toBeCloseTo(1, 6);
    expect(linearRegression([{ t: 1, v: 1 }])).toBeNull();
  });
});

describe('rules engine', () => {
  test('spam wave fires once against warmed baseline, dedupes, resolves', async () => {
    const { minute, calls, ports } = await setup({ config: { alerts: { channels: [DISCORD] } } });
    for (let i = 0; i < 40; i++) await minute(3 + (i % 3));
    expect(calls).toHaveLength(0);
    const fired = await minute(150);
    expect(fired.map((a) => a.rule)).toEqual(['spam-wave']);
    expect(calls).toHaveLength(1);
    const embed = (calls[0]!.json as { embeds: Array<{ title: string; description: string }> })
      .embeds[0]!;
    expect(embed.title).toContain('Spam wave');
    // still spiking: deduped, no new notification
    await minute(160);
    expect(calls).toHaveLength(1);
    const active = await ports.docs.get<AlertRecord>('alerts.active', 'spam-wave:main');
    expect(active?.count).toBe(2);
    expect(active?.playbook).toBe('spam-attack');
    // two quiet minutes resolve it
    await minute(4);
    await minute(4);
    expect(await ports.docs.get('alerts.active', 'spam-wave:main')).toBeNull();
    const hist = await ports.docs.list<AlertRecord>('alerts.history');
    expect(hist.items[0]!.value.resolvedAt).toBeGreaterThan(0);
  });

  test('cold start: no anomaly alerts before warm-up, absolute error threshold still works', async () => {
    const { minute, calls } = await setup({ config: { alerts: { channels: [DISCORD] } } });
    await minute(100); // not warmed, below 10× minimum
    expect(calls).toHaveLength(0);
    const fired = await minute(0, 80);
    expect(fired.map((a) => [a.rule, a.severity])).toEqual([['error-spike', 'critical']]);
    expect(calls).toHaveLength(1);
  });

  test('snooze and mute suppress notifications and cards; undo restores', async () => {
    const { minute, calls, act, kernel } = await setup({
      config: { alerts: { channels: [DISCORD] } },
    });
    const s = await act('alerts.snooze', { rule: 'error-spike', minutes: 30 });
    expect(s.preview[0]!.text).toContain('paused for 30 minutes');
    await minute(0, 80);
    expect(calls).toHaveLength(0);
    const cardSrc = kernel.cards.find((c) => c.id === 'alerts')!;
    expect(await cardSrc.cards('main')).toEqual([]);
    await s.undo();
    await minute(0, 80);
    // already active (first fire was muted) → now notified
    expect(calls).toHaveLength(1);
    const cards = await cardSrc.cards('main');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      severity: 'critical',
      playbook: 'slow-relay',
      primary: { actionId: 'alerts.snooze' },
      secondary: { actionId: 'alerts.mute' },
    });
    const m = await act('alerts.mute', { rule: 'error-spike', allRelays: true });
    expect(await cardSrc.cards('main')).toEqual([]);
    await m.undo();
    expect(await cardSrc.cards('main')).toHaveLength(1);
  });

  test('connection drop vs baseline (relay engine connection count)', async () => {
    let conns = 40;
    const { kernel, minute } = await setup();
    kernel.provide('relay.engine', { connectionCount: () => conns });
    for (let i = 0; i < 35; i++) await minute(0);
    conns = 5;
    let fired = await minute(0);
    expect(fired.map((a) => [a.rule, a.severity])).toEqual([['connection-drop', 'warning']]);
    conns = 0;
    fired = await minute(0);
    expect(fired.map((a) => [a.rule, a.severity])).toEqual([['connection-drop', 'critical']]);
  });

  test('disk fill ETA from storage series and disk provider', async () => {
    const { kernel, ports, rt } = await setup();
    const ts = ports.metrics as MemoryTimeSeries;
    const now = ports.clock.now();
    // growing 1 GB/day; 3 GB free → ~3 days → warning
    for (let i = 0; i < 24; i++)
      ts.points.push({
        metric: 'storage.bytes',
        labels: { relay: '_node' },
        t: now - (24 - i) * 600,
        v: 10e9 + (i * 600 * 1e9) / 86400,
      });
    kernel.provide('runtime.disk', { usage: () => ({ freeBytes: 3e9, totalBytes: 100e9 }) });
    let fired = await rt.evaluate();
    let disk = fired.find((a) => a.rule === 'disk-fill')!;
    expect(disk.severity).toBe('warning');
    expect(disk.body).toMatch(/about 3 days/);
    expect(disk.playbook).toBe('disk-full');
    // nearly full disk → critical immediately
    kernel.provide('runtime.disk', { usage: () => ({ freeBytes: 1e9, totalBytes: 100e9 }) });
    ports.clock.advance(60);
    fired = await rt.evaluate();
    disk = fired.find((a) => a.rule === 'disk-fill')!;
    expect(disk.severity).toBe('critical');
  });

  test('certificate expiry and backup failure', async () => {
    const { kernel, ports, rt } = await setup({ config: { backups: { enabled: true } } });
    kernel.provide('runtime.tls', { certExpiry: () => ports.clock.now() + 10 * 86400 });
    await ports.docs.put('lifecycle.backups', 'last', {
      at: ports.clock.now(),
      ok: false,
      error: 'S3 403',
    });
    const fired = await rt.evaluate();
    const by = Object.fromEntries(fired.map((a) => [a.rule, a]));
    expect(by['cert-expiry']).toMatchObject({ severity: 'warning', playbook: 'cert-problem' });
    expect(by['cert-expiry']!.body).toContain('10 days');
    expect(by.backup).toMatchObject({ severity: 'critical', title: 'Backup failed' });
  });

  test('moderation backlog is a safety alert: notified, no card, never forwarded to onAlert', async () => {
    const { kernel, rt, calls } = await setup({
      config: { alerts: { channels: [DISCORD] } },
    });
    kernel.health.push({
      id: 'policy.moderation-backlog',
      subsystem: 'moderation',
      weight: 1,
      run: async () => ({ score: 20, status: 'critical', message: '120 items waiting for review' }),
    });
    const seen: Array<Notification & { key: string }> = [];
    rt.onAlert((n) => seen.push(n));
    const fired = await rt.evaluate();
    expect(fired.map((a) => a.rule)).toContain('moderation-backlog');
    expect(calls).toHaveLength(1);
    expect(seen).toEqual([]);
    expect(await kernel.cards.find((c) => c.id === 'alerts')!.cards(null)).toEqual([]);
  });

  test('onAlert receives ops alerts only; kernel.notify safety/untagged never forwarded', async () => {
    const { kernel, rt, minute } = await setup();
    const seen: Array<Notification & { key: string; category: string }> = [];
    rt.onAlert((n) => seen.push(n));
    await minute(0, 80);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      key: 'error-spike:main',
      category: 'ops',
      severity: 'critical',
    });
    await kernel.notify({
      severity: 'critical',
      title: 'Abuse match',
      body: 'x',
      category: 'safety',
    });
    await kernel.notify({ severity: 'critical', title: 'Untagged', body: 'x' });
    expect(seen).toHaveLength(1);
    await kernel.notify({ severity: 'critical', title: 'Node down', body: 'x', category: 'ops' });
    expect(seen).toHaveLength(2);
  });

  test('playbooks are registered', async () => {
    const { kernel } = await setup();
    const ids = kernel.playbooks.map((p) => p.id);
    for (const id of ['spam-attack', 'disk-full', 'slow-relay', 'cert-problem'])
      expect(ids).toContain(id);
    for (const p of kernel.playbooks) expect(p.steps.length).toBeGreaterThanOrEqual(3);
  });
});
