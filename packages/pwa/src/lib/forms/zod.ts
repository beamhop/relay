// SPDX-License-Identifier: AGPL-3.0-or-later
/** Build a zod object schema from generated field specs (drives superforms validation). */
import { z } from 'zod';
import { type FieldSpec, getIn, setIn } from './json-schema.ts';

/** Form key for a field: dotted paths are flattened (`info.name` → `info__name`). */
export function formKey(f: FieldSpec): string {
  return f.path.join('__');
}

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

/** Turn flat form values back into the nested input object (empty optional values dropped). */
export function unflatten(
  values: Record<string, unknown>,
  fields: FieldSpec[],
): Record<string, unknown> {
  let out: Record<string, unknown> = {};
  for (const f of leaves(fields)) {
    const v = values[formKey(f)];
    if (v === undefined || (v === '' && !f.required)) continue;
    out = setIn(out, f.path, v);
  }
  return out;
}

/** Flatten a nested value object into form values keyed by `formKey`. */
export function flatten(value: unknown, fields: FieldSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of leaves(fields)) {
    const v = getIn(value, f.path);
    if (v !== undefined) out[formKey(f)] = v;
  }
  return out;
}

/** Schema defaults keyed by `formKey` (pre-fill for generated forms). */
export function formDefaults(fields: FieldSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of leaves(fields)) if (f.default !== undefined) out[formKey(f)] = f.default;
  return out;
}

/** Leaves of a field tree (objects expanded). */
export function leaves(fields: FieldSpec[]): FieldSpec[] {
  const out: FieldSpec[] = [];
  for (const f of fields) {
    if (f.kind === 'object' && f.children) out.push(...leaves(f.children));
    else out.push(f);
  }
  return out;
}
