// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Form generation from JSON Schema (the admin API publishes zod schemas as
 * JSON Schema: `/config/schema` and every action's `inputSchema`). Pure
 * functions: schema → field specs, value coercion, JSON Patch building.
 */
import type { JsonSchema } from '../api/types.ts';

export type FieldKind =
  | 'boolean'
  | 'integer'
  | 'number'
  | 'enum'
  | 'text'
  | 'textarea'
  | 'list'
  | 'object'
  | 'json';

export interface FieldSpec {
  /** Last path segment. */
  name: string;
  /** Path from the schema root. */
  path: string[];
  /** Short plain label. */
  label: string;
  /** Plain explanation (the zod `.describe()` text) for the ⓘ sheet. */
  help?: string;
  kind: FieldKind;
  required: boolean;
  nullable: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  options?: Array<{ value: string; label: string }>;
  /** For lists: the item type. */
  itemKind?: 'text' | 'number';
  /** Looks like a secret (password, token, key) → masked input. */
  secret: boolean;
  /** Raw schema facts for the technical lens. */
  technical: string;
  pattern?: string;
  format?: string;
  children?: FieldSpec[];
}

const SECRET = /secret|password|apikey|api_key|privatekey|nsec|token|webhookurl|smtpurl/i;
const SAFE_INT = 9007199254740991;

/** `maxBlobBytes` → "Max blob bytes". */
export function labelFromKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Resolve a local `$ref` (`#/$defs/x`, `#/definitions/x`). */
export function deref(schema: JsonSchema | undefined, root: JsonSchema): JsonSchema | undefined {
  let s = schema;
  for (let i = 0; s?.$ref && i < 10; i++) {
    const ref = s.$ref;
    if (!ref.startsWith('#/')) return s;
    let cur: unknown = root;
    for (const part of ref.slice(2).split('/')) {
      cur = (cur as Record<string, unknown> | undefined)?.[
        part.replace(/~1/g, '/').replace(/~0/g, '~')
      ];
    }
    s = cur as JsonSchema | undefined;
  }
  return s;
}

/** Split `anyOf: [X, {type: 'null'}]` into X + nullable. */
export function unwrapNullable(
  schema: JsonSchema,
  root: JsonSchema,
): { schema: JsonSchema; nullable: boolean } {
  const s = deref(schema, root) ?? {};
  const alts = s.anyOf ?? s.oneOf;
  if (alts && alts.length === 2) {
    const nonNull = alts.filter((a) => deref(a, root)?.type !== 'null');
    if (nonNull.length === 1) {
      const inner = deref(nonNull[0], root) ?? {};
      return {
        schema: {
          ...inner,
          description: s.description ?? inner.description,
          default: s.default ?? inner.default,
        },
        nullable: true,
      };
    }
  }
  if (Array.isArray(s.type) && s.type.includes('null')) {
    const types = s.type.filter((t) => t !== 'null');
    return { schema: { ...s, type: types.length === 1 ? types[0] : types }, nullable: true };
  }
  return { schema: s, nullable: false };
}

function typeOf(s: JsonSchema): string | undefined {
  if (Array.isArray(s.type)) return s.type[0];
  if (s.type) return s.type;
  if (s.enum) return 'enum';
  if (s.const !== undefined) return 'const';
  if (s.properties) return 'object';
  return undefined;
}

function bounds(s: JsonSchema): { min?: number; max?: number } {
  const out: { min?: number; max?: number } = {};
  const min =
    s.minimum ??
    (s.exclusiveMinimum !== undefined
      ? s.exclusiveMinimum + (s.type === 'integer' ? 1 : 0)
      : undefined);
  const max =
    s.maximum ??
    (s.exclusiveMaximum !== undefined
      ? s.exclusiveMaximum - (s.type === 'integer' ? 1 : 0)
      : undefined);
  if (min !== undefined && Math.abs(min) < SAFE_INT) out.min = min;
  if (max !== undefined && Math.abs(max) < SAFE_INT) out.max = max;
  return out;
}

function technicalOf(path: string[], s: JsonSchema, kind: FieldKind): string {
  const parts = [path.join('.') || '(root)', String(s.type ?? kind)];
  const b = bounds(s);
  if (b.min !== undefined || b.max !== undefined) parts.push(`${b.min ?? '−∞'}…${b.max ?? '∞'}`);
  if (s.enum) parts.push(`one of ${s.enum.map(String).join(' | ')}`);
  if (s.default !== undefined) parts.push(`default ${JSON.stringify(s.default)}`);
  if (s.pattern) parts.push(`/${s.pattern}/`);
  return parts.join(' · ');
}

