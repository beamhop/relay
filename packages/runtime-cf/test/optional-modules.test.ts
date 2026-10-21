// SPDX-License-Identifier: AGPL-3.0-or-later
/** Optional (enterprise) modules on Workers: bundled, registered only while configured. */
import { describe, expect, test } from 'bun:test';
import { MODULE_MANAGER_SERVICE, type ModuleManager, defineModule } from '@beamhop/core';
import { setup } from './fakes.ts';

const companyModule = defineModule({
  id: 'enterprise-identity',
  optional: true,
  register(kernel) {
    kernel.http.get('/api/v1/sso/providers', (c) => c.json({ providers: [] }));
    kernel.ui.push({
      path: '/settings/company',
      title: 'Company sign-in',
      placement: 'settings-section',
      chunk: 'enterprise-identity',
    });
  },
});

describe('optional modules (Cloudflare)', () => {
  test('bundled optional module stays off until its config section appears, then hot-loads', async () => {
    const ctx = setup({ modules: [companyModule] });
    const providers = () =>
      ctx.runtime.worker.fetch(new Request('https://alpha.example/api/v1/sso/providers'), ctx.env);
    expect((await providers()).status).toBe(404);

    const { kernel } = await ctx.runtime.internals.workerContext(ctx.env);
    expect(kernel.isEnabled('enterprise-identity')).toBe(false);
    expect(kernel.ui).toEqual([]);
    const mgr = kernel.use<ModuleManager>(MODULE_MANAGER_SERVICE);
    expect(mgr?.list().map((s) => s.id)).toEqual(['enterprise-identity']);
    const section = await mgr?.defaultSection('enterprise-identity');
    expect(section).toEqual({ enabled: true });

    const cfg = kernel.config();
    await kernel.applyConfig({
      ...cfg,
      modules: { ...cfg.modules, 'enterprise-identity': section },
    });
    expect(kernel.isEnabled('enterprise-identity')).toBe(true);
    expect((await providers()).status).toBe(200);
    expect(kernel.ui.map((u) => u.path)).toEqual(['/settings/company']);

    await kernel.applyConfig(cfg);
    expect(kernel.isEnabled('enterprise-identity')).toBe(false);
    expect((await providers()).status).toBe(404);
    expect(kernel.ui).toEqual([]);
  });
});
