// SPDX-License-Identifier: AGPL-3.0-or-later
/** Build the generated form for one settings section from the live JSON Schema + config. */
import type { ApiClient } from '../api/client.ts';
import type { JsonSchema, NodeConfig, RelayConfig } from '../api/types.ts';
import { type FieldSpec, type PatchOp, buildPatch, fieldAt, getIn } from '../forms/json-schema.ts';
import { flatten, formKey } from '../forms/values.ts';
import { type SectionDef, resolvePath } from './sections.ts';

export interface LoadedSection {
  def: SectionDef;
  simple: FieldSpec[];
  advanced: FieldSpec[];
  /** The document the paths point into (relay object or node config). */
  doc: unknown;
  initial: Record<string, unknown>;
  relayIndex: number;
}

const schemaCache = new Map<string, JsonSchema>();

async function schemaFor(api: ApiClient, relay: boolean): Promise<JsonSchema> {
  const k = relay ? 'relay' : 'node';
  let s = schemaCache.get(k);
  if (!s) {
    s = await api.configSchema(relay);
    schemaCache.set(k, s);
  }
  return s;
}

export function fieldsFor(schema: JsonSchema, paths: string[], relayIndex: number): FieldSpec[] {
  const out: FieldSpec[] = [];
  for (const p of paths) {
    const f = fieldAt(schema, resolvePath(p, relayIndex));
    if (f && f.kind !== 'object') out.push(f);
  }
  return out;
}

export async function loadSection(
  api: ApiClient,
  def: SectionDef,
  relayId: string | null,
): Promise<LoadedSection> {
  const relay = def.scope === 'relay';
  const schema = await schemaFor(api, relay);
  let doc: unknown;
  let relayIndex = 0;
  if (relay) {
    doc = (await api.relayConfig()).relay as RelayConfig;
  } else {
    const cfg = (await api.config()).config as NodeConfig;
    doc = cfg;
    relayIndex = Math.max(
      0,
      cfg.relays.findIndex((r) => r.id === relayId),
    );
  }
  const simple = fieldsFor(schema, def.simple, relayIndex);
  const advanced = fieldsFor(schema, def.advanced, relayIndex);
  return {
    def,
    simple,
    advanced,
    doc,
    initial: flatten(doc, [...simple, ...advanced]),
    relayIndex,
  };
}

/** JSON Patch for the edited values of `fields` (only real changes). */
export function patchFor(
  doc: unknown,
  fields: FieldSpec[],
  values: Record<string, unknown>,
): PatchOp[] {
  const changes: Array<{ path: string[]; value: unknown }> = [];
  for (const f of fields) {
    let v = values[formKey(f)];
    if (v === '' && !f.required) v = undefined;
    // Untouched empty optional values: leave the document as it is.
    if (v === undefined && getIn(doc, f.path) === undefined) continue;
    if (Array.isArray(v) && v.length === 0 && getIn(doc, f.path) === undefined) continue;
    changes.push({ path: f.path, value: v });
  }
  return buildPatch(doc, changes);
}