/** Short label: the description when it is short, otherwise the humanized key. */
function labelFor(key: string, description: string | undefined): string {
  if (description && description.length <= 48 && !description.includes('. ')) return description;
  return labelFromKey(key);
}

/** One field spec for a schema node. */
export function fieldFromSchema(
  key: string,
  path: string[],
  raw: JsonSchema,
  root: JsonSchema,
  required: boolean,
): FieldSpec {
  const { schema: s, nullable } = unwrapNullable(raw, root);
  const t = typeOf(s);
  let kind: FieldKind;
  const field: Partial<FieldSpec> = {};
  if (s.enum?.every((v) => typeof v === 'string')) {
    kind = 'enum';
    field.options = (s.enum as string[]).map((v) => ({ value: v, label: labelFromKey(v) }));
  } else if (t === 'boolean') kind = 'boolean';
  else if (t === 'integer') kind = 'integer';
  else if (t === 'number') kind = 'number';
  else if (t === 'string')
    kind = (s.maxLength ?? 0) > 500 || /rules|description/i.test(key) ? 'textarea' : 'text';
  else if (t === 'array') {
    const item = unwrapNullable(s.items ?? {}, root).schema;
    const it = typeOf(item);
    if (it === 'string') {
      kind = 'list';
      field.itemKind = 'text';
    } else if (it === 'integer' || it === 'number') {
      kind = 'list';
      field.itemKind = 'number';
    } else kind = 'json';
  } else if (t === 'object' && s.properties) kind = 'object';
  else kind = 'json';

  const description = s.description ?? raw.description;
  const spec: FieldSpec = {
    name: key,
    path,
    label: labelFor(key, description),
    kind,
    required,
    nullable,
    secret: SECRET.test(key),
    technical: technicalOf(path, s, kind),
    ...field,
    ...bounds(s),
  };
  if (description && spec.label !== description) spec.help = description;
  else if (description) spec.help = description;
  if (s.default !== undefined) spec.default = s.default;
  if (s.pattern) spec.pattern = s.pattern;
  if (s.format) spec.format = s.format;
  if (kind === 'object') spec.children = fieldsFromSchema(s, { root, base: path });
  return spec;
}

/** Field specs for every property of an object schema (recursively for nested objects). */
export function fieldsFromSchema(
  schema: JsonSchema,
  opts: { root?: JsonSchema; base?: string[] } = {},
): FieldSpec[] {
  const root = opts.root ?? schema;
  const s = unwrapNullable(schema, root).schema;
  const props = s.properties ?? {};
  const req = new Set(s.required ?? []);
  return Object.entries(props).map(([k, v]) =>
    fieldFromSchema(k, [...(opts.base ?? []), k], v, root, req.has(k)),
  );
}

/** The schema node at `path` (object properties and array items). */
export function schemaAt(schema: JsonSchema, path: string[]): JsonSchema | undefined {
  let cur: JsonSchema | undefined = schema;
  for (const seg of path) {
    if (!cur) return undefined;
    const s: JsonSchema = unwrapNullable(cur, schema).schema;
    if (s.properties && seg in s.properties) cur = s.properties[seg];
    else if (s.items && /^\d+$/.test(seg)) cur = s.items;
    else return undefined;
  }
  return cur ? deref(cur, schema) : undefined;
}

/** Field spec for one dotted path in a schema (used by settings sections). */
export function fieldAt(schema: JsonSchema, path: string[]): FieldSpec | undefined {
  const node = schemaAt(schema, path);
  if (!node) return undefined;
  const parent = path.length > 1 ? schemaAt(schema, path.slice(0, -1)) : schema;
  const parentS = parent ? unwrapNullable(parent, schema).schema : undefined;
  const key = path[path.length - 1] ?? '';
  return fieldFromSchema(key, path, node, schema, !!parentS?.required?.includes(key));
}

