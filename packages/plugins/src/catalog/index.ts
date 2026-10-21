// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Signed plugin catalog (§9).
 *
 * Wire format: a Nostr event (NIP-01) of kind 30078 ("application data",
 * NIP-78) with tag `["d", "beamhop-plugin-catalog"]`; `content` is the catalog
 * JSON below. The event's Schnorr signature authenticates the list, and the
 * signer must be one of `modules.plugins.catalogPubkeys`. Every entry pins a
 * package version and an integrity hash, so the tarball is verified too.
 */
import { type NostrEvent, finalizeEvent, tagValue, verifyEvent } from '@beamhop/core';
import { z } from 'zod';
import { PLUGIN_ID_RE } from '../sdk/manifest.ts';

export const CATALOG_KIND = 30078;
export const CATALOG_D_TAG = 'beamhop-plugin-catalog';
/** Package prefix for plugins compiled into Beamhop itself. */
export const BUILTIN_PREFIX = 'builtin:';

export const CatalogEntrySchema = z.object({
  id: z.string().regex(PLUGIN_ID_RE),
  name: z.string().max(80).optional(),
  package: z.string().min(1),
  version: z.string().min(1),
  /** Subresource-integrity string, e.g. `sha512-<base64>` (npm style). */
  integrity: z.string().optional(),
  /** Alternative: hex sha256 of the tarball. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Tarball URL (default: npm registry URL for package@version). */
  tarball: z.string().url().optional(),
  description: z.string().max(500).default(''),
  permissions: z.array(z.enum(['read-events', 'write-events', 'network', 'docs'])).default([]),
  /** Minimum Beamhop version. */
  minBeamhop: z.string().default('0.0.0'),
});
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

export const CatalogSchema = z.object({
  version: z.literal(1).default(1),
  name: z.string().optional(),
  updatedAt: z.number().int().optional(),
  plugins: z.array(CatalogEntrySchema).default([]),
});
export type Catalog = z.infer<typeof CatalogSchema>;

export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

/** Sign a catalog as a kind-30078 event (for catalog publishers / tests). */
export function signCatalog(
  catalog: Catalog,
  secretKeyHex: string,
  createdAt?: number,
): NostrEvent {
  const parsed = CatalogSchema.parse(catalog);
  return finalizeEvent(
    {
      kind: CATALOG_KIND,
      created_at: createdAt ?? Math.floor(Date.now() / 1000),
      tags: [['d', CATALOG_D_TAG]],
      content: JSON.stringify(parsed),
    },
    secretKeyHex,
  );
}

/**
 * Verify a signed catalog event: valid id + Schnorr signature, right kind and
 * d-tag, signed by a trusted key, and well-formed content.
 */
export function verifyCatalogEvent(input: unknown, trustedPubkeys: readonly string[]): Catalog {
  const ev = input as NostrEvent;
  if (!ev || typeof ev !== 'object' || typeof ev.sig !== 'string') {
    throw new CatalogError('The catalog is not a signed Nostr event');
  }
  if (ev.kind !== CATALOG_KIND || tagValue(ev, 'd') !== CATALOG_D_TAG) {
    throw new CatalogError('The catalog has the wrong event kind or d-tag');
  }
  let ok = false;
  try {
    ok = verifyEvent(ev);
  } catch {
    ok = false;
  }
  if (!ok) throw new CatalogError('The catalog signature is not valid');
  if (!trustedPubkeys.includes(ev.pubkey)) {
    throw new CatalogError('The catalog is signed by a key you have not trusted');
  }
  let json: unknown;
  try {
    json = JSON.parse(ev.content);
  } catch {
    throw new CatalogError('The catalog content is not JSON');
  }
  const r = CatalogSchema.safeParse(json);
  if (!r.success) throw new CatalogError(`The catalog is malformed: ${r.error.issues[0]?.message}`);
  return r.data;
}

/** Fetch and verify a remote catalog. */
export async function fetchCatalog(
  url: string,
  trustedPubkeys: readonly string[],
  fetchFn: typeof fetch = fetch,
): Promise<Catalog> {
  if (trustedPubkeys.length === 0) {
    throw new CatalogError('Add at least one trusted catalog key before using a remote catalog');
  }
  const res = await fetchFn(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new CatalogError(`The catalog could not be downloaded (HTTP ${res.status})`);
  return verifyCatalogEvent(await res.json(), trustedPubkeys);
}

// ── Integrity ──

const SRI_ALGS: Record<string, string> = {
  sha256: 'SHA-256',
  sha384: 'SHA-384',
  sha512: 'SHA-512',
};

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Compute an SRI string (`sha512-…`) for bytes. */
export async function computeIntegrity(
  data: Uint8Array,
  alg: 'sha256' | 'sha384' | 'sha512' = 'sha512',
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(SRI_ALGS[alg]!, data as Uint8Array<ArrayBuffer>),
  );
  return `${alg}-${toBase64(digest)}`;
}

/** Throws CatalogError unless `data` matches the entry's `integrity` and/or `sha256`. */
export async function verifyIntegrity(
  data: Uint8Array,
  entry: Pick<CatalogEntry, 'integrity' | 'sha256'>,
): Promise<void> {
  if (!entry.integrity && !entry.sha256) {
    throw new CatalogError('The catalog entry has no integrity hash; refusing to install');
  }
  if (entry.sha256) {
    const d = new Uint8Array(
      await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>),
    );
    if (toHex(d) !== entry.sha256) {
      throw new CatalogError('The downloaded package does not match its expected fingerprint');
    }
  }
  if (entry.integrity) {
    // SRI may list several hashes; any supported one that matches is enough.
    const parts = entry.integrity.trim().split(/\s+/);
    let checked = false;
    for (const p of parts) {
      const m = /^(sha256|sha384|sha512)-(.+)$/.exec(p);
      if (!m) continue;
      checked = true;
      if ((await computeIntegrity(data, m[1] as 'sha512')) === `${m[1]}-${m[2]}`) return;
    }
    throw new CatalogError(
      checked
        ? 'The downloaded package does not match its expected fingerprint'
        : 'The catalog entry uses an unsupported integrity format',
    );
  }
}

/** Default npm tarball URL for `pkg@version`. */
export function npmTarballUrl(pkg: string, version: string): string {
  const base = pkg.startsWith('@') ? pkg.split('/')[1]! : pkg;
  return `https://registry.npmjs.org/${pkg}/-/${base}-${version}.tgz`;
}

/** Merge catalogs (first wins per id). */
export function mergeCatalogs(...catalogs: Catalog[]): CatalogEntry[] {
  const out = new Map<string, CatalogEntry>();
  for (const c of catalogs) for (const e of c.plugins) if (!out.has(e.id)) out.set(e.id, e);
  return [...out.values()];
}
