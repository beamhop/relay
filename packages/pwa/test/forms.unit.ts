// SPDX-License-Identifier: AGPL-3.0-or-later
import { ConfigSchema, RelaySchema } from '@beamhop/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { JsonSchema } from '../src/lib/api/types.ts';
import {
  buildPatch,
  coerce,
  defaultsFor,
  fieldAt,
  fieldsFromSchema,
  labelFromKey,
  validate,
} from '../src/lib/forms/json-schema.ts';
import { flatten, formKey, unflatten, zodForFields } from '../src/lib/forms/zod.ts';

const relaySchema = z.toJSONSchema(RelaySchema, {
  io: 'input',
  unrepresentable: 'any',
}) as JsonSchema;
const nodeSchema = z.toJSONSchema(ConfigSchema, {
  io: 'input',
  unrepresentable: 'any',
}) as JsonSchema;

// The same shape the admin API publishes for an action input (zod → JSON Schema).
const banInput = z.toJSONSchema(
  z.object({
    pubkeys: z.array(z.string().regex(/^[0-9a-f]{64}$/)).min(1),
    reason: z.string().max(500).optional().describe('Why (kept in the audit log)'),
    removeRecent: z.boolean().default(false),
    hours: z.number().int().positive().max(8760).optional(),
    role: z.enum(['owner', 'admin', 'moderator', 'viewer']).describe('What they may do'),
    tier: z.string().nullable(),
  }),
  { io: 'input' },
) as JsonSchema;

describe('form generation from JSON Schema', () => {
  it('maps action inputs to fields with kinds, bounds, defaults and help', () => {
    const fields = fieldsFromSchema(banInput);
    const by = Object.fromEntries(fields.map((f) => [f.name, f]));
    expect(by.pubkeys?.kind).toBe('list');
    expect(by.pubkeys?.required).toBe(true);
    expect(by.reason?.kind).toBe('text');
    expect(by.reason?.help).toBe('Why (kept in the audit log)');
    expect(by.removeRecent?.kind).toBe('boolean');
    expect(by.removeRecent?.default).toBe(false);
    expect(by.hours).toMatchObject({ kind: 'integer', min: 1, max: 8760, required: false });
    expect(by.role?.kind).toBe('enum');
    expect(by.role?.label).toBe('What they may do');
    expect(by.role?.options?.map((o) => o.value)).toEqual([
      'owner',
      'admin',
      'moderator',
      'viewer',
    ]);
    expect(by.tier?.nullable).toBe(true);
    expect(defaultsFor(fields)).toEqual({ removeRecent: false });
  });

  it('resolves nested config paths in the real relay and node schemas', () => {
    const mode = fieldAt(relaySchema, ['access', 'mode']);
    expect(mode?.kind).toBe('enum');
    expect(mode?.label).toBe('Who can post');
    expect(mode?.technical).toContain('access.mode');
    const depth = fieldAt(relaySchema, ['access', 'wot', 'depth']);
    expect(depth).toMatchObject({ kind: 'integer', min: 1, max: 3, default: 2 });
    const hosts = fieldAt(nodeSchema, ['relays', '0', 'hosts']);
    expect(hosts?.kind).toBe('list');
    expect(fieldAt(nodeSchema, ['backups', 'schedule'])?.options?.length).toBe(3);
    expect(fieldAt(relaySchema, ['does', 'not', 'exist'])).toBeUndefined();
  });

  it('marks secrets so they render masked', () => {
    expect(fieldAt(nodeSchema, ['ai', 'apiKey'])?.secret).toBe(true);
    expect(fieldAt(nodeSchema, ['ai', 'model'])?.secret).toBe(false);
  });

  it('coerces and validates raw input values', () => {
    const [hours] = fieldsFromSchema(banInput).filter((f) => f.name === 'hours');
    expect(coerce(hours!, '12')).toBe(12);
    expect(coerce(hours!, '')).toBeUndefined();
    expect(validate(hours!, 0)).toBe('At least 1');
    expect(validate(hours!, 1.5)).toBe('Enter a whole number');
    expect(validate(hours!, 24)).toBeNull();
    const [list] = fieldsFromSchema(banInput).filter((f) => f.name === 'pubkeys');
    expect(coerce(list!, 'a, b\nc')).toEqual(['a', 'b', 'c']);
    expect(labelFromKey('maxBlobBytes')).toBe('Max blob bytes');
  });

  it('builds a zod schema that validates the generated form (superforms)', () => {
    const fields = fieldsFromSchema(banInput);
    const schema = zodForFields(fields);
    expect(schema.safeParse({ pubkeys: ['a'], role: 'admin', tier: null }).success).toBe(true);
    expect(schema.safeParse({ pubkeys: ['a'], role: 'boss', tier: null }).success).toBe(false);
    expect(schema.safeParse({ pubkeys: ['a'], role: 'admin', tier: null, hours: 0 }).success).toBe(
      false,
    );
  });

  it('flattens nested values to form keys and back', () => {
    const fields = [
      fieldAt(relaySchema, ['info', 'name'])!,
      fieldAt(relaySchema, ['access', 'wot', 'depth'])!,
    ];
    expect(fields.map(formKey)).toEqual(['info__name', 'access__wot__depth']);
    const flat = flatten({ info: { name: 'R' }, access: { wot: { depth: 2 } } }, fields);
    expect(flat).toEqual({ info__name: 'R', access__wot__depth: 2 });
    expect(unflatten({ ...flat, info__name: 'S' }, fields)).toEqual({
      info: { name: 'S' },
      access: { wot: { depth: 2 } },
    });
  });

  it('builds minimal JSON Patches, creating missing parents', () => {
    const doc = { info: { name: 'A', description: '' }, backups: { enabled: false } };
    expect(buildPatch(doc, [{ path: ['info', 'name'], value: 'A' }])).toEqual([]);
    expect(buildPatch(doc, [{ path: ['info', 'name'], value: 'B' }])).toEqual([
      { op: 'add', path: '/info/name', value: 'B' },
    ]);
    expect(buildPatch(doc, [{ path: ['backups', 'target', 'bucket'], value: 'b' }])).toEqual([
      { op: 'add', path: '/backups/target', value: { bucket: 'b' } },
    ]);
    expect(buildPatch(doc, [{ path: ['info', 'description'], value: undefined }])).toEqual([
      { op: 'remove', path: '/info/description' },
    ]);
  });
});
