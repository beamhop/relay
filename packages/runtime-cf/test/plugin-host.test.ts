// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { type Kernel, defineModule } from '@beamhop/core';
import { BUILTIN_PLUGINS, createBundledPluginHost } from '@beamhop/plugins';
import { BUILTIN_PLUGIN_IDS, generateImportMap } from '../src/bundle/import-map.ts';
import { TEST_CONFIG, setup } from './fakes.ts';

const installed = new Set(['@beamhop/relay', '@beamhop/plugins', 'beamhop-plugin-wot']);
const resolve = (pkg: string) => (installed.has(pkg) ? `./node_modules/${pkg}/index.ts` : null);

describe('generated entry with the bundled plugin host', () => {
  test('adds createBundledPluginHost(plugins) to modules and skips built-in plugin ids', () => {
    expect(BUILTIN_PLUGIN_IDS).toEqual(Object.keys(BUILTIN_PLUGINS));
    const r = generateImportMap({
      config: {
        plugins: [
          { id: 'wot', config: {} },
          { id: 'kind-allowlist', config: { kinds: [1] } },
          { id: 'keyword-filter', enabled: false, config: {} },
        ],
      },
      builtins: ['@beamhop/relay'],
      resolve,
      runtimeSpecifier: '@beamhop/runtime-cf',
    });
    expect(r.missing).toEqual([]);
    expect(r.pluginHost).toBe('./node_modules/@beamhop/plugins/index.ts');
    expect(r.plugins.map((p) => p.id)).toEqual(['wot']);
    expect(r.builtinPlugins).toEqual(['kind-allowlist']);
    expect(r.code).toContain(
      'import { createBundledPluginHost } from "./node_modules/@beamhop/plugins/index.ts";',
    );
    expect(r.code).toContain('  "wot": plugin0,');
    expect(r.code).toContain('  modules: [createBundledPluginHost(plugins)],');
    expect(r.code).not.toContain('beamhop-plugin-kind-allowlist');
    expect(r.code).not.toMatch(/^\s+plugins,$/m);
  });

  test('without @beamhop/plugins the old import map is kept (built-ins then must be installed)', () => {
    const r = generateImportMap({
      config: { plugins: [{ id: 'kind-allowlist', config: {} }] },
      builtins: [],
      resolve: (pkg) => (pkg === '@beamhop/plugins' ? null : resolve(pkg)),
      runtimeSpecifier: 'x',
    });
    expect(r.pluginHost).toBeNull();
    expect(r.missing).toEqual([{ id: 'kind-allowlist', pkg: 'beamhop-plugin-kind-allowlist' }]);
    expect(r.code).toContain('  plugins,');
  });
});

describe('runtime with the plugin host', () => {
  test('the host loads enabled plugins once; no “not bundled” warnings', async () => {
    let kernel: Kernel | undefined;
    const probe = defineModule({
      id: 'probe',
      register(k) {
        kernel = k;
      },
    });
    const ctx = setup({
      config: { ...TEST_CONFIG, plugins: [{ id: 'kind-allowlist', config: { kinds: [1] } }] },
      modules: [createBundledPluginHost({}), probe],
    });
    const res = await ctx.runtime.worker.fetch(new Request('https://alpha.example/x'), ctx.env);
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(kernel).toBeDefined();
    expect(ctx.logs.join('\n')).not.toContain('not bundled');
    expect(kernel?.actions.get('plugins.status')).toBeDefined();
    const host = kernel?.use<{ status(): Array<{ id: string; status: string }> }>('plugins');
    const row = host?.status().find((r) => r.id === 'kind-allowlist');
    expect(row?.status).toBe('running');
    // Registered by the host only (not also as `plugin.kind-allowlist` by the runtime).
    expect(kernel?.isEnabled('plugin.kind-allowlist')).toBe(false);
  });
});
