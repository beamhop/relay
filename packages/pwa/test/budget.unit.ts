import { checkComplexityBudget } from '$screens';
// SPDX-License-Identifier: AGPL-3.0-or-later
/** Complexity budget (§6.6): ≤ 7 settings per simple screen, every setting exists. */
import { ConfigSchema, RelaySchema } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { JsonSchema } from '../src/lib/api/types.ts';
import { fieldAt } from '../src/lib/forms/json-schema.ts';
import {
  ALL_SIMPLE_SCREENS,
  SECTIONS,
  SIMPLE_BUDGET,
  resolvePath,
} from '../src/lib/settings/sections.ts';

const relay = z.toJSONSchema(RelaySchema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
const node = z.toJSONSchema(ConfigSchema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;

describe('complexity budget', () => {
  it('every simple screen has at most 7 settings', () => {
    expect(SIMPLE_BUDGET).toBe(7);
    for (const s of ALL_SIMPLE_SCREENS)
      expect(s.settings.length, s.id).toBeLessThanOrEqual(SIMPLE_BUDGET);
    for (const s of SECTIONS) expect(s.simple.length, s.id).toBeLessThanOrEqual(SIMPLE_BUDGET);
  });

  it('agrees with the shared definition in @beamhop/experience', () => {
    expect(checkComplexityBudget(ALL_SIMPLE_SCREENS)).toEqual([]);
  });

  it('every simple and advanced setting resolves to a form field', () => {
    for (const s of SECTIONS) {
      const schema = s.scope === 'relay' ? relay : node;
      for (const p of [...s.simple, ...s.advanced]) {
        const f = fieldAt(schema, resolvePath(p, 0));
        expect(f, `${s.id}: ${p}`).toBeDefined();
        expect(f?.kind, `${s.id}: ${p}`).not.toBe('object');
      }
    }
  });
});
