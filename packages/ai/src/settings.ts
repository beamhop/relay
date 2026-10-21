// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Config lookups for the assistant: masked config sections and plain-language
 * explanations of single settings, read from the zod schema (`.describe()` text
 * + `technical()` notes) — the same source as the ⓘ sheets.
 */
import {
  type BeamhopConfig,
  ConfigSchema,
  type RelayId,
  RelaySchema,
  technicalNote,
} from '@beamhop/core';
import type { z } from 'zod';
import { scrub } from './safety.ts';

type AnyZod = z.ZodType;
interface Def {
  type: string;
  innerType?: AnyZod;
  in?: AnyZod;
  out?: AnyZod;
  shape?: Record<string, AnyZod>;
  element?: AnyZod;
  valueType?: AnyZod;
  entries?: Record<string, unknown>;
  values?: unknown[];
  options?: AnyZod[];
  defaultValue?: unknown;
  checks?: Array<{ _zod?: { def?: { check?: string; value?: unknown; inclusive?: boolean } } }>;
}

const defOf = (s: AnyZod): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

const WRAPPERS = new Set([
  'default',
  'prefault',
  'optional',
  'nullable',
  'readonly',
  'catch',
  'nonoptional',
]);

interface Collected {
  description?: string;
  technical?: string;
  defaultValue?: unknown;
  base: AnyZod;
}

/** Peel wrappers (default/optional/pipe…), collecting description, technical note and default. */
function peel(schema: AnyZod): Collected {
  const out: Collected = { base: schema };
  let s: AnyZod | undefined = schema;
  for (let i = 0; s && i < 20; i++) {
    out.description ??= (s as { description?: string }).description;
    out.technical ??= technicalNote(s);
    const d = defOf(s);
    if (d.type === 'default' || d.type === 'prefault') {
      if (out.defaultValue === undefined) {
        const v = d.defaultValue;
        out.defaultValue = typeof v === 'function' ? (v as () => unknown)() : v;
      }
    }
    if (WRAPPERS.has(d.type) && d.innerType) {
      s = d.innerType;
      continue;
    }
    if (d.type === 'pipe' && d.in) {
      s = d.in;
      continue;
    }
    break;
  }
  if (s) out.base = s;
  return out;
}

function child(schema: AnyZod, key: string): AnyZod | undefined {
  const { base } = peel(schema);
  const d = defOf(base);
  if (d.type === 'object') return d.shape?.[key];
  if (d.type === 'array' && /^\d+$|^\*$/.test(key)) return d.element;
  if (d.type === 'record') return d.valueType;
  if (d.type === 'union' && d.options) {
    for (const o of d.options) {
      const c = child(o, key);
      if (c) return c;
    }
  }
  return undefined;
}

function describeType(base: AnyZod): Record<string, unknown> {
  const d = defOf(base);
  const info: Record<string, unknown> = { type: d.type };
  if (d.type === 'enum' && d.entries) info.options = Object.values(d.entries);
  if (d.type === 'literal' && d.values) info.options = d.values;
  for (const c of d.checks ?? []) {
    const cd = c._zod?.def;
    if (cd?.check === 'greater_than') info.min = cd.value;
    if (cd?.check === 'less_than') info.max = cd.value;
  }
  if (d.type === 'object' && d.shape) info.fields = Object.keys(d.shape);
  return info;
}

function getPath(obj: unknown, parts: string[]): unknown {
  let cur = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export interface SettingExplanation {
  path: string;
  found: boolean;
  description?: string;
  technical?: string;
  defaultValue?: unknown;
  currentValue?: unknown;
  type?: Record<string, unknown>;
}

/**
 * Explain one setting. Paths are dotted, either node-level (`ai.baseUrl`,
 * `privacy.ipLogging`) or relay-level (`access.mode`, `goals.openness`) — the
 * latter are resolved against the relay in context.
 */
export function explainSetting(
  config: BeamhopConfig,
  path: string,
  relayId: RelayId | null,
): SettingExplanation {
  const clean = path.trim().replace(/^config\./, '');
  const parts = clean.split('.').filter(Boolean);
  const relay = relayId ? config.relays.find((r) => r.id === relayId) : undefined;
  const attempts: Array<{ root: AnyZod; value: unknown; parts: string[] }> = [];
  if (parts[0] === 'relays' && parts.length >= 2) {
    const rid = parts[1]!;
    const r = config.relays.find((x) => x.id === rid);
    attempts.push({ root: RelaySchema, value: r, parts: parts.slice(2) });
  }
  attempts.push({ root: ConfigSchema, value: config, parts });
  attempts.push({ root: RelaySchema, value: relay, parts });
  for (const a of attempts) {
    let s: AnyZod | undefined = a.root;
    for (const p of a.parts) {
      s = s ? child(s, p) : undefined;
      if (!s) break;
    }
    if (!s || !a.parts.length) continue;
    const c = peel(s);
    const out: SettingExplanation = { path: clean, found: true, type: describeType(c.base) };
    if (c.description) out.description = c.description;
    if (c.technical) out.technical = c.technical;
    if (c.defaultValue !== undefined) out.defaultValue = scrub(c.defaultValue);
    const current = getPath(a.value, a.parts);
    if (current !== undefined) out.currentValue = maskLeaf(a.parts, current);
    return out;
  }
  return { path: clean, found: false };
}

/** Scrub a leaf value using its own key name (so `ai.apiKey` is masked). */
function maskLeaf(parts: string[], v: unknown): unknown {
  const last = parts[parts.length - 1] ?? '';
  return (scrub({ [last]: v }) as Record<string, unknown>)[last];
}

export const NODE_SECTIONS = [
  'node',
  'storage',
  'blobStorage',
  'alerts',
  'ai',
  'backups',
  'privacy',
  'plugins',
  'modules',
] as const;
export const RELAY_SECTIONS = [
  'info',
  'persona',
  'goals',
  'access',
  'tiers',
  'limits',
  'retention',
  'blossom',
  'public',
  'hosts',
] as const;

/** One config section with every secret masked (always, regardless of role: prompts may leave the box). */
export function configSection(
  config: BeamhopConfig,
  section: string,
  relayId: RelayId | null,
): { section: string; value: unknown } | { error: string; sections: string[] } {
  const parts = section.trim().split('.').filter(Boolean);
  const head = parts[0] ?? '';
  const relay = relayId ? config.relays.find((r) => r.id === relayId) : undefined;
  if (relay && (RELAY_SECTIONS as readonly string[]).includes(head))
    return { section, value: scrub(getPath(relay, parts)) };
  if ((NODE_SECTIONS as readonly string[]).includes(head))
    return { section, value: scrub(getPath(config, parts)) };
  if (head === 'relays')
    return {
      section,
      value: scrub(
        parts.length > 1
          ? getPath(config, parts)
          : config.relays.map((r) => ({ id: r.id, hosts: r.hosts, persona: r.persona })),
      ),
    };
  return {
    error: 'Unknown section',
    sections: [...NODE_SECTIONS, 'relays', ...(relay ? RELAY_SECTIONS : [])],
  };
}
