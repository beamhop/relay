// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Every screen the server links to must be a real admin-app route
 * (packages/pwa/src/routes), so checklist and "why?" links never 404.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PWA_ROUTES, buildChecklist, simpleScreens } from '../src/index.ts';
import { setup } from './helpers.ts';

const ROUTES_DIR = join(import.meta.dir, '../../pwa/src/routes');

/** Static PWA routes ('/settings/goals') and dynamic ones ('/settings/[section]'). */
function pwaRoutes(): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}/${e.name}`);
      else if (e.name === '+page.svelte') out.push(prefix || '/');
    }
  };
  walk(ROUTES_DIR, '');
  return out;
}

/** Settings sections the `[section]` route knows (simple screens + the limits screen). */
function settingsSections(): Set<string> {
  const ids = new Set(simpleScreens.map((s) => s.id));
  const src = readFileSync(join(ROUTES_DIR, '../lib/settings/sections.ts'), 'utf8');
  for (const m of src.matchAll(/id: '([a-z-]+)'/g)) ids.add(m[1] as string);
  return ids;
}

function isRealRoute(screen: string, routes = pwaRoutes(), sections = settingsSections()) {
  const path = screen.split('?')[0] as string;
  if (routes.includes(path)) return true;
  const m = /^\/settings\/([a-z-]+)$/.exec(path);
  return !!m && routes.includes('/settings/[section]') && sections.has(m[1] as string);
}

describe('server links point at real admin-app routes', () => {
  test('PWA_ROUTES and the checklist', async () => {
    for (const r of Object.values(PWA_ROUTES)) expect([r, isRealRoute(r)]).toEqual([r, true]);
    const { kernel } = await setup();
    const c = await buildChecklist(kernel);
    for (const i of c.items) {
      expect([i.id, isRealRoute(i.link.screen)]).toEqual([i.id, true]);
      expect(i.link.screen).not.toContain('launch-kit');
    }
    const test = c.items.find((i) => i.id === 'test-relay');
    expect(test?.link.related?.[0]?.actionId).toBe('experience.launch-kit');
    expect(kernel.actions.get('experience.launch-kit')).toBeDefined();
  });

  test('“why?” option screens', () => {
    const src = readFileSync(join(import.meta.dir, '../src/why.ts'), 'utf8');
    const screens = [...src.matchAll(/screen: '([^']+)'/g)].map((m) => m[1] as string);
    expect(screens.length).toBeGreaterThan(5);
    for (const s of screens) expect([s, isRealRoute(s)]).toEqual([s, true]);
  });
});
