// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from 'zod';
import type { PluginManifest } from './types.ts';

/** Lowest pipeline priority a plugin can have: plugins run after built-in policies (0-299). */
export const PLUGIN_BAND = 300;
/** Plugin ids: lowercase, optionally npm-scoped (`@acme/name`), at most 63 characters. */
export const PLUGIN_ID_RE = /^(@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9._-]{0,62}$/;
/** `MAJOR.MINOR.PATCH` with an optional pre-release/build suffix. */
export const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * The manifest every plugin carries (built by `definePlugin`, re-checked by the host
 * and on manifests reported back by sandboxed plugins).
 */
export const ManifestSchema = z.object({
  id: z.string().regex(PLUGIN_ID_RE, 'lowercase letters, digits, dot, dash or underscore'),
  name: z.string().min(1).max(80),
  description: z.string().max(500),
  version: z.string().regex(SEMVER_RE, 'semver like 1.2.3'),
  permissions: z.array(z.enum(['read-events', 'write-events', 'network', 'docs'])).max(4),
  priority: z.number().int().min(PLUGIN_BAND).max(100_000),
});

/** Validate a manifest (also used on manifests reported back by sandboxed plugins). */
export function validateManifest(input: unknown): PluginManifest {
  const r = ManifestSchema.safeParse(input);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new Error(
      `Invalid plugin manifest: ${first ? `${first.path.join('.') || '(root)'} ${first.message}` : 'unknown error'}`,
    );
  }
  return { ...r.data, permissions: [...new Set(r.data.permissions)] };
}

export function clampPriority(p: number | undefined): number {
  if (p === undefined || !Number.isFinite(p)) return PLUGIN_BAND;
  return Math.max(PLUGIN_BAND, Math.floor(p));
}

/** `1.2.3` comparison (pre-release suffix ignored). */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]!.split('.').map(Number);
  const pb = b.split(/[-+]/)[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}
