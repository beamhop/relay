// SPDX-License-Identifier: AGPL-3.0-or-later
/** Server-named screens map onto app routes; unknown ones land on the nearest tab. */
import { describe, expect, it } from 'vitest';
import { fromServer } from '../src/lib/checklist.ts';
import { SETTINGS_SECTIONS, nearestTab, resolveScreen } from '../src/lib/screens.ts';
import { SECTIONS } from '../src/lib/settings/sections.ts';

describe('screens', () => {
  it('lists exactly the settings sections the app renders', () => {
    expect([...SETTINGS_SECTIONS].sort()).toEqual(SECTIONS.map((s) => s.id).sort());
  });

  it('keeps known screens and maps aliases', () => {
    expect(resolveScreen('/settings/backups')).toEqual({
      href: '/settings/backups',
      fallback: false,
      tab: '/settings',
    });
    expect(resolveScreen('/people/admins').href).toBe('/people?tab=team');
    expect(resolveScreen('/home/launch-kit').href).toBe('/launch');
    expect(resolveScreen('/home/insights').href).toBe('/insights');
    expect(resolveScreen('/insights').href).toBe('/insights');
    expect(resolveScreen('/activity/moderation').href).toBe('/activity?tab=queue');
    expect(resolveScreen('/settings/goals').fallback).toBe(false);
    expect(resolveScreen('/activity?tab=bin').href).toBe('/activity?tab=bin');
    expect(resolveScreen('/m/plugins/x', ['/plugins/x']).fallback).toBe(false);
  });

  it('sends unknown screens to the nearest tab', () => {
    expect(resolveScreen('/settings/filters')).toEqual({
      href: '/settings',
      fallback: true,
      tab: '/settings',
    });
    expect(resolveScreen('/people/tiers')).toMatchObject({ href: '/people', fallback: true });
    expect(resolveScreen('/nowhere/at/all')).toMatchObject({ href: '/', fallback: true });
    expect(resolveScreen('/m/disabled-module')).toMatchObject({ href: '/', fallback: true });
    expect(resolveScreen('https://evil.example/')).toMatchObject({
      href: '/settings',
      fallback: true,
    });
    expect(resolveScreen('//evil.example')).toMatchObject({ fallback: true });
    expect(nearestTab('/media/quarantine')).toBe('/media');
  });

  it('puts approvals under the Activity tab', () => {
    const routes = [
      { path: '/approvals', placement: 'activity-section' as const },
      { path: '/settings/compliance', placement: 'settings-section' as const },
    ];
    expect(nearestTab('/approvals', routes)).toBe('/activity');
    expect(nearestTab('/approvals/abc123', routes)).toBe('/activity');
    expect(nearestTab('/m/approvals', routes)).toBe('/activity');
    expect(nearestTab('/m/approvals/abc123?x=1', routes)).toBe('/activity');
    expect(nearestTab('/m/approvals-other', routes)).toBe('/');
    expect(nearestTab('/m/settings/compliance', routes)).toBe('/settings');
    expect(nearestTab('/m/settings/network')).toBe('/settings');
    expect(nearestTab('/activity?tab=bin', routes)).toBe('/activity');
  });

  it('marks checklist links that fell back', () => {
    const items = fromServer({
      hidden: false,
      items: [
        { id: 'a', title: 'A', done: false, available: true, link: { screen: '/people/admins' } },
        {
          id: 'b',
          title: 'B',
          done: false,
          available: true,
          link: { screen: '/settings/filters' },
        },
        { id: 'c', title: 'C', done: false, available: false, link: { screen: '/x' } },
      ],
    });
    expect(items.map((i) => [i.href, !!i.fallback])).toEqual([
      ['/people?tab=team', false],
      ['/settings', true],
    ]);
  });
});
