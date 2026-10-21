// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { parseConfig } from '@beamhop/core';
import { generateImportMap, pluginPackageName } from '../src/bundle/import-map.ts';
import { isModule, pluginModule, resolveModules } from '../src/plugins.ts';

const installed = new Set(['@beamhop/relay', 'beamhop-plugin-wot', '@acme/spam-pack']);
const resolve = (pkg: string) => (installed.has(pkg) ? `./node_modules/${pkg}/index.ts` : null);

describe('import map generation', () => {
  test('package names for plugin ids', () => {
    expect(pluginPackageName('wot')).toBe('beamhop-plugin-wot');
    expect(pluginPackageName('@acme/spam-pack')).toBe('@acme/spam-pack');
  });

  test('static imports for built-ins and enabled plugins only', () => {
    const r = generateImportMap({
      config: {
        relays: [{ id: 'main', hosts: ['relay.example'] }],
        plugins: [
          { id: 'wot', enabled: true, config: { depth: 2 } },
          { id: '@acme/spam-pack', config: {} },
          { id: 'disabled-one', enabled: false, config: {} },
        ],
      },
      builtins: ['@beamhop/relay', '@beamhop/blossom'],
      resolve,
      runtimeSpecifier: '@beamhop/runtime-cf',
    });
    expect(r.missing).toEqual([]);
    expect(r.skipped).toEqual(['@beamhop/blossom']);
    expect(r.plugins.map((p) => p.id)).toEqual(['wot', '@acme/spam-pack']);
    expect(r.code).toContain('import { createCloudflareRuntime } from "@beamhop/runtime-cf";');
    expect(r.code).toContain('import * as builtin0 from "./node_modules/@beamhop/relay/index.ts";');
    expect(r.code).toContain(
      'import * as plugin0 from "./node_modules/beamhop-plugin-wot/index.ts";',
    );
    expect(r.code).toContain('import * as plugin1 from "./node_modules/@acme/spam-pack/index.ts";');
    expect(r.code).not.toContain('beamhop-plugin-disabled-one');
    expect(r.code).toContain('export class RelayRoom extends runtime.RelayRoom {}');
    expect(r.code).toContain('export default runtime.worker;');
    expect(r.code).not.toMatch(/\beval\(|new Function|import\(/);
    // Config is inlined and validated.
    expect(r.code).toContain('"relay.example"');
  });

  test('missing enabled plugin is reported', () => {
    const r = generateImportMap({
      config: { plugins: [{ id: 'ghost', config: null }] },
      builtins: [],
      resolve,
      runtimeSpecifier: 'x',
    });
    expect(r.missing).toEqual([{ id: 'ghost', pkg: 'beamhop-plugin-ghost' }]);
  });
});

describe('bundled module resolution', () => {
  const hooks = { id: 'plugin.kw', priority: 300, onEvent: () => ({ action: 'accept' as const }) };

  test('module, policy hooks and factory exports', () => {
    const mod = { id: 'wot-module', register() {} };
    expect(pluginModule('wot', { default: mod }, {})).toBe(mod);
    const wrapped = pluginModule('kw', { hooks }, {});
    expect(isModule(wrapped)).toBe(true);
    expect(wrapped?.id).toBe('plugin.kw');
    const fromFactory = pluginModule(
      'f',
      { default: (c: { p: number }) => ({ ...hooks, priority: c.p }) },
      { p: 301 },
    );
    expect(fromFactory?.id).toBe('plugin.f');
    expect(pluginModule('none', { x: 1 }, {})).toBeNull();
  });

  test('runtime-disabled plugins are skipped; builtins collected and deduped', () => {
    const relay = { id: 'relay', register() {} };
    const warnings: string[] = [];
    const mods = resolveModules(
      {
        builtins: {
          '@beamhop/relay': { default: relay, relayModule: relay },
          '@beamhop/empty': {},
        },
        plugins: { kw: { default: hooks }, off: { default: hooks } },
      },
      parseConfig({
        plugins: [
          { id: 'kw', config: {} },
          { id: 'off', enabled: false, config: {} },
          { id: 'unbundled', config: {} },
        ],
      }),
      (m) => warnings.push(m),
    );
    expect(mods.map((m) => m.id)).toEqual(['relay', 'plugin.kw']);
    expect(warnings.length).toBe(2);
  });
});
