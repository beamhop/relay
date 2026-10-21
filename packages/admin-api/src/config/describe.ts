// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Plain-language config diffs. Labels come from the zod `.describe()` texts of
 * the canonical schema; the technical lens shows the raw path, values and the
 * `technical()` note (NIP numbers, kinds) when present.
 */
import { type DiffLine, technicalNote } from '@beamhop/core';
import type { z } from 'zod';
import { deepEqual, isSecretKey } from '../util.ts';

type AnySchema = z.ZodType;
type Def = { type: string; [k: string]: unknown };

const WRAPPERS = new Set([
  'default',
  'prefault',
  'optional',
  'nullable',
  'readonly',
  'catch',
  'nonoptional',
]);

interface Unwrapped {
  schema: AnySchema | undefined;
  description?: string;
  technical?: string;
}

const defOf = (s: AnySchema): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

export function unwrap(schema: AnySchema | undefined): Unwrapped {
  let cur = schema;
  let description: string | undefined;
  let technical: string | undefined;
  for (let i = 0; cur && i < 20; i++) {
    description ??= cur.description;
    technical ??= technicalNote(cur);
    const def = defOf(cur);
    if (WRAPPERS.has(def.type)) cur = def.innerType as AnySchema;
    else if (def.type === 'pipe') cur = def.in as AnySchema;
    else if (def.type === 'lazy') cur = (def.getter as () => AnySchema)();
    else break;
  }
  const out: Unwrapped = { schema: cur };
  if (description) out.description = description;
  if (technical) out.technical = technical;
  return out;
}

function childSchema(
  parent: AnySchema | undefined,
  key: string | number,
  value: unknown,
): AnySchema | undefined {
  if (!parent) return undefined;
  const def = defOf(parent);
  switch (def.type) {
    case 'object':
      return (def.shape as Record<string, AnySchema>)[String(key)];
    case 'record':
      return def.valueType as AnySchema;
    case 'array':
      return pickOption(def.element as AnySchema, value);
    default:
      return undefined;
  }
}

/** For unions, choose the option that best fits the value. */
function pickOption(schema: AnySchema, value: unknown): AnySchema {
  const u = unwrap(schema).schema;
  if (!u) return schema;
  const def = defOf(u);
  if (def.type !== 'union') return schema;
  const options = def.options as AnySchema[];
  for (const o of options) if (o.safeParse(value).success) return o;
  return options[0] ?? schema;
}

export function humanize(key: string): string {
  const s = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]/g, ' ')
    .toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function labelFrom(description: string): string {
  return description.split(/: |\s\(|, e\.g\.|\. /)[0]!.trim();
}

/**
 * Short label for a field: the first phrase of its description when that is short,
 * otherwise the humanized key — longer descriptions are help text, not names.
 */
export function fieldLabel(key: string, description: string | undefined): string {
  const phrase = description ? labelFrom(description).replace(/\.$/, '') : '';
  return phrase && phrase.length <= 40 ? phrase : humanize(key || 'value');
}

function fmt(v: unknown, key: string): string {
  if (v === undefined || v === null) return 'not set';
  if (isSecretKey(key)) return '•••';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'string') return `“${v.length > 60 ? `${v.slice(0, 57)}…` : v}”`;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return 'none';
    const items = v.slice(0, 5).map((x) => (typeof x === 'object' ? (idOf(x) ?? '…') : String(x)));
    return items.join(', ') + (v.length > 5 ? ` (+${v.length - 5} more)` : '');
  }
  return `${Object.keys(v as object).length} settings`;
}

