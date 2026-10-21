#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * beamhop-cf-build: generate the Worker entry (static import map of built-in
 * packages and enabled plugins) for `wrangler deploy`.
 *
 *   bun packages/runtime-cf/src/bundle/cli.ts \
 *     --config beamhop.config.json --out build/entry.ts [--project .] [--builtins a,b] [--enterprise]
 *
 * Enterprise packages are bundled when configured (`modules.enterprise-*`), or all of them
 * with `--enterprise` so they can be switched on later from the admin app.
 *
 * Packages are resolved from the project directory first, then from this package
 * (so the monorepo scaffold in deploy/cloudflare works without being a workspace).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_BUILTINS, generateImportMap } from './import-map.ts';

const { values } = parseArgs({
  options: {
    config: { type: 'string', default: 'beamhop.config.json' },
    out: { type: 'string', default: 'build/entry.ts' },
    project: { type: 'string', default: '.' },
    builtins: { type: 'string' },
    enterprise: { type: 'boolean', default: false },
  },
});

const projectDir = resolve(values.project as string);
const outFile = resolve(projectDir, values.out as string);
const configPath = resolve(projectDir, values.config as string);
const runtimeDir = resolve(import.meta.dir, '..', '..');

let config: unknown = {};
if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, 'utf8'));
else console.warn(`[beamhop] ${configPath} not found; using defaults`);

function toSpecifier(file: string): string {
  let rel = relative(dirname(outFile), file).split(sep).join('/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

function resolvePkg(pkg: string): string | null {
  for (const from of [projectDir, runtimeDir]) {
    try {
      return toSpecifier(Bun.resolveSync(pkg, from));
    } catch {
      // try next
    }
  }
  return null;
}

const result = generateImportMap({
  config,
  builtins: values.builtins
    ? (values.builtins as string)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : DEFAULT_BUILTINS,
  resolve: resolvePkg,
  enterprise: values.enterprise === true,
  runtimeSpecifier: toSpecifier(resolve(runtimeDir, 'src', 'index.ts')),
});

for (const pkg of result.skipped) console.warn(`[beamhop] built-in ${pkg} not installed; skipped`);
if (result.missing.length > 0) {
  for (const m of result.missing) {
    console.error(`[beamhop] plugin "${m.id}" is enabled but ${m.pkg} is not installed`);
  }
  process.exit(1);
}
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, result.code);
if (!result.pluginHost)
  console.warn('[beamhop] @beamhop/plugins not installed; plugins load without the plugin host');
console.log(
  `[beamhop] wrote ${relative(process.cwd(), outFile)}: ${result.builtins.length} built-ins, ${result.plugins.length} plugins${result.builtinPlugins.length ? ` (+${result.builtinPlugins.length} built-in)` : ''}`,
);
