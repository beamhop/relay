// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { TIPS } from '../src/index.ts';
import { setup } from './helpers.ts';

describe('alerts.oncall', () => {
  test('no rotation → nobody on duty', async () => {
    const { act } = await setup();
    const r = await act('alerts.oncall', {});
    expect(r.result.output).toMatchObject({ schedule: null, onDuty: null, until: null });
  });

  test('reports who is on duty and until when', async () => {
    const { act, ports } = await setup();
    const startAt = ports.clock.now() - 86400; // started yesterday
    await act('alerts.set-oncall', {
      rotation: [
        { principalId: 'ayse', channels: ['ops'] },
        { principalId: 'bob', channels: ['ops'] },
      ],
      periodDays: 7,
      startAt,
    });
    const r = await act('alerts.oncall', {});
    const out = r.result.output as { onDuty: { principalId: string }; until: number };
    expect(out.onDuty.principalId).toBe('ayse');
    expect(out.until).toBe(startAt + 7 * 86400);
    ports.clock.advance(7 * 86400);
    const later = (await act('alerts.oncall', {})).result.output as typeof out;
    expect(later.onDuty.principalId).toBe('bob');
  });
});

describe('alerts.tips', () => {
  test('lists tips that were not hidden', async () => {
    const { act } = await setup();
    const first = (await act('alerts.tips', {})).result.output as { tips: Array<{ id: string }> };
    expect(first.tips).toHaveLength(TIPS.length);
    const hide = await act('alerts.dismiss-tip', { tipId: 'backups' });
    const after = (await act('alerts.tips', {})).result.output as typeof first;
    expect(after.tips.map((t) => t.id)).not.toContain('backups');
    await hide.undo();
    const back = (await act('alerts.tips', {})).result.output as typeof first;
    expect(back.tips.map((t) => t.id)).toContain('backups');
  });
});
