// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Network access screen (§12.10): which config settings it shows, built from
 * the live config JSON Schema (`modules.enterprise-network` + `node.trustProxy`).
 * Saved through the standard config propose → diff → apply → undo flow.
 */
import type { JsonSchema } from '$lib/api/types';
import { type FieldSpec, type PatchOp, buildPatch, fieldAt, getIn } from '$lib/forms/json-schema';
import { flatten, formKey } from '$lib/forms/values';

export const NET = ['modules', 'enterprise-network'] as const;

/** Simple screen (≤ 7): who may reach the admin app and this relay, blocked networks, proxy, devices, sign-in proxy, private mode. */
export const SIMPLE = [
  'allowlist.admin',
  '{relay}',
  'denylist.all',
  'node.trustProxy',
  'mtls.enabled',
  'zeroTrust.provider',
  'privateOnly.enabled',
] as const;

export const ADVANCED = [
  'mtls.scope',
  'mtls.caPem',
  'mtls.allowedSubjects',
  'mtls.certHeader',
  'mtls.verifyHeader',
  'zeroTrust.scope',
  'zeroTrust.audience',
  'zeroTrust.teamDomain',
  'zeroTrust.jwksUrl',
  'zeroTrust.userHeader',
  'privateOnly.keepPortal',
  'adminPaths',
  '{other-relays}',
  '{relay-deny}',
  '{other-relays-deny}',
] as const;

/** Synthetic switch: is `outbound.default` set (groups limited) or null (no limit)? */
export const OUTBOUND_LIMIT = [...NET, 'outbound', 'limit'];
const OUTBOUND_DEFAULT = [...NET, 'outbound', 'default'];
const OUTBOUND_GROUPS = [...NET, 'outbound', 'groups'];

/** Plain labels (the schema descriptions are long sentences; they stay in the ⓘ help). */
const LABELS: Record<string, string> = {
  'allowlist.admin': 'Networks that can open the admin app',
  'denylist.all': 'Blocked networks',
  'node.trustProxy': 'My server is behind a proxy or load balancer',
  'mtls.enabled': 'Only company devices can connect',
  'zeroTrust.provider': 'Company sign-in proxy',
  'privateOnly.enabled': 'Private mode',
  'mtls.scope': 'Where the device check applies',
  'mtls.caPem': 'Company certificate authority',
  'mtls.allowedSubjects': 'Allowed device names',
  'mtls.certHeader': 'Device certificate header',
  'mtls.verifyHeader': 'Proxy check header',
  'zeroTrust.scope': 'Where the sign-in proxy is required',
  'zeroTrust.audience': 'Proxy app id',
  'zeroTrust.teamDomain': 'Cloudflare team address',
  'zeroTrust.jwksUrl': 'Proxy signing keys address',
  'zeroTrust.userHeader': 'Signed-in user header',
  'privateOnly.keepPortal': 'Keep the self-service portal',
  adminPaths: 'Admin app addresses',
};

export interface RelayRef {
  id: string;
  name?: string;
}

export interface GroupRef {
  id: string;
  name?: string;
}

const same = (a: readonly string[], b: readonly string[]) => a.join('.') === b.join('.');

/** Does the server know the network settings (module enabled, schema published)? */
export function hasNetworkSchema(schema: JsonSchema): boolean {
  return !!fieldAt(schema, [...NET, 'allowlist']);
}

function field(schema: JsonSchema, key: string): FieldSpec | undefined {
  const path = key.startsWith('node.') ? key.split('.') : [...NET, ...key.split('.')];
  const f = fieldAt(schema, path);
  if (!f || f.kind === 'object') return undefined;
  const label = LABELS[key];
  return label ? { ...f, label } : f;
}

/** Per-relay allow (or deny) list: a CIDR list like the node-wide one, at `<list>.relays.<relayId>`. */
function relayField(
  schema: JsonSchema,
  r: RelayRef,
  list: 'allowlist' | 'denylist' = 'allowlist',
): FieldSpec | undefined {
  const base = fieldAt(schema, [...NET, list, list === 'allowlist' ? 'admin' : 'all']);
  if (!base) return undefined;
  const name = r.name || r.id;
  return {
    ...base,
    name: r.id,
    path: [...NET, list, 'relays', r.id],
    label: list === 'allowlist' ? `Networks that can use ${name}` : `Networks blocked from ${name}`,
    help:
      list === 'allowlist'
        ? 'Only these networks (IP addresses or ranges such as 10.0.0.0/8) can connect to this relay. Everyone when empty.'
        : 'These networks (IP addresses or ranges such as 10.0.0.0/8) can never connect to this relay.',
    technical: `modules.enterprise-network.${list}.relays["${r.id}"]: CIDR[]`,
    required: false,
  };
}

/** Field specs for one list of keys (`{relay}` = the current relay, `{other-relays}` = the rest; `-deny` = block lists). */
export function fieldsFor(
  schema: JsonSchema,
  keys: readonly string[],
  relays: readonly RelayRef[],
  relayId: string | null,
): FieldSpec[] {
  const current = relays.find((r) => r.id === relayId) ?? relays[0];
  const out: FieldSpec[] = [];
  for (const k of keys) {
    if (k === '{relay}' || k === '{relay-deny}') {
      const f = current && relayField(schema, current, k === '{relay}' ? 'allowlist' : 'denylist');
      if (f) out.push(f);
    } else if (k === '{other-relays}' || k === '{other-relays-deny}') {
      for (const r of relays) {
        if (r === current) continue;
        const f = relayField(schema, r, k === '{other-relays}' ? 'allowlist' : 'denylist');
        if (f) out.push(f);
      }
    } else {
      const f = field(schema, k);
      if (f) out.push(f);
    }
  }
  return out;
}

