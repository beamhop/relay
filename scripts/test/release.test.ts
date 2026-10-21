// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Release tooling: manifest/checksum format, and an end-to-end check that the real
 * `beamhop update` code accepts what release.ts produces (file:// URLs, no network).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { updateCommand } from '../../packages/cli/src/commands/update.ts';
import { BufferIo } from '../../packages/cli/src/io.ts';
import {
  archiveName,
  assetName,
  buildManifest,
  checksumsText,
  collectTargetDirs,
  defaultBaseUrl,
  parseReleaseArgs,
  release,
} from '../release.ts';

const root = mkdtempSync(join(tmpdir(), 'beamhop-release-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const fake = (v: string) => `#!/bin/sh\necho ${v}\n`;

describe('release.ts', () => {
  test('asset names and checksum lines', () => {
    expect(assetName('linux-x64')).toBe('beamhop-linux-x64');
    expect(assetName('windows-x64')).toBe('beamhop-windows-x64.exe');
    expect(checksumsText({ b: '22', a: '11' })).toBe('11  a\n22  b\n');
    expect(defaultBaseUrl('1.0.0')).toBe(
      'https://github.com/beamhop/beamhop/releases/download/v1.0.0',
    );
  });

  test('manifest matches the CLI format', () => {
    const m = buildManifest({
      version: '1.2.3',
      notes: '  Faster.  ',
      baseUrl: 'https://x/',
      assets: [
        { target: 'linux-x64', file: 'beamhop-linux-x64', sha256: 'ab', signature: 'sig' },
        { target: 'darwin-arm64', file: 'beamhop-darwin-arm64', sha256: 'cd' },
      ],
    });
    expect(m).toEqual({
      version: '1.2.3',
      notes: 'Faster.',
      assets: {
        'linux-x64': { url: 'https://x/beamhop-linux-x64', sha256: 'ab', signature: 'sig' },
        'darwin-arm64': { url: 'https://x/beamhop-darwin-arm64', sha256: 'cd' },
      },
    });
  });

  test('parses args and rejects non-semver versions', () => {
    expect(parseReleaseArgs(['--version', 'v1.0.0-rc.1']).version).toBe('1.0.0-rc.1');
    expect(parseReleaseArgs([], { GITHUB_REF_NAME: 'v2.0.0' }).version).toBe('2.0.0');
    expect(() => parseReleaseArgs(['--version', 'main'])).toThrow('semver');
  });

  test('a --skip-build release is installable by `beamhop update`', async () => {
    const out = join(root, 'rel');
    const dir = join(out, 'v0.5.0');
    mkdirSync(dir, { recursive: true });
    const targets = ['linux-x64', 'test-os'];
    for (const t of targets) writeFileSync(join(dir, assetName(t)), fake('0.5.0'));
    const res = await release(
      {
        version: '0.5.0',
        targets,
        outDir: out,
        baseUrl: `file://${dir}`,
        notes: 'Hello',
        skipBuild: true,
      },
      undefined,
    );
    expect(res.files).toEqual([
      'SHA256SUMS',
      'beamhop-linux-x64',
      'beamhop-test-os',
      'latest.json',
    ]);
    const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8');
    expect(sums).toContain('  beamhop-test-os\n');

    // Real update code, real fetch over file:// URLs.
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });
    const bin = join(home, 'beamhop');
    writeFileSync(bin, fake('0.4.0'), { mode: 0o755 });
    const io = new BufferIo();
    const ctx = {
      io,
      env: { HOME: home },
      cwd: home,
      home,
      fetch: (i: string | URL | Request, init?: RequestInit) => fetch(i, init),
      now: () => Date.now(),
      execPath: bin,
    };
    const code = await updateCommand(
      ctx as never,
      ['--manifest', `file://${join(out, 'latest.json')}`],
      {},
      { platform: 'test-os', currentVersion: '0.4.0', serverUrl: async () => null },
    );
    expect(io.stderr).toBe('');
    expect(code).toBe(0);
    expect(readFileSync(bin, 'utf8')).toBe(fake('0.5.0'));
    expect(io.stdout).toContain('Installed 0.5.0');
  });

  test('sharp ships in the standard download: <target>/ folders become archive + bare binary', async () => {
    const out = join(root, 'sharp-rel');
    const dir = join(out, 'v0.6.0');
    // As the build script leaves it: one target with sharp, one without (cross-compiled).
    mkdirSync(join(dir, 'linux-x64', 'node_modules', 'sharp'), { recursive: true });
    writeFileSync(join(dir, 'linux-x64', 'beamhop'), fake('0.6.0'));
    writeFileSync(join(dir, 'linux-x64', 'node_modules', 'sharp', 'package.json'), '{}');
    writeFileSync(join(dir, 'linux-x64', 'beamhop.map'), '{}');
    mkdirSync(join(dir, 'test-os'), { recursive: true });
    writeFileSync(join(dir, 'test-os', 'beamhop'), fake('0.6.0'));
    collectTargetDirs(dir, ['linux-x64', 'test-os']);
    expect(existsSync(join(dir, 'linux-x64'))).toBe(false);
    expect(readFileSync(join(dir, assetName('linux-x64')), 'utf8')).toBe(fake('0.6.0'));
    expect(existsSync(join(dir, archiveName('test-os')))).toBe(false);
    const list = Bun.spawnSync([
      'tar',
      '-tzf',
      join(dir, archiveName('linux-x64')),
    ]).stdout.toString();
    expect(list).toContain('beamhop');
    expect(list).toContain('node_modules/sharp/package.json');
    expect(list).not.toContain('.map');
    expect(existsSync(join(dir, 'linux-x64-beamhop.map'))).toBe(true);
    const res = await release(
      {
        version: '0.6.0',
        targets: ['linux-x64', 'test-os'],
        outDir: out,
        baseUrl: 'https://x',
        skipBuild: true,
      },
      undefined,
    );
    expect(res.files).toContain('beamhop-linux-x64.tar.gz');
    const sums = readFileSync(join(dir, 'SHA256SUMS'), 'utf8');
    expect(sums).toContain('  beamhop-linux-x64.tar.gz\n');
    expect(sums).toContain('  beamhop-linux-x64\n');
    expect(res.manifest.assets['linux-x64']?.url).toBe('https://x/beamhop-linux-x64');
  });
});
