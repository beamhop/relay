// SPDX-License-Identifier: AGPL-3.0-or-later
/** Build a zod object schema from generated field specs (drives superforms validation). */
import { z } from 'zod';
import type { FieldSpec } from './json-schema.ts';
import { formKey } from './values.ts';

export { flatten, formDefaults, formKey, leaves, unflatten } from './values.ts';

function base(f: FieldSpec): z.ZodType {
  switch (f.kind) {
    case 'boolean':
      return z.boolean();
    case 'integer':
    case 'number': {
      let n = f.kind === 'integer' ? z.number().int('Enter a whole number') : z.number();
      if (f.min !== undefined) n = n.min(f.min, `At least ${f.min}`);
      if (f.max !== undefined) n = n.max(f.max, `At most ${f.max}`);
      return n;
    }
    case 'enum': {
      const values = (f.options ?? []).map((o) => o.value);
      return values.length ? z.enum(values as [string, ...string[]]) : z.string();
    }
    case 'text':
    case 'textarea': {
      let s = z.string();
      if (f.pattern) s = s.regex(new RegExp(f.pattern), 'This format is not valid');
      if (f.format === 'uri' || f.format === 'url')
        return z.union([z.url('Enter a full web address (https://…)'), z.literal('')]);
      if (f.format === 'email') return z.union([z.email('Enter an email address'), z.literal('')]);
      return s;
    }
    case 'list':
      return z.array(f.itemKind === 'number' ? z.number() : z.string());
    default:
      return z.unknown();
  }
}

export function zodForField(f: FieldSpec): z.ZodType {
  let s = base(f);
  if (f.nullable) s = s.nullable();
  if (!f.required || f.default !== undefined) s = s.optional();
  if (f.help) s = s.describe(f.help);
  return s;
}

/** Flat object schema keyed by `formKey` (nested objects are expanded into their leaves). */
export function zodForFields(fields: FieldSpec[]): z.ZodObject<Record<string, z.ZodType>> {
  const shape: Record<string, z.ZodType> = {};
  const walk = (fs: FieldSpec[]) => {
    for (const f of fs) {
      if (f.kind === 'object' && f.children) walk(f.children);
      else shape[formKey(f)] = zodForField(f);
    }
  };
  walk(fields);
  return z.object(shape);
}
