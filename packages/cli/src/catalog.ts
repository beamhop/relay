// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Generated commands (§6.13 CLI parity): the admin API's `/actions` catalog
 * (one entry per registered action, with its input JSON Schema) becomes
 * `beamhop <group> <name> [--flags]`. Flags, types, enums, required fields
 * and help text all come from the schema — nothing here is action-specific.
 */
import { type FlagSpec, type FlagValues, kebab } from './args.ts';

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  format?: string;
}

export interface CatalogEntry {
  id: string;
  title: string;
  description: string;
  technical?: string;
  scope: 'node' | 'relay';
  permission: string;
  readOnly: boolean;
  sensitive?: boolean;
  bulk: boolean;
  undoable: boolean;
  hasPreview?: boolean;
  keywords?: string[];
  shortcut?: string;
  cli?: string;
  inputSchema: JsonSchema;
  allowed?: boolean;
}

export interface Catalog {
  actions: CatalogEntry[];
}

/** Flags every command understands; action properties never shadow them. */
export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: 'help', type: 'boolean', short: 'h', description: 'Show help' },
  { name: 'json', type: 'boolean', description: 'Machine-readable JSON output' },
  { name: 'yes', type: 'boolean', short: 'y', description: 'Apply without asking' },
  { name: 'preview', type: 'boolean', description: 'Only show what would change' },
  { name: 'technical', type: 'boolean', description: 'Show technical details too' },
  {
    name: 'url',
    type: 'string',
    placeholder: '<url>',
    description: 'Manage a remote server (default: saved login, else local data dir)',
  },
  {
    name: 'token',
    type: 'string',
    placeholder: '<token>',
    description: 'API token (default: $BEAMHOP_TOKEN or saved login)',
  },
  {
    name: 'data-dir',
    type: 'string',
    placeholder: '<dir>',
    description: 'Local data directory (default: from beamhop.yaml, else ./data)',
  },
  {
    name: 'config',
    type: 'string',
    short: 'c',
    placeholder: '<file>',
    description: 'Settings file (default: ./beamhop.yaml)',
  },
  { name: 'local', type: 'boolean', description: 'Use the local data dir even if logged in' },
  {
    name: 'relay',
    type: 'string',
    placeholder: '<id>',
    description: 'Which relay (for relay actions; default: the only one)',
  },
  {
    name: 'audit-reason',
    type: 'string',
    placeholder: '<text>',
    description: 'Why you are doing this (kept in the audit log)',
  },
  { name: 'no-color', type: 'boolean', description: 'Plain output without colors' },
];

export const ACTION_FLAGS: FlagSpec[] = [
  {
    name: 'from-file',
    type: 'string',
    placeholder: '<file>',
    description: 'Run for many items: JSON array or one JSON object per line (- = stdin)',
  },
  {
    name: 'input',
    type: 'string',
    placeholder: '<json>',
    description: 'Pass the whole input as JSON (flags override fields)',
  },
];

const RESERVED = new Set(
  [...GLOBAL_FLAGS, ...ACTION_FLAGS].flatMap((f) => [f.name, ...(f.aliases ?? [])]),
);

export type FieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'json';

export interface ActionField {
  /** Property name in the input object. */
  prop: string;
  /** Flag name (kebab-case). */
  flag: string;
  type: FieldType;
  itemType?: FieldType;
  enum?: unknown[];
  itemEnum?: unknown[];
  required: boolean;
  description?: string;
  default?: unknown;
  schema: JsonSchema;
}

/** Unwrap `anyOf: [X, {type:'null'}]` and similar to the useful branch. */
function unwrap(s: JsonSchema): JsonSchema {
  const alts = s.anyOf ?? s.oneOf;
  if (alts?.length) {
    const nonNull = alts.filter((a) => a.type !== 'null');
    if (nonNull.length === 1)
      return { ...unwrap(nonNull[0]!), description: s.description ?? nonNull[0]!.description };
    // enum of literals
    if (nonNull.every((a) => a.const !== undefined))
      return {
        type: typeof nonNull[0]!.const === 'number' ? 'number' : 'string',
        enum: nonNull.map((a) => a.const),
        description: s.description,
      };
    return { ...s, type: 'json' };
  }
  if (s.const !== undefined && !s.enum) return { ...s, enum: [s.const] };
  return s;
}

function fieldType(s: JsonSchema): FieldType {
  const t = Array.isArray(s.type) ? s.type.find((x) => x !== 'null') : s.type;
  if (t === 'string' || t === 'number' || t === 'integer' || t === 'boolean' || t === 'array')
    return t;
  if (!t && s.enum?.length) return typeof s.enum[0] === 'number' ? 'number' : 'string';
  return 'json';
}