function rawFmt(v: unknown, key: string): string {
  if (v === undefined) return 'undefined';
  if (isSecretKey(key) && v !== null) return '"•••"';
  const s = JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

function idOf(x: unknown): string | undefined {
  return x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string'
    ? (x as { id: string }).id
    : undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

/** Paths (dotted, ids collapsed to `*`) whose changes need a restart. */
const RESTART_PATHS = [/^node\.(listen|dataDir|tls)/, /^storage\./, /^blobStorage\./];

interface Ctx {
  /** Plain context prefix, e.g. `Relay “main”`. */
  prefix: string[];
  /** Technical path, e.g. `relays[main].access.mode`. */
  tech: string;
  /** Schema-ish path for restart detection. */
  plain: string;
}

export function describeChanges(prev: unknown, next: unknown, schema: AnySchema): DiffLine[] {
  const lines: DiffLine[] = [];
  const restart = new Set<string>();
  walk(prev, next, schema, '', { prefix: [], tech: '', plain: '' }, lines, restart);
  if (restart.size > 0)
    lines.push({
      kind: 'warning',
      text: 'Some of these changes take effect after a restart',
      technical: `restart required for: ${[...restart].join(', ')}`,
    });
  return lines;
}

function walk(
  a: unknown,
  b: unknown,
  schema: AnySchema | undefined,
  key: string,
  ctx: Ctx,
  out: DiffLine[],
  restart: Set<string>,
): void {
  if (deepEqual(a, b)) return;
  const u = unwrap(schema);
  const bothObjLike = (isObj(a) || a === undefined) && (isObj(b) || b === undefined);
  if (bothObjLike && (isObj(a) || isObj(b)) && !isSecretKey(key)) {
    const ao = (a ?? {}) as Record<string, unknown>;
    const bo = (b ?? {}) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])];
    for (const k of keys) {
      walk(
        ao[k],
        bo[k],
        childSchema(u.schema, k, bo[k] ?? ao[k]),
        k,
        {
          prefix: ctx.prefix,
          tech: ctx.tech ? `${ctx.tech}.${k}` : k,
          plain: ctx.plain ? `${ctx.plain}.${k}` : k,
        },
        out,
        restart,
      );
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const ia = a.map(idOf);
    const ib = b.map(idOf);
    if (ia.every(Boolean) && ib.every(Boolean) && (a.length > 0 || b.length > 0)) {
      const noun = fieldLabel(key, u.description).replace(/s$/, '');
      const singular = humanize(key).replace(/s$/, '');
      const byA = new Map(a.map((x) => [idOf(x)!, x]));
      const byB = new Map(b.map((x) => [idOf(x)!, x]));
      for (const id of ia as string[])
        if (!byB.has(id))
          out.push({
            kind: 'remove',
            text: `${[...ctx.prefix, `Removed ${singular.toLowerCase()} “${id}”`].join(' · ')}`,
            technical: `${ctx.tech}[${id}]: removed`,
          });
      for (const id of ib as string[])
        if (!byA.has(id))
          out.push({
            kind: 'add',
            text: `${[...ctx.prefix, `Added ${singular.toLowerCase()} “${id}”`].join(' · ')}`,
            technical: `${ctx.tech}[${id}]: added`,
          });
      for (const id of ib as string[]) {
        if (!byA.has(id)) continue;
        const el = byB.get(id);
        walk(
          byA.get(id),
          el,
          childSchema(u.schema, 0, el),
          '',
          {
            prefix: [...ctx.prefix, `${singular} “${id}”`],
            tech: `${ctx.tech}[${id}]`,
            plain: `${ctx.plain}.*`,
          },
          out,
          restart,
        );
      }
      const orderA = (ia as string[]).filter((id) => byB.has(id));
      const orderB = (ib as string[]).filter((id) => byA.has(id));
      if (orderA.join() !== orderB.join())
        out.push({
          kind: 'change',
          text: [...ctx.prefix, `Reordered ${noun.toLowerCase()}s`].join(' · '),
          technical: `${ctx.tech}: order ${orderA.join(',')} → ${orderB.join(',')}`,
        });
      return;
    }
  }
  const label = fieldLabel(key, u.description);
  const head = [...ctx.prefix, label].join(' · ');
  const kind: DiffLine['kind'] = a === undefined ? 'add' : b === undefined ? 'remove' : 'change';
  const text =
    kind === 'add'
      ? `${head}: set to ${fmt(b, key)}`
      : kind === 'remove'
        ? `${head}: cleared (was ${fmt(a, key)})`
        : `${head}: ${fmt(a, key)} → ${fmt(b, key)}`;
  let technical = `${ctx.tech || '(root)'}: ${rawFmt(a, key)} → ${rawFmt(b, key)}`;
  if (u.technical) technical += ` — ${u.technical}`;
  out.push({ kind, text, technical });
  if (RESTART_PATHS.some((r) => r.test(ctx.plain))) restart.add(ctx.tech);
}
