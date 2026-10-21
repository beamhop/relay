// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKernel, parseConfig } from '@beamhop/core';
import { memoryPorts } from '@beamhop/testkit';
import { generateEntry } from '../scripts/build.ts';
import {
  type TeamConfigHook,
  createTeamApp,
  registerAssets,
  teamClientConfig,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

async function kernelWith(team: Record<string, unknown> | undefined) {
  return createKernel({
    runtime: 'test',
    ports: memoryPorts(),
    config: parseConfig({
      relays: [{ id: 'main', hosts: ['*'] }],
      modules: team ? { team } : {},
    }),
    modules: [],
  });
}

function teamBuild(): string {
  const dir = tempDir('beamhop-team-');
  mkdirSync(join(dir, '_app/immutable'), { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<h1>team</h1>');
  writeFileSync(join(dir, '_app/immutable/app.js'), 'js');
  return dir;
}

const get = (path: string, accept = '*/*') =>
  new Request(`http://relay.test${path}`, { headers: { accept } });

describe('Team app at /app', () => {
  test('off by default: nothing is served', async () => {
    const kernel = await kernelWith(undefined);
    const app = createTeamApp(kernel, { dir: teamBuild() });
    expect(await app.serve(get('/app/'), '/app/')).toBeNull();
    expect(await app.serve(get('/app/config.json'), '/app/config.json')).toBeNull();
  });

  test('enabled: static files, SPA fallback and config.json from modules.team', async () => {
    const kernel = await kernelWith({
      enabled: true,
      homeRelay: 'wss://relay.example.com/',
      allowedRelays: ['wss://partner.example/', 3],
      features: { sso: true, directory: 'yes' },
    });
    const app = createTeamApp(kernel, { dir: teamBuild() });
    expect(app.assets.source).toBe('disk');
    expect(await (await app.serve(get('/app/'), '/app/'))?.text()).toBe('<h1>team</h1>');
    const js = await app.serve(get('/app/_app/immutable/app.js'), '/app/_app/immutable/app.js');
    expect(js?.headers.get('cache-control')).toContain('immutable');
    const nav = await app.serve(get('/app/spaces/x', 'text/html'), '/app/spaces/x');
    expect(await nav?.text()).toBe('<h1>team</h1>');
    expect((await app.serve(get('/app'), '/app'))?.status).toBe(308);
    expect(await app.serve(get('/apps'), '/apps')).toBeNull();

    const res = await app.serve(get('/app/config.json'), '/app/config.json');
    expect(res?.headers.get('content-type')).toBe('application/json');
    expect(await res?.json()).toEqual({
      homeRelay: 'wss://relay.example.com/',
      allowedRelays: ['wss://partner.example/'],
      features: { sso: true, directory: false, escrowNotice: false },
    });
  });

  test('team.config hook point lets enterprise modules adjust the config', async () => {
    const kernel = await kernelWith({ enabled: true });
    const seen: unknown[] = [];
    const hook: TeamConfigHook = (base, ctx) => {
      seen.push(ctx);
      return { ...base, features: { ...base.features, directory: true, escrowNotice: true } };
    };
    kernel.provide('team.config', hook);
    expect(await teamClientConfig(kernel, { relayId: 'main' })).toEqual({
      allowedRelays: [],
      features: { sso: false, directory: true, escrowNotice: true },
    });
    expect(seen).toEqual([{ relayId: 'main' }]);
    kernel.provide('team.config', (() => {
      throw new Error('boom');
    }) as TeamConfigHook);
    expect((await teamClientConfig(kernel)).features.directory).toBe(false);
  });

  test('embedded team bundle is separate from the admin bundle', async () => {
    const dir = teamBuild();
    registerAssets({ '/index.html': join(dir, 'index.html') }, 'team');
    const kernel = await kernelWith({ enabled: true });
    const app = createTeamApp(kernel);
    expect(app.assets.source).toBe('embedded');
    expect(await (await app.serve(get('/app/'), '/app/'))?.text()).toBe('<h1>team</h1>');
  });

  test('build entry embeds the team build as the team bundle', () => {
    const out = tempDir('beamhop-build-');
    const r = generateEntry(out, join(out, 'no-pwa'), teamBuild());
    expect(r.assets).toBe(0);
    expect(r.teamAssets).toBe(2);
    const src = readFileSync(r.entry, 'utf8');
    expect(src).toContain("}, 'team');");
    expect(src).toContain('"/_app/immutable/app.js": t');
  });
});