export function actionFields(entry: Pick<CatalogEntry, 'inputSchema'>): ActionField[] {
  const root = unwrap(entry.inputSchema ?? {});
  const required = new Set(root.required ?? []);
  return Object.entries(root.properties ?? {}).map(([prop, raw]) => {
    const s = unwrap(raw);
    const type = fieldType(s);
    let flag = kebab(prop);
    if (RESERVED.has(flag)) flag = `in-${flag}`;
    const f: ActionField = {
      prop,
      flag,
      type,
      required: required.has(prop) && s.default === undefined,
      schema: s,
    };
    if (s.description) f.description = s.description;
    if (s.default !== undefined) f.default = s.default;
    if (s.enum) f.enum = s.enum;
    if (type === 'array' && s.items) {
      const it = unwrap(s.items);
      f.itemType = fieldType(it);
      if (it.enum) f.itemEnum = it.enum;
    }
    return f;
  });
}

export function fieldFlagSpecs(fields: ActionField[]): FlagSpec[] {
  return fields.map((f) => {
    const spec: FlagSpec = {
      name: f.flag,
      type: f.type === 'boolean' ? 'boolean' : 'string',
      multiple: f.type === 'array',
      placeholder: placeholder(f),
    };
    if (f.flag !== f.prop && !RESERVED.has(f.prop)) spec.aliases = [f.prop];
    return spec;
  });
}

function placeholder(f: ActionField): string {
  const en = f.enum ?? f.itemEnum;
  if (en && en.length <= 6) return `<${en.join('|')}>`;
  if (f.type === 'array') return `<${f.itemType ?? 'value'}>…`;
  if (f.type === 'json') return '<json>';
  if (f.type === 'number' || f.type === 'integer') return '<n>';
  return `<${f.flag}>`;
}

export interface FieldIssue {
  flag: string;
  message: string;
}

