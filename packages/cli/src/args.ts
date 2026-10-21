// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Small hand-rolled argument parser (no dependency): `--flag value`,
 * `--flag=value`, `--no-flag`, short aliases (`-y`), repeatable flags and `--`.
 * Parsing is spec-driven so a boolean flag never swallows the next token.
 */
import { UsageError } from './io.ts';

export interface FlagSpec {
  /** kebab-case name without dashes. */
  name: string;
  type: 'boolean' | 'string';
  multiple?: boolean;
  short?: string;
  /** Extra accepted spellings (e.g. the camelCase property name). */
  aliases?: string[];
  description?: string;
  /** Placeholder for help, e.g. `<url>`. */
  placeholder?: string;
}

export type FlagValue = string | boolean | string[];
export type FlagValues = Record<string, FlagValue | undefined>;

export interface Parsed {
  flags: FlagValues;
  positionals: string[];
}

function index(specs: FlagSpec[]) {
  const byName = new Map<string, FlagSpec>();
  for (const s of specs) {
    byName.set(s.name, s);
    for (const a of s.aliases ?? []) byName.set(a, s);
    if (s.short) byName.set(`-${s.short}`, s);
  }
  return byName;
}

function set(out: FlagValues, spec: FlagSpec, value: string | boolean) {
  if (spec.multiple && typeof value === 'string') {
    const prev = out[spec.name];
    out[spec.name] = [...(Array.isArray(prev) ? prev : []), value];
  } else {
    out[spec.name] = value;
  }
}

/**
 * Parse `argv` against `specs`. With `allowUnknown`, unknown flags are kept
 * verbatim in `rest` (used for the two-phase global → command parse).
 */
export function parseFlags(
  argv: string[],
  specs: FlagSpec[],
  opts: { allowUnknown?: boolean } = {},
): Parsed & { rest: string[] } {
  const byName = index(specs);
  const flags: FlagValues = {};
  const positionals: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? '';
    if (tok === '--') {
      positionals.push(...argv.slice(i + 1));
      rest.push(...argv.slice(i));
      break;
    }
    if (tok === '-' || !tok.startsWith('-')) {
      positionals.push(tok);
      rest.push(tok);
      continue;
    }
    const isLong = tok.startsWith('--');
    const eq = tok.indexOf('=');
    const rawName = isLong ? tok.slice(2, eq === -1 ? undefined : eq) : tok.slice(0, 2);
    const inline =
      eq === -1 ? (isLong || tok.length === 2 ? undefined : tok.slice(2)) : tok.slice(eq + 1);
    let spec = byName.get(rawName);
    let negated = false;
    if (!spec && isLong && rawName.startsWith('no-')) {
      const s = byName.get(rawName.slice(3));
      if (s?.type === 'boolean') {
        spec = s;
        negated = true;
      }
    }
    if (!spec) {
      if (!opts.allowUnknown) throw new UsageError(`Unknown option ${tok.split('=')[0]}`);
      rest.push(tok);
      continue;
    }
    if (spec.type === 'boolean') {
      if (inline !== undefined) {
        if (!/^(true|false|1|0|yes|no)$/i.test(inline))
          throw new UsageError(`--${spec.name} is a yes/no option (got "${inline}")`);
        set(flags, spec, /^(true|1|yes)$/i.test(inline) !== negated);
      } else {
        set(flags, spec, !negated);
      }
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-' && !/^-\d/.test(next)))
        throw new UsageError(`--${spec.name} needs a value`);
      value = next;
      i++;
    }
    set(flags, spec, value);
  }
  return { flags, positionals, rest };
}

export const kebab = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();

export function str(v: FlagValue | undefined): string | undefined {
  if (v === undefined || typeof v === 'boolean') return undefined;
  return Array.isArray(v) ? v[v.length - 1] : v;
}

export function bool(v: FlagValue | undefined): boolean {
  return v === true;
}

/** Render a flag list for help output. */
export function flagHelp(specs: FlagSpec[], width = 26): string {
  return specs
    .filter((s) => s.description)
    .map((s) => {
      const left = `${s.short ? `-${s.short}, ` : '    '}--${s.name}${
        s.type === 'string' ? ` ${s.placeholder ?? '<value>'}` : ''
      }`;
      return `  ${left.padEnd(width)} ${s.description}`;
    })
    .join('\n');
}
