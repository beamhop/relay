// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every core setting must explain itself in plain language (§6.6): a description on every
 * leaf, and a plain label for every enum value. The JSON Schema is produced the same way as
 * admin-api's `/config/schema`.
 */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  ConfigSchema,
  FIELD_HELP_KEYWORDS,
  type FieldHelp,
  RelaySchema,
  auditSchemaHelp,
  example,
  fieldHelp,
  labels,
  recommend,
  showWhen,
  technical,
  technicalNote,
} from '../src/index.ts';

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    override(ctx) {
      const help = fieldHelp(ctx.zodSchema as unknown as z.ZodType);
      const out = ctx.jsonSchema as Record<string, unknown>;
      for (const [key, keyword] of Object.entries(FIELD_HELP_KEYWORDS)) {
        const value = help[key as keyof FieldHelp];
        if (value !== undefined) out[keyword] = value;
      }
    },
  }) as Record<string, unknown>;
}

describe('field help helpers', () => {
  test('metadata survives .describe()/.default() and is merged', () => {
    const s = recommend(
      example(labels(technical(z.enum(['a', 'b']), 'raw'), { a: 'Option A', b: 'Option B' }), 'a'),
      'b',
      'B is safer',
    )
      .default('a')
      .describe('Pick one');
    const inner = (s as unknown as { _zod: { def: { innerType: z.ZodType } } })._zod.def.innerType;
    expect(fieldHelp(inner)).toEqual({
      technical: 'raw',
      enumLabels: { a: 'Option A', b: 'Option B' },
      example: 'a',
      recommended: { value: 'b', why: 'B is safer' },
    });
    expect(technicalNote(technical(z.string(), 'n').describe('x'))).toBe('n');
    expect(fieldHelp(showWhen(z.string(), { path: 'driver', equals: 's3' }))).toEqual({
      showWhen: { path: 'driver', equals: ['s3'] },
    });
  });

  test('JSON Schema carries the x-* keywords', () => {
    const js = jsonSchema(
      z.object({
        driver: labels(z.enum(['fs', 's3']), { fs: 'Disk', s3: 'S3' })
          .default('fs')
          .describe('Where'),
        bucket: showWhen(example(z.string(), 'my-bucket'), { path: 'driver', equals: ['s3'] })
          .optional()
          .describe('Bucket'),
      }),
    );
    const props = js.properties as Record<string, Record<string, unknown>>;
    expect(props.driver?.['x-enumLabels']).toEqual({ fs: 'Disk', s3: 'S3' });
    expect(props.bucket?.['x-showWhen']).toEqual({ path: 'driver', equals: ['s3'] });
    expect(props.bucket?.['x-example']).toBe('my-bucket');
  });

  test('the auditor finds missing descriptions and labels', () => {
    const js = jsonSchema(
      z.object({ a: z.string(), b: z.enum(['x', 'y']).describe('B'), c: z.literal(1) }),
    );
    expect(auditSchemaHelp(js)).toEqual(['a: missing description', 'b: no x-enumLabels for x, y']);
  });
});

describe('core settings help', () => {
  test('every core setting has a description and every enum has labels', () => {
    // `modules.<id>` sections are audited per module (admin-api config-help test).
    expect(auditSchemaHelp(jsonSchema(ConfigSchema), { skip: ['modules'] })).toEqual([]);
    expect(auditSchemaHelp(jsonSchema(RelaySchema))).toEqual([]);
  });

  test('storage drivers have plain labels and conditional fields', () => {
    const js = jsonSchema(ConfigSchema) as {
      properties: Record<string, { properties: Record<string, Record<string, unknown>> }>;
    };
    const blob = js.properties.blobStorage!.properties;
    expect(blob.driver?.['x-enumLabels']).toMatchObject({ fs: "This server's disk" });
    expect(blob.bucket?.['x-showWhen']).toEqual({ path: 'driver', equals: ['s3', 'r2', 'gcs'] });
    expect(blob.path?.['x-showWhen']).toEqual({ path: 'driver', equals: ['fs'] });
  });
});