function coerceScalar(
  f: ActionField,
  type: FieldType,
  raw: string,
  en: unknown[] | undefined,
  schema: JsonSchema,
  issues: FieldIssue[],
): unknown {
  const bad = (message: string) => {
    issues.push({ flag: f.flag, message });
    return undefined;
  };
  let v: unknown = raw;
  if (type === 'number' || type === 'integer') {
    const n = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(n)) return bad(`must be a number (got "${raw}")`);
    if (type === 'integer' && !Number.isInteger(n))
      return bad(`must be a whole number (got ${raw})`);
    if (schema.minimum !== undefined && n < schema.minimum)
      return bad(`must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && n > schema.maximum)
      return bad(`must be at most ${schema.maximum}`);
    if (schema.exclusiveMinimum !== undefined && n <= schema.exclusiveMinimum)
      return bad(`must be more than ${schema.exclusiveMinimum}`);
    if (schema.exclusiveMaximum !== undefined && n >= schema.exclusiveMaximum)
      return bad(`must be less than ${schema.exclusiveMaximum}`);
    v = n;
  } else if (type === 'boolean') {
    if (!/^(true|false|yes|no|1|0)$/i.test(raw)) return bad(`must be yes or no (got "${raw}")`);
    v = /^(true|yes|1)$/i.test(raw);
  } else if (type === 'json') {
    try {
      v = JSON.parse(raw);
    } catch {
      return bad('must be valid JSON');
    }
  } else if (type === 'string') {
    if (schema.minLength !== undefined && raw.length < schema.minLength)
      return bad(
        schema.minLength === 1
          ? 'must not be empty'
          : `must be at least ${schema.minLength} characters`,
      );
    if (schema.maxLength !== undefined && raw.length > schema.maxLength)
      return bad(`must be at most ${schema.maxLength} characters`);
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern, 'u').test(raw))
          return bad(`has the wrong format (${schema.pattern})`);
      } catch {
        // pattern not expressible in JS: let the server decide
      }
    }
  }
  if (en && !en.some((e) => e === v)) return bad(`must be one of: ${en.join(', ')} (got "${raw}")`);
  return v;
}

/**
 * Turn parsed flag values into an action input object, validating against the
 * JSON Schema (types, enums, ranges, required). The server re-validates with zod.
 */
export function buildInput(
  fields: ActionField[],
  flags: FlagValues,
  base: Record<string, unknown> = {},
  opts: { requireAll?: boolean } = {},
): { input: Record<string, unknown>; issues: FieldIssue[] } {
  const input: Record<string, unknown> = { ...base };
  const issues: FieldIssue[] = [];
  for (const f of fields) {
    const v = flags[f.flag];
    if (v === undefined) continue;
    if (f.type === 'boolean') {
      input[f.prop] = v === true || (typeof v === 'string' && /^(true|yes|1)$/i.test(v));
      continue;
    }
    if (f.type === 'array') {
      const raws = (Array.isArray(v) ? v : [String(v)]).flatMap((x) =>
        f.itemType === 'json'
          ? [x]
          : x
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
      );
      const items = raws.map((r) =>
        coerceScalar(
          f,
          f.itemType ?? 'string',
          r,
          f.itemEnum,
          unwrap(f.schema.items ?? {}),
          issues,
        ),
      );
      if (f.schema.minItems !== undefined && items.length < f.schema.minItems)
        issues.push({ flag: f.flag, message: `needs at least ${f.schema.minItems} value(s)` });
      if (f.schema.maxItems !== undefined && items.length > f.schema.maxItems)
        issues.push({ flag: f.flag, message: `takes at most ${f.schema.maxItems} value(s)` });
      input[f.prop] = items;
      continue;
    }
    const raw = Array.isArray(v) ? v[v.length - 1]! : String(v);
    const out = coerceScalar(f, f.type, raw, f.enum, f.schema, issues);
    if (out !== undefined) input[f.prop] = out;
  }
  if (opts.requireAll !== false) {
    for (const f of fields) {
      if (f.required && input[f.prop] === undefined && !issues.some((i) => i.flag === f.flag))
        issues.push({ flag: f.flag, message: 'is required' });
    }
  }
  return { input, issues };
}

/** `admins.set-role` → ['admins', 'set-role']. */
export const commandPath = (id: string) => id.split('.');

/** Find the action named by the leading positionals (longest match wins). */
export function matchAction(
  catalog: Catalog,
  positionals: string[],
): { entry: CatalogEntry; consumed: number } | null {
  let best: { entry: CatalogEntry; consumed: number } | null = null;
  for (const entry of catalog.actions) {
    const path = commandPath(entry.id);
    if (path.length > positionals.length) continue;
    if (path.every((p, i) => p === positionals[i]) && (!best || path.length > best.consumed))
      best = { entry, consumed: path.length };
  }
  return best;
}

/** group → actions in that group (sorted). */
export function groups(catalog: Catalog): Map<string, CatalogEntry[]> {
  const out = new Map<string, CatalogEntry[]>();
  for (const a of [...catalog.actions].sort((x, y) => x.id.localeCompare(y.id))) {
    const g = commandPath(a.id)[0]!;
    out.set(g, [...(out.get(g) ?? []), a]);
  }
  return out;
}

function describeField(f: ActionField): string {
  const bits: string[] = [];
  if (f.description) bits.push(f.description);
  if (f.required) bits.push('(required)');
  if (f.type === 'array') bits.push('(repeatable or comma-separated)');
  if (f.enum && f.enum.length > 6) bits.push(`one of: ${f.enum.join(', ')}`);
  if (f.itemEnum && f.itemEnum.length > 6) bits.push(`any of: ${f.itemEnum.join(', ')}`);
  if (f.default !== undefined) bits.push(`[default: ${JSON.stringify(f.default)}]`);
  return bits.join(' ');
}

export function actionHelp(entry: CatalogEntry, technical = false): string {
  const fields = actionFields(entry);
  const usage = `beamhop ${commandPath(entry.id).join(' ')}${fields
    .filter((f) => f.required)
    .map((f) => ` --${f.flag} ${placeholder(f)}`)
    .join('')}${fields.some((f) => !f.required) ? ' [options]' : ''}`;
  const out = [`${entry.title}`, '', entry.description, '', `Usage: ${usage}`];
  if (fields.length) {
    out.push('', 'Options:');
    for (const f of fields) {
      const left = `--${f.flag}${f.type === 'boolean' ? '' : ` ${placeholder(f)}`}`;
      out.push(`  ${left.padEnd(30)} ${describeField(f)}`);
    }
  }
  const notes: string[] = [];
  if (entry.scope === 'relay')
    notes.push('Works on one relay: pass --relay <id> if you have several.');
  if (entry.readOnly) notes.push('Only reads; changes nothing.');
  else {
    notes.push('Shows what will change and asks before applying (--yes skips the question).');
    if (entry.undoable) notes.push('Can be undone for a few minutes with `beamhop undo <token>`.');
  }
  if (entry.bulk) notes.push('Bulk: --from-file <file> runs it for many items with one undo.');
  if (entry.sensitive) notes.push('Sensitive: may need a second admin to approve.');
  out.push('', ...notes);
  if (technical) {
    out.push(
      '',
      `Technical: action ${entry.id}, permission ${entry.permission}, scope ${entry.scope}`,
    );
    if (entry.technical) out.push(`  ${entry.technical}`);
  }
  return `${out.join('\n')}\n`;
}

export function groupHelp(group: string, entries: CatalogEntry[]): string {
  const width = Math.max(...entries.map((e) => commandPath(e.id).slice(1).join(' ').length), 8) + 2;
  return `${[
    `beamhop ${group} <command>`,
    '',
    ...entries.map((e) => `  ${commandPath(e.id).slice(1).join(' ').padEnd(width)} ${e.title}`),
    '',
    `Run \`beamhop ${group} <command> --help\` for details.`,
  ].join('\n')}\n`;
}

export function catalogSummary(catalog: Catalog): string {
  const lines: string[] = [];
  for (const [g, entries] of groups(catalog)) {
    lines.push(
      `  ${g.padEnd(16)} ${entries.map((e) => commandPath(e.id).slice(1).join(' ')).join(', ')}`,
    );
  }
  return lines.join('\n');
}
