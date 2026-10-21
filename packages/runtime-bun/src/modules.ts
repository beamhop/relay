// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Default module set for the Bun binary. Feature packages are loaded by dynamic
 * import so a missing/unfinished package never prevents boot. Any export that
 * looks like a `BeamhopModule` (id + register) is collected.
 *
 * Isolation (§12.0): opt-in packages only contribute modules whose id appears
 * under `config.modules`.
 */
import type { BeamhopConfig, BeamhopModule, Logger } from '@beamhop/core';

export interface ModulePackage {
  name: string;
  /** Literal dynamic import so `bun build --compile` bundles the package. */
  load: () => Promise<Record<string, unknown>>;
  /** Load only if this returns true. */
  when?: (config: BeamhopConfig) => boolean;
  /** Only register modules whose id is a key of `config.modules`. */
  optIn?: boolean;
}

export const DEFAULT_MODULE_PACKAGES: ModulePackage[] = [
  { name: '@beamhop/policy', load: () => import('@beamhop/policy') },
  { name: '@beamhop/relay', load: () => import('@beamhop/relay') },
  {
    name: '@beamhop/blossom',
    load: () => import('@beamhop/blossom'),
    when: (c) => c.relays.some((r) => r.blossom.enabled),
  },
  { name: '@beamhop/admin-api', load: () => import('@beamhop/admin-api') },
  { name: '@beamhop/insights', load: () => import('@beamhop/insights') },
  { name: '@beamhop/alerts', load: () => import('@beamhop/alerts') },
  { name: '@beamhop/lifecycle', load: () => import('@beamhop/lifecycle') },
  { name: '@beamhop/experience', load: () => import('@beamhop/experience') },
  { name: '@beamhop/public-web', load: () => import('@beamhop/public-web') },
  { name: '@beamhop/media', load: () => import('@beamhop/media') },
  { name: '@beamhop/ai', load: () => import('@beamhop/ai'), when: (c) => c.ai.enabled },
  // Plugin host + webhooks. Always loaded so admins can browse/install plugins;
  // with no enabled plugins and no webhooks it adds nothing to the hot path.
  // `--safe` disables every plugin via config, so the host loads none.
  { name: '@beamhop/plugins/bun', load: () => import('@beamhop/plugins/bun') },
  {
    name: '@beamhop/enterprise-identity',
    load: () => import('@beamhop/enterprise-identity'),
    optIn: true,
  },
  {
    name: '@beamhop/enterprise-keyvault',
    load: () => import('@beamhop/enterprise-keyvault'),
    optIn: true,
  },
  {
    name: '@beamhop/enterprise-compliance',
    load: () => import('@beamhop/enterprise-compliance'),
    optIn: true,
  },
];

export function isModule(v: unknown): v is BeamhopModule {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as BeamhopModule).id === 'string' &&
    typeof (v as BeamhopModule).register === 'function'
  );
}

export async function loadModules(
  config: BeamhopConfig,
  logger: Logger,
  packages: ModulePackage[] = DEFAULT_MODULE_PACKAGES,
): Promise<BeamhopModule[]> {
  const out = new Map<string, BeamhopModule>();
  for (const pkg of packages) {
    if (pkg.when && !pkg.when(config)) continue;
    let mod: Record<string, unknown>;
    try {
      mod = await pkg.load();
    } catch (err) {
      logger.log('warn', 'feature package not available', { package: pkg.name, err });
      continue;
    }
    for (const value of Object.values(mod)) {
      if (!isModule(value) || out.has(value.id)) continue;
      if (pkg.optIn && !(value.id in config.modules)) continue;
      out.set(value.id, value);
    }
  }
  // Drop modules whose dependencies are missing instead of failing the whole boot.
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of out.values()) {
      const missing = (m.dependsOn ?? []).filter((d) => !out.has(d));
      if (missing.length) {
        logger.log('warn', 'module skipped: missing dependency', { module: m.id, missing });
        out.delete(m.id);
        changed = true;
      }
    }
  }
  return [...out.values()];
}