export function getIn(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const p of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function setIn<T>(obj: T, path: string[], value: unknown): T {
  if (path.length === 0) return value as T;
  const [head, ...rest] = path as [string, ...string[]];
  const base = (obj && typeof obj === 'object' ? obj : {}) as Record<string, unknown>;
  const copy: Record<string, unknown> = Array.isArray(base) ? ([...base] as never) : { ...base };
  copy[head] = setIn(base[head], rest, value);
  return copy as T;
}

/** Convert a raw form value (string from inputs, boolean from switches) to the schema type. */
export function coerce(field: FieldSpec, raw: unknown): unknown {
  if (raw === undefined) return undefined;
  switch (field.kind) {
    case 'boolean':
      return raw === true || raw === 'true' || raw === 'on';
    case 'integer':
    case 'number': {
      if (raw === '' || raw === null) return field.nullable ? null : undefined;
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[ _,]/g, ''));
      if (!Number.isFinite(n)) return raw;
      return field.kind === 'integer' ? Math.round(n) : n;
    }
    case 'list': {
      const items = Array.isArray(raw)
        ? raw
        : String(raw)
            .split(/[\n,]/)
            .map((x) => x.trim())
            .filter(Boolean);
      return field.itemKind === 'number' ? items.map((x) => Number(x)) : items.map(String);
    }
    case 'text':
    case 'textarea':
    case 'enum':
      if (raw === '' || raw === null)
        return field.required ? '' : field.nullable ? null : undefined;
      return String(raw);
    case 'json':
      if (typeof raw !== 'string') return raw;
      if (raw.trim() === '') return undefined;
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    default:
      return raw;
  }
}

/** Plain-language validation error for one value, or null. */
export function validate(field: FieldSpec, value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    if (field.required && field.default === undefined && !field.nullable) return 'Required';
    return null;
  }
  if (field.kind === 'integer' || field.kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 'Enter a number';
    if (field.kind === 'integer' && !Number.isInteger(value)) return 'Enter a whole number';
    if (field.min !== undefined && value < field.min) return `At least ${field.min}`;
    if (field.max !== undefined && value > field.max) return `At most ${field.max}`;
  }
  if (field.kind === 'enum' && field.options && !field.options.some((o) => o.value === value))
    return 'Pick one of the options';
  if ((field.kind === 'text' || field.kind === 'textarea') && typeof value === 'string') {
    if (field.pattern && !new RegExp(field.pattern).test(value)) return 'This format is not valid';
    if (field.format === 'uri' || field.format === 'url') {
      try {
        new URL(value);
      } catch {
        return 'Enter a full web address (https://…)';
      }
    }
    if (field.format === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value))
      return 'Enter an email address';
  }
  if (field.kind === 'list' && field.itemKind === 'number' && Array.isArray(value)) {
    if (value.some((x) => !Number.isFinite(x))) return 'Use numbers separated by commas';
  }
  if (field.kind === 'json' && typeof value === 'string') return 'This is not valid JSON';
  return null;
}

/** Initial values for an action input form: defaults from the schema. */
export function defaultsFor(fields: FieldSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.kind === 'object' && f.children) out[f.name] = defaultsFor(f.children);
    else if (f.default !== undefined) out[f.name] = f.default;
    else if (f.kind === 'boolean' && f.required) out[f.name] = false;
  }
  return out;
}

export interface PatchOp {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: unknown;
}

const pointer = (path: string[]) =>
  `/${path.map((p) => p.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;

/**
 * JSON Patch (RFC 6902) turning `original` into `original` with `changes`
 * applied. Missing parent objects are created; `undefined` removes a key.
 */
export function buildPatch(
  original: unknown,
  changes: Array<{ path: string[]; value: unknown }>,
): PatchOp[] {
  const ops: PatchOp[] = [];
  let doc = original;
  for (const { path, value } of changes) {
    const current = getIn(doc, path);
    if (JSON.stringify(current) === JSON.stringify(value)) continue;
    if (value === undefined) {
      if (current !== undefined) {
        ops.push({ op: 'remove', path: pointer(path) });
        const parentPath = path.slice(0, -1);
        const parent = { ...(getIn(doc, parentPath) as Record<string, unknown>) };
        delete parent[path[path.length - 1] as string];
        doc = setIn(doc, parentPath, parent);
      }
      continue;
    }
    // Find the deepest existing ancestor; create the rest as one nested object.
    let i = path.length - 1;
    while (
      i > 0 &&
      (getIn(doc, path.slice(0, i)) === undefined || getIn(doc, path.slice(0, i)) === null)
    )
      i--;
    let nested: unknown = value;
    for (let j = path.length - 1; j > i; j--) nested = { [path[j] as string]: nested };
    ops.push({ op: 'add', path: pointer(path.slice(0, i + 1)), value: nested });
    doc = setIn(doc, path, value);
  }
  return ops;
}