/**
 * Team-group fields (§12.10 outbound): a switch "keep group messages on your
 * company's relays" (`outbound.default` set vs null), the other relays every
 * group may also post to, and one list per group (empty = same as all groups).
 */
export function outboundFields(schema: JsonSchema, groups: readonly GroupRef[]): FieldSpec[] {
  const def = fieldAt(schema, OUTBOUND_DEFAULT);
  if (!def) return [];
  const list: FieldSpec = {
    ...def,
    kind: 'list',
    itemKind: 'text',
    nullable: false,
    required: false,
    default: undefined,
    recommended: undefined,
  };
  const out: FieldSpec[] = [
    {
      name: 'limit',
      path: [...OUTBOUND_LIMIT],
      label: 'Keep group messages on your company’s relays',
      help: 'When on, people in team groups can only post to this relay and the relays you list.',
      kind: 'boolean',
      required: false,
      nullable: false,
      default: false,
      secret: false,
      technical: 'modules.enterprise-network.outbound.default !== null',
    },
    {
      ...list,
      label: 'Other relays every group may also post to',
      help: 'Relay addresses such as wss://relay.example.com. Empty = only this relay.',
      technical: 'modules.enterprise-network.outbound.default: wss:// URL[]',
      showWhen: { path: 'limit', equals: true },
    },
  ];
  for (const g of groups) {
    out.push({
      ...list,
      name: g.id,
      path: [...OUTBOUND_GROUPS, g.id],
      label: `Other relays “${g.name || g.id}” may also post to`,
      help: 'Messages in this group stay on your company’s relays. Empty = same as all groups.',
      technical: `modules.enterprise-network.outbound.groups["${g.id}"]: wss:// URL[] (NIP-29 group id = h tag)`,
      showWhen: undefined,
    });
  }
  return out;
}

/** Groups to show: the relay's groups plus any already configured elsewhere. */
export function groupRefs(doc: unknown, groups: readonly GroupRef[]): GroupRef[] {
  const out = [...groups];
  const configured = getIn(doc, OUTBOUND_GROUPS) as Record<string, unknown> | undefined;
  for (const id of Object.keys(configured ?? {}))
    if (!out.some((g) => g.id === id)) out.push({ id });
  return out;
}

/** Initial form values, including the synthetic outbound switch. */
export function initialValues(doc: unknown, fields: FieldSpec[]): Record<string, unknown> {
  const values = flatten(doc, fields);
  if (fields.some((f) => same(f.path, OUTBOUND_LIMIT)))
    values[OUTBOUND_LIMIT.join('__')] = Array.isArray(getIn(doc, OUTBOUND_DEFAULT));
  return values;
}

/** Raw outbound policy for the technical lens. */
export function outboundLens(doc: unknown): string[] {
  const def = getIn(doc, OUTBOUND_DEFAULT);
  const groups = (getIn(doc, OUTBOUND_GROUPS) ?? {}) as Record<string, string[]>;
  const lines = [
    `outbound.default = ${Array.isArray(def) ? JSON.stringify(def) : 'null (no limit)'}`,
  ];
  for (const [id, list] of Object.entries(groups))
    lines.push(`outbound.groups["${id}"] = ${JSON.stringify(list)}`);
  lines.push('Published at GET /.well-known/beamhop/network; enforced by the team client');
  return lines;
}

/** JSON Patch for the edited values (only real changes; empty untouched lists stay absent). */
export function patchFor(
  doc: unknown,
  fields: FieldSpec[],
  values: Record<string, unknown>,
): PatchOp[] {
  const changes: Array<{ path: string[]; value: unknown }> = [];
  const hasLimit = fields.some((f) => same(f.path, OUTBOUND_LIMIT));
  for (const f of fields) {
    if (same(f.path, OUTBOUND_LIMIT)) continue;
    let v = values[formKey(f)];
    if (v === '' && !f.required) v = undefined;
    const cur = getIn(doc, f.path);
    if (hasLimit && same(f.path, OUTBOUND_DEFAULT)) {
      // Switch off = no limit (null); on = this relay plus the listed ones.
      v = values[OUTBOUND_LIMIT.join('__')] ? (Array.isArray(v) ? v : []) : null;
      if (v === null && (cur === null || cur === undefined)) continue;
      changes.push({ path: f.path, value: v });
      continue;
    }
    // Emptying a group's list = same as all groups (entry removed); an untouched entry stays.
    if (
      same(f.path.slice(0, -1), OUTBOUND_GROUPS) &&
      Array.isArray(v) &&
      v.length === 0 &&
      JSON.stringify(cur) !== '[]'
    )
      v = undefined;
    if (v === undefined && cur === undefined) continue;
    if (Array.isArray(v) && v.length === 0 && cur === undefined) continue;
    changes.push({ path: f.path, value: v });
  }
  return buildPatch(doc, changes);
}
