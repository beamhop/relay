// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Network access screen (§12.10): which config settings it shows, built from
 * the live config JSON Schema (`modules.enterprise-network` + `node.trustProxy`).
 * Saved through the standard config propose → diff → apply → undo flow.
 */
import type { JsonSchema } from '$lib/api/types';
import { type FieldSpec, type PatchOp, buildPatch, fieldAt, getIn } from '$lib/forms/json-schema';
import { formKey } from '$lib/forms/values';

export const NET = ['modules', 'enterprise-network'] as const;

/** Simple screen (≤ 7): who may reach the admin app and this relay, proxy, devices, sign-in proxy, private mode. */
export const SIMPLE = [
  'allowlist.admin',
  '{relay}',
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
] as const;

/** Plain labels (the schema descriptions are long sentences; they stay in the ⓘ help). */
const LABELS: Record<string, string> = {
  'allowlist.admin': 'Networks that can open the admin app',
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

/** Per-relay allowlist: a CIDR list like the admin one, at `allowlist.relays.<relayId>`. */
function relayField(schema: JsonSchema, r: RelayRef): FieldSpec | undefined {
  const admin = fieldAt(schema, [...NET, 'allowlist', 'admin']);
  if (!admin) return undefined;
  return {
    ...admin,
    name: r.id,
    path: [...NET, 'allowlist', 'relays', r.id],
    label: `Networks that can use ${r.name || r.id}`,
    help: 'Only these networks (IP addresses or ranges such as 10.0.0.0/8) can connect to this relay. Everyone when empty.',
    technical: `modules.enterprise-network.allowlist.relays["${r.id}"]: CIDR[]`,
    required: false,
  };
}

/** Field specs for one list of keys (`{relay}` = the current relay, `{other-relays}` = the rest). */
export function fieldsFor(
  schema: JsonSchema,
  keys: readonly string[],
  relays: readonly RelayRef[],
  relayId: string | null,
): FieldSpec[] {
  const current = relays.find((r) => r.id === relayId) ?? relays[0];
  const out: FieldSpec[] = [];
  for (const k of keys) {
    if (k === '{relay}') {
      const f = current && relayField(schema, current);
      if (f) out.push(f);
    } else if (k === '{other-relays}') {
      for (const r of relays) {
        if (r === current) continue;
        const f = relayField(schema, r);
        if (f) out.push(f);
      }
    } else {
      const f = field(schema, k);
      if (f) out.push(f);
    }
  }
  return out;
}

/** JSON Patch for the edited values (only real changes; empty untouched lists stay absent). */
export function patchFor(
  doc: unknown,
  fields: FieldSpec[],
  values: Record<string, unknown>,
): PatchOp[] {
  const changes: Array<{ path: string[]; value: unknown }> = [];
  for (const f of fields) {
    let v = values[formKey(f)];
    if (v === '' && !f.required) v = undefined;
    const cur = getIn(doc, f.path);
    if (v === undefined && cur === undefined) continue;
    if (Array.isArray(v) && v.length === 0 && cur === undefined) continue;
    changes.push({ path: f.path, value: v });
  }
  return buildPatch(doc, changes);
}
