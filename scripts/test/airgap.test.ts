// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Air-gap bundle end to end, offline: bundle from fake binaries → extract → install.sh from
 * file:// → `beamhop update --manifest file://…` with the real CLI code. Also checks that the
 * air-gap config is valid Beamhop config and turns ACME off.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { updateCommand } from '../../packages/cli/src/commands/update.ts';
import { BufferIo } from '../../packages/cli/src/io.ts';
import { parseConfig } from '../../packages/core/src/index.ts';
import { airgapBundle, airgapConfig, parseAirgapArgs, sharpPackages } from '../airgap-bundle.ts';

const root = mkdtempSync(join(tmpdir(), 'beamhop-airgap-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const fake = (v: string) => `#!/bin/sh\necho ${v}\n`;

describe('airgap-bundle.ts', () => {
  test('air-gap config is valid and keeps everything local', () => {
    const yaml = airgapConfig('file:///opt/beamhop/bundle', '1.0.0');
    const cfg = parseConfig(Bun.YAML.parse(yaml));
    expect(cfg.node.tls.mode).toBe('proxy');
    expect(cfg.ai.enabled).toBe(false);
    expect(cfg.ai.baseUrl).toContain('ollama');
    expect((cfg.modules.updates as { manifestUrl: string }).manifestUrl).toBe(
      'file:///opt/beamhop/bundle/releases/latest.json',
    );
    expect(yaml).not.toMatch(/https:\/\//);
  });

  test('sharp platform packages follow sharp’s pinned versions', () => {
    const pkg = {
      version: '0.35.5',
      optionalDependencies: {
        '@img/sharp-linux-x64': '0.35.5',
        '@img/sharp-libvips-linux-x64': '1.3.4',
        '@img/sharp-win32-x64': '0.35.5',
      },
    };
    expect(sharpPackages('linux-x64', pkg)).toEqual([
      { name: '@img/sharp-linux-x64', version: '0.35.5' },
      { name: '@img/sharp-libvips-linux-x64', version: '1.3.4' },
    ]);
    expect(sharpPackages('windows-x64', pkg)).toEqual([
      { name: '@img/sharp-win32-x64', version: '0.35.5' },
    ]);
  });

  test('bundle → extract → install → offline update', async () => {
    // Fake release 1.1.0 for the bundle.
    const rel = join(root, 'rel');
    mkdirSync(rel, { recursive: true });
    for (const t of ['linux-x64', 'test-os'])
      writeFileSync(join(rel, `beamhop-${t}`), fake('1.1.0'));
    const site = join(root, 'site'); // where the bundle will be extracted ("/opt/beamhop/bundle")
    const args = parseAirgapArgs([
      '--version',
      '1.1.0',
      '--target',
      'linux-x64,test-os',
      '--release-dir',
      rel,
      '--base-url',
      `file://${site}`,
      '--pwa-dir',
      join(root, 'missing-pwa'),
      '--team-dir',
      join(root, 'missing-team'),
      '--no-sharp',
      '--out',
      join(root, 'out'),
    ]);
    const res = await airgapBundle(args, undefined);
    expect(existsSync(res.tarball)).toBe(true);
    expect(readFileSync(`${res.tarball}.sha256`, 'utf8')).toContain(res.sha256);
    for (const f of [
      'releases/latest/beamhop-linux-x64',
      'releases/latest/SHA256SUMS',
      'releases/latest.json',
      'install.sh',
      'config/beamhop.yaml',
      'plugins/catalog.json',
      'litestream/README.md',
      'media/README.md',
      'web/admin/NOT-INCLUDED.txt',
      'ha/failover.sh',
      'BUNDLE.json',
      'README.txt',
    ])
      expect(res.files).toContain(f);

    // Extract like the docs say, verify checksums.
    mkdirSync(site, { recursive: true });
    const x = Bun.spawnSync(['tar', '-xzf', res.tarball, '-C', site, '--strip-components=1']);
    expect(x.exitCode).toBe(0);
    const sumTool = Bun.which('sha256sum') ? ['sha256sum', '-c'] : ['shasum', '-a', '256', '-c'];
    const check = Bun.spawnSync([...sumTool, 'SHA256SUMS'], { cwd: site });
    expect(check.stderr.toString()).toBe('');
    expect(check.exitCode).toBe(0);

    // Install from the extracted bundle (no network).
    const prefix = join(root, 'bin');
    const inst = Bun.spawnSync(
      ['sh', join(site, 'install.sh'), '--base-url', `file://${site}/releases`, '--prefix', prefix],
      {
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: root,
          TMPDIR: root,
          BEAMHOP_OS: 'linux',
          BEAMHOP_ARCH: 'x64',
        },
      },
    );
    expect(inst.stderr.toString()).toBe('');
    expect(inst.stdout.toString()).toContain('Installed Beamhop 1.1.0');

    // Offline update: an older binary updates from the bundle's manifest.
    const bin = join(root, 'old/beamhop');
    mkdirSync(join(root, 'old'), { recursive: true });
    writeFileSync(bin, fake('1.0.0'), { mode: 0o755 });
    const io = new BufferIo();
    const ctx = {
      io,
      env: { HOME: root },
      cwd: root,
      home: root,
      fetch: (i: string | URL | Request, init?: RequestInit) => fetch(i, init),
      now: () => Date.now(),
      execPath: bin,
    };
    const code = await updateCommand(
      ctx as never,
      ['--manifest', `file://${resolve(site, 'releases/latest.json')}`],
      {},
      { platform: 'test-os', currentVersion: '1.0.0', serverUrl: async () => null },
    );
    expect(io.stderr).toBe('');
    expect(code).toBe(0);
    expect(readFileSync(bin, 'utf8')).toBe(fake('1.1.0'));
  });
});
