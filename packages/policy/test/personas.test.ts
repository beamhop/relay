// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type Persona, PersonaSchema, RelaySchema } from '@beamhop/core';
import { deriveLimits } from '../src/goals.ts';
import {
  applyPersona,
  deepMerge,
  diffRelayConfig,
  personaInfo,
  personaPresets,
} from '../src/personas.ts';

const base = RelaySchema.parse({
  id: 'main',
  hosts: ['relay.example.com'],
  info: { name: 'Mine', pubkey: 'a'.repeat(64) },
  limits: { maxLimit: 42 },
  tiers: [
    { id: 'default', name: 'Default' },
    { id: 'plus', name: 'Plus', eventsPerMinute: 500 },
  ],
});

describe('personas', () => {
  const all = PersonaSchema.options as Persona[];

  test('every persona has a preset and plain info', () => {
    for (const p of all) {
      expect(personaPresets[p]).toBeDefined();
      expect(personaInfo[p].title.length).toBeGreaterThan(3);
      expect(personaPresets[p].persona).toBe(p);
    }
  });

  for (const p of PersonaSchema.options as Persona[]) {
    test(`${p} applies cleanly and keeps identity, tiers and overrides`, () => {
      const next = applyPersona(base, p);
      expect(next.persona).toBe(p);
      expect(next.id).toBe('main');
      expect(next.hosts).toEqual(['relay.example.com']);
      expect(next.info.name).toBe('Mine');
      expect(next.tiers).toEqual(base.tiers);
      expect(next.limits).toEqual({ maxLimit: 42 });
      expect(() => RelaySchema.parse(next)).not.toThrow();
      // idempotent
      expect(diffRelayConfig(next, applyPersona(next, p))).toEqual([]);
    });
  }

  test('private team / organization are members-only with sign-in', () => {
    for (const p of ['private-team', 'organization'] as const) {
      const r = applyPersona(base, p);
      expect(r.access.mode).toBe('allowlist');
      expect(r.access.authRequired).toEqual({ read: true, write: true });
    }
  });

  test('wot community uses web of trust; media host has bigger files', () => {
    expect(applyPersona(base, 'wot-community').access.mode).toBe('wot');
    const media = applyPersona(base, 'media-host');
    const social = applyPersona(base, 'public-social');
    expect(deriveLimits(media).maxBlobBytes).toBeGreaterThan(deriveLimits(social).maxBlobBytes);
    expect(media.blossom.optimize.transcode).toBe(true);
  });

  test('stricter personas derive stricter limits', () => {
    const team = deriveLimits(applyPersona(base, 'private-team'));
    const social = deriveLimits(applyPersona(base, 'public-social'));
    expect(team.newKeyPowDifficulty).toBeGreaterThan(social.newKeyPowDifficulty);
  });

  test('diff lists plain changes with a technical lens', () => {
    const lines = diffRelayConfig(base, applyPersona(base, 'private-team'));
    const mode = lines.find((l) => l.text.startsWith('Who can post'));
    expect(mode?.text).toBe('Who can post: "open" → "allowlist"');
    expect(mode?.technical).toContain('relays[main].access.mode');
    expect(lines.some((l) => l.text.startsWith('Openness'))).toBe(true);
  });

  test('deepMerge merges objects and replaces arrays', () => {
    expect(deepMerge({ a: { b: 1, c: [1, 2] }, d: 1 }, { a: { c: [3] } })).toEqual({
      a: { b: 1, c: [3] },
      d: 1,
    });
  });
});
