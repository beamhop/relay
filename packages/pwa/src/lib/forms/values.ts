// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Form value helpers for generated forms (no zod, so screens that only
 * shape values do not pull the validation library into their chunk).
 */
import { type FieldSpec, getIn, setIn } from './json-schema.ts';

/** Form key for a field: dotted paths are flattened (`info.name` → `info__name`). */
export function formKey(f: FieldSpec): string {
  return f.path.join('__');
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
