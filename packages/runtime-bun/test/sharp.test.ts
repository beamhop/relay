// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  binaryPath,
  copySharp,
  parseBuildArgs,
  sharpPackages,
  sharpPlatform,
} from '../scripts/build.ts';
import { sharpCandidates, sharpLoader } from '../src/index.ts';
import { tempDir } from './helpers.ts';

const host = `${process.platform}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;

describe('sharp next to the single binary', () => {
  test('sharp is shipped by default; --no-sharp opts out', () => {
    expect(parseBuildArgs(['--host']).withSharp).toBe(true);
    expect(parseBuildArgs(['--host', '--with-sharp']).withSharp).toBe(true);
    expect(parseBuildArgs(['--host', '--no-sharp']).withSharp).toBe(false);
    const rel = parseBuildArgs(['--target', 'linux-x64,darwin-arm64', '--version', '1.2.3']);
    expect(rel.targets).toEqual(['linux-x64', 'darwin-arm64']);
    expect(rel.withSharp).toBe(true);
    expect(binaryPath('/o', 'linux-x64', true)).toBe('/o/linux-x64/beamhop');
    expect(binaryPath('/o', 'linux-x64', false)).toBe('/o/beamhop-linux-x64');
    expect(sharpPlatform('windows-x64')).toBe('win32-x64');
    expect(sharpPlatform('darwin-arm64')).toBe('darwin-arm64');
  });

  test('candidates: BEAMHOP_SHARP_PATH, then node_modules beside the executable', () => {
    expect(sharpCandidates({}, '/usr/local/bin/bun')).toEqual([]);
    expect(sharpCandidates({}, '/opt/beamhop/beamhop')).toEqual([
      { dir: '/opt/beamhop/node_modules/sharp', source: 'binary' },
    ]);
    expect(sharpCandidates({ BEAMHOP_SHARP_PATH: '/x/node_modules' }, '/usr/bin/node')).toEqual([
      { dir: '/x/node_modules/sharp', source: 'env' },
    ]);
    expect(sharpCandidates({ BEAMHOP_SHARP_PATH: '/x/node_modules/sharp' }, 'bun')[0]?.dir).toBe(
      '/x/node_modules/sharp',
    );
  });

  test('loader is only used when a sharp package exists there', async () => {
    const dir = tempDir('beamhop-sharp-');
    expect(sharpLoader({}, join(dir, 'beamhop'))).toBeUndefined();
    const pkg = join(dir, 'node_modules', 'sharp');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'sharp', main: 'index.js' }));
    writeFileSync(join(pkg, 'index.js'), 'module.exports = function fakeSharp() { return 42; };');
    const load = sharpLoader({}, join(dir, 'beamhop'));
    expect(load).toBeDefined();
    const mod = (await load?.()) as () => number;
    expect(mod()).toBe(42);
    // BEAMHOP_SHARP_PATH wins over the binary's directory.
    const viaEnv = sharpLoader({ BEAMHOP_SHARP_PATH: join(dir, 'node_modules') }, '/usr/bin/bun');
    expect(((await viaEnv?.()) as () => number)()).toBe(42);
  });

  test('--with-sharp copies the host platform packages into a loadable node_modules', async () => {
    const { dirs } = sharpPackages(host);
    if (!dirs.has(`@img/sharp-${host}`)) return; // sharp not installed for this host
    const out = tempDir('beamhop-dist-');
    expect(copySharp(host, out)).toEqual([]);
    expect(existsSync(join(out, 'node_modules/sharp/package.json'))).toBe(true);
    expect(existsSync(join(out, `node_modules/@img/sharp-${host}/package.json`))).toBe(true);
    expect(existsSync(join(out, `node_modules/@img/sharp-libvips-${host}/package.json`))).toBe(
      true,
    );
    const sharp = (await sharpLoader({}, join(out, 'beamhop'))?.()) as (input: Buffer) => {
      metadata(): Promise<{ width?: number }>;
    };
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    expect((await sharp(png).metadata()).width).toBe(1);
  });

  test('cross-target packages that are not installed are reported', () => {
    const other = host.startsWith('linux') ? 'darwin-arm64' : 'linux-x64';
    const { missing } = sharpPackages(other);
    if (missing.length === 0) return; // installed for every platform
    expect(missing).toContain(`@img/sharp-${other}`);
  });
});
