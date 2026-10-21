// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Personas (§7): starting positions on the goal sliders plus a handful of
 * access/media defaults. Applying a persona never touches the relay's id,
 * hosts, info, tiers or explicit `limits` overrides.
 */
import {
  type DiffLine,
  type Persona,
  PersonaSchema,
  type RelayConfig,
  RelaySchema,
} from '@beamhop/core';

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export type RelayConfigPatch = DeepPartial<Omit<RelayConfig, 'id' | 'hosts' | 'pathPrefix'>>;

export const personaPresets: Record<Persona, RelayConfigPatch> = {
  'public-social': {
    persona: 'public-social',
    goals: { openness: 80, spamTolerance: 40, storage: 60, media: 50, speedVsCost: 50 },
    access: { mode: 'open', authRequired: { read: false, write: false } },
    blossom: { enabled: true, requireAuth: true, mirror: true },
  },
  'private-team': {
    persona: 'private-team',
    goals: { openness: 10, spamTolerance: 80, storage: 90, media: 60, speedVsCost: 50 },
    access: { mode: 'allowlist', authRequired: { read: true, write: true } },
    blossom: { enabled: true, requireAuth: true, mirror: false },
    public: { landing: false, portal: true, status: false },
  },
  'wot-community': {
    persona: 'wot-community',
    goals: { openness: 50, spamTolerance: 50, storage: 60, media: 50, speedVsCost: 50 },
    access: {
      mode: 'wot',
      authRequired: { read: false, write: false },
      wot: { depth: 2, minFollowers: 2 },
    },
    blossom: { enabled: true, requireAuth: true, mirror: true },
  },
  'media-host': {
    persona: 'media-host',
    goals: { openness: 60, spamTolerance: 40, storage: 70, media: 95, speedVsCost: 70 },
    access: { mode: 'open', authRequired: { read: false, write: false } },
    blossom: {
      enabled: true,
      requireAuth: true,
      mirror: true,
      optimize: { stripMetadata: true, thumbnails: true, resize: true, transcode: true },
      scanning: { enabled: true },
    },
  },
  organization: {
    persona: 'organization',
    goals: { openness: 5, spamTolerance: 80, storage: 100, media: 60, speedVsCost: 60 },
    access: { mode: 'allowlist', authRequired: { read: true, write: true } },
    blossom: { enabled: true, requireAuth: true, mirror: false },
    public: { landing: false, portal: true, status: false },
  },
};

export const personaInfo: Record<Persona, { title: string; description: string }> = {
  'public-social': {
    title: 'Public social',
    description: 'Anyone can join and post. Spam filters and fair-use limits keep it healthy.',
  },
  'private-team': {
    title: 'Private team',
    description: 'Only invited people can read and post. Everything is kept.',
  },
  'wot-community': {
    title: 'Web-of-trust community',
    description: 'People followed by you (and the people you trust) can post.',
  },
  'media-host': {
    title: 'Media host',
    description: 'Generous file sizes, thumbnails and video conversion.',
  },
  organization: {
    title: 'Company / Organization',
    description: 'Members only, sign-in required, long retention.',
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep merge: objects merge recursively, arrays and scalars replace. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch))
    return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** Return a new, validated relay config with the persona's preset applied. */
export function applyPersona(relay: RelayConfig, persona: Persona): RelayConfig {
  const p = PersonaSchema.parse(persona);
  return RelaySchema.parse(deepMerge(relay, personaPresets[p]));
}

function flatten(v: unknown, prefix: string, out: Map<string, unknown>): void {
  if (isPlainObject(v)) {
    for (const [k, x] of Object.entries(v)) flatten(x, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix, v);
  }
}

const PATH_LABELS: Record<string, string> = {
  persona: 'Relay type',
  'goals.openness': 'Openness',
  'goals.spamTolerance': 'Spam tolerance',
  'goals.storage': 'Storage',
  'goals.media': 'Media',
  'goals.speedVsCost': 'Speed vs cost',
  'access.mode': 'Who can post',
  'access.authRequired.read': 'Sign-in required to read',
  'access.authRequired.write': 'Sign-in required to post',
  'access.wot.depth': 'Trusted follow hops',
  'access.wot.minFollowers': 'Trusted followers needed',
  'blossom.enabled': 'Media hosting',
  'blossom.mirror': 'Copy files from other servers',
  'blossom.requireAuth': 'Sign-in required to upload',
  'blossom.optimize.transcode': 'Convert videos',
  'blossom.optimize.thumbnails': 'Thumbnails',
  'blossom.optimize.resize': 'Resize images',
  'public.landing': 'Public landing page',
  'public.portal': 'Self-service portal',
  'public.status': 'Status page',
};

const fmt = (v: unknown) =>
  v === undefined ? 'not set' : typeof v === 'boolean' ? (v ? 'on' : 'off') : JSON.stringify(v);

/** Plain diff between two relay configs (used for previews). */
export function diffRelayConfig(prev: RelayConfig, next: RelayConfig): DiffLine[] {
  const a = new Map<string, unknown>();
  const b = new Map<string, unknown>();
  flatten(prev, '', a);
  flatten(next, '', b);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  const lines: DiffLine[] = [];
  for (const k of keys) {
    const x = a.get(k);
    const y = b.get(k);
    if (JSON.stringify(x) === JSON.stringify(y)) continue;
    const label = PATH_LABELS[k] ?? k;
    lines.push({
      kind: x === undefined ? 'add' : y === undefined ? 'remove' : 'change',
      text: `${label}: ${fmt(x)} → ${fmt(y)}`,
      technical: `relays[${prev.id}].${k}: ${JSON.stringify(x)} → ${JSON.stringify(y)}`,
    });
  }
  return lines;
}
