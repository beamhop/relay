// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Default module set for the Bun binary. Feature packages are loaded by dynamic
 * import so a missing/unfinished package never prevents boot. Any export that
 * looks like a `BeamhopModule` (id + register) is collected.
 *
 * Isolation (§12.0): opt-in packages only contribute modules whose id appears
 * under `config.modules`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BeamhopConfig, BeamhopModule, Logger, OptionalModuleSource } from '@beamhop/core';

/** What a runtime knows when it builds the default config section of an optional module. */
export interface OptionalModuleContext {
  /** `<dataDir>/secrets` (mode 0700). */
  secretsDir: string;
  env: Record<string, string | undefined>;
}

export interface OptionalModuleDef {
  /** Module id (= `config.modules` key). */
  id: string;
  /** Minimal valid section written by `modules.enable` (default `{}`). */
  defaultSection?(ctx: OptionalModuleContext): Promise<Record<string, unknown>>;
}

export interface ModulePackage {
  name: string;
  /** Literal dynamic import so `bun build --compile` bundles the package. */
  load: () => Promise<Record<string, unknown>>;
  /** Load only if this returns true. */
  when?: (config: BeamhopConfig) => boolean;
  /** Only register modules whose id is a key of `config.modules`. */
  optIn?: boolean;
  /** Opt-in modules of this package that can be turned on/off while running (§12.0). */
  optional?: OptionalModuleDef[];
}

/** Env var holding the key vault's local master key; without it a key file is generated. */
export const MASTER_KEY_ENV = 'BEAMHOP_MASTER_KEY';
/** Generated master key file name inside `<dataDir>/secrets`. */
export const MASTER_KEY_FILE = 'master.key';

/**
 * Key vault default: the local master key from `BEAMHOP_MASTER_KEY` when set; otherwise a
 * 32-byte random key generated once into `<dataDir>/secrets/master.key` (mode 0600) and
 * referenced as `kek.keyFile`. Back that file up: without it company-held keys are lost.
 */
export async function keyvaultDefaultSection(
  ctx: OptionalModuleContext,
): Promise<Record<string, unknown>> {
  if (ctx.env[MASTER_KEY_ENV]) return { kek: { provider: 'local', keyEnv: MASTER_KEY_ENV } };
  const path = ensureMasterKeyFile(ctx.secretsDir);
  return { kek: { provider: 'local', keyFile: path } };
}

/** Create `<secretsDir>/master.key` (base64, 32 random bytes, 0600) unless it exists. */
export function ensureMasterKeyFile(secretsDir: string): string {
  const path = join(secretsDir, MASTER_KEY_FILE);
  if (existsSync(path) && readFileSync(path, 'utf8').trim()) return path;
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  return path;
}

export const DEFAULT_MODULE_PACKAGES: ModulePackage[] = [
  // First, so its HTTP tracing middleware wraps every route. Only with `modules.otel`.
  { name: '@beamhop/otel', load: () => import('@beamhop/otel'), optIn: true },
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
    // `{ enabled: true }`: a non-empty section marks it configured (isolation guard).
    optional: [{ id: 'enterprise-identity', defaultSection: async () => ({ enabled: true }) }],
  },
  {
    name: '@beamhop/enterprise-keyvault',
    load: () => import('@beamhop/enterprise-keyvault'),
    optIn: true,
    optional: [{ id: 'enterprise-keyvault', defaultSection: keyvaultDefaultSection }],
  },
  {
    name: '@beamhop/enterprise-compliance',
    load: () => import('@beamhop/enterprise-compliance'),
    optIn: true,
    optional: [{ id: 'enterprise-compliance' }, { id: 'enterprise-network' }],
  },
];

/**
 * Hot-loadable optional modules (`manageOptionalModules` sources) from the package
 * list: loading imports the package and picks the export with that module id.
 */
export function optionalModuleSources(
  ctx: OptionalModuleContext,
  logger: Logger,
  packages: ModulePackage[] = DEFAULT_MODULE_PACKAGES,
): OptionalModuleSource[] {
  const out: OptionalModuleSource[] = [];
  for (const pkg of packages) {
    for (const def of pkg.optional ?? []) {
      const src: OptionalModuleSource = {
        id: def.id,
        async load() {
          let mod: Record<string, unknown>;
          try {
            mod = await pkg.load();
          } catch (err) {
            logger.log('warn', 'feature package not available', { package: pkg.name, err });
            return undefined;
          }
          const values = ['default' in mod ? mod.default : undefined, ...Object.values(mod)];
          return values.find((v): v is BeamhopModule => isModule(v) && v.id === def.id);
        },
      };
      const make = def.defaultSection;
      if (make) src.defaultSection = () => make(ctx);
      out.push(src);
    }
  }
  return out;
}

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
