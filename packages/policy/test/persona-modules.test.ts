// SPDX-License-Identifier: AGPL-3.0-or-later
/** Company / Organization persona proposes company sign-in (and the Team app), nothing more. */
import { describe, expect, test } from 'bun:test';
import { applyPersonaModules, diffPersonaModules } from '../src/personas.ts';

describe('persona module presets', () => {
  test('organization turns on the Team app and company sign-in only', () => {
    const next = applyPersonaModules({}, 'organization');
    expect(next).toEqual({ team: { enabled: true }, 'enterprise-identity': { enabled: true } });
    for (const id of ['enterprise-keyvault', 'enterprise-compliance', 'enterprise-network'])
      expect(next[id]).toBeUndefined();
    const lines = diffPersonaModules({}, 'organization');
    expect(lines.map((l) => l.kind)).toEqual(['add', 'add']);
    expect(lines.some((l) => l.text.startsWith('Company sign-in turns on'))).toBe(true);
  });

  test('keeps existing company sign-in settings and re-enables a switched-off section', () => {
    const idps = [{ id: 'google', type: 'google', clientId: 'x' }];
    const next = applyPersonaModules(
      { 'enterprise-identity': { enabled: false, idps } },
      'organization',
    );
    expect(next['enterprise-identity']).toEqual({ enabled: true, idps });
    expect(
      diffPersonaModules(
        { team: { enabled: true }, 'enterprise-identity': { idps } },
        'organization',
      ),
    ).toEqual([]);
  });

  test('other personas never add optional modules', () => {
    for (const p of ['public-social', 'private-team', 'wot-community', 'media-host'] as const) {
      expect(applyPersonaModules({}, p)).toEqual({});
      expect(diffPersonaModules({}, p)).toEqual([]);
    }
  });
});
