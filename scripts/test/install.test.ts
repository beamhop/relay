// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Runs scripts/install.sh against a fake release server (file:// URLs) in a temp dir,
 * with a fake `beamhop` binary (a shell script that prints its version).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '../install.sh');
let root: string;

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

function release(dir: string, version: string, opts: { badSum?: boolean } = {}): void {
  mkdirSync(dir, { recursive: true });
  const sums: string[] = [];
  for (const t of ['linux-x64', 'linux-arm64', 'darwin-arm64']) {
    const body = `#!/bin/sh\necho ${version}\n`;
    writeFileSync(join(dir, `beamhop-${t}`), body);
    sums.push(`${opts.badSum ? sha256('nope') : sha256(body)}  beamhop-${t}`);
  }
  writeFileSync(join(dir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
}

function run(args: string[], env: Record<string, string> = {}, shell = 'sh') {
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const proc = Bun.spawnSync([shell, SCRIPT, ...args], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: home,
      TMPDIR: root,
      BEAMHOP_OS: 'linux',
      BEAMHOP_ARCH: 'x64',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'beamhop-install-'));
  release(join(root, 'rel/latest'), '0.9.0');
  release(join(root, 'rel/v0.8.0'), '0.8.0');
  release(join(root, 'bad/latest'), '0.9.0', { badSum: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('install.sh', () => {
  test('is valid POSIX sh', () => {
    for (const sh of ['sh', 'dash']) {
      if (!Bun.which(sh)) continue;
      const p = Bun.spawnSync([sh, '-n', SCRIPT]);
      expect(p.exitCode).toBe(0);
    }
  });

  test('installs the latest binary into --prefix and prints the next step', () => {
    const prefix = join(root, 'bin1');
    const r = run(['--base-url', `file://${root}/rel`, '--prefix', prefix]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(existsSync(join(prefix, 'beamhop'))).toBe(true);
    expect(r.out).toContain('checksum ok');
    expect(r.out).toContain('Installed Beamhop 0.9.0');
    expect(r.out).toContain('run `beamhop` and open the URL');
    const v = Bun.spawnSync([join(prefix, 'beamhop'), '--version']);
    expect(v.stdout.toString().trim()).toBe('0.9.0');
  });

  test('works under dash too, with a pinned version and the arm64 build', () => {
    if (!Bun.which('dash')) return;
    const prefix = join(root, 'bin2');
    const r = run(
      ['--base-url', `file://${root}/rel/`, '--prefix', prefix, '--version', '0.8.0'],
      { BEAMHOP_ARCH: 'arm64' },
      'dash',
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain('Installed Beamhop 0.8.0');
    expect(r.out).toContain('linux-arm64');
  });

  test('defaults to ~/.local/bin when /usr/local/bin is not writable', () => {
    const r = run(['--base-url', `file://${root}/rel`]);
    if (r.out.includes('/usr/local/bin/beamhop')) return; // running as root: nothing to check
    expect(r.code).toBe(0);
    expect(existsSync(join(root, 'home/.local/bin/beamhop'))).toBe(true);
    expect(r.out).toContain('is not on your PATH');
  });

  test('refuses a download with the wrong checksum and installs nothing', () => {
    const prefix = join(root, 'bin3');
    const r = run(['--base-url', `file://${root}/bad`, '--prefix', prefix]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('checksum mismatch');
    expect(existsSync(join(prefix, 'beamhop'))).toBe(false);
  });

  test('fails clearly for a missing release', () => {
    const r = run(['--base-url', `file://${root}/nope`, '--prefix', join(root, 'bin4')]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('download failed');
  });

  test('runs the signature hook and stops when it fails', () => {
    const hook = join(root, 'hook.sh');
    writeFileSync(hook, '#!/bin/sh\necho "checked $1" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const prefix = join(root, 'bin5');
    const r = run(['--base-url', `file://${root}/rel`, '--prefix', prefix], {
      BEAMHOP_VERIFY_HOOK: hook,
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('checked');
    expect(r.err).toContain('signature check failed');
    expect(existsSync(join(prefix, 'beamhop'))).toBe(false);
  });

  test('BEAMHOP_REQUIRE_SIGNATURE=1 refuses unsigned releases', () => {
    const r = run(['--base-url', `file://${root}/rel`, '--prefix', join(root, 'bin6')], {
      BEAMHOP_REQUIRE_SIGNATURE: '1',
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('no signature could be checked');
  });

  test('--systemd writes a hardened unit and env file', () => {
    const prefix = join(root, 'sys/bin');
    const units = join(root, 'sys/units');
    const etc = join(root, 'sys/etc');
    const r = run(
      [
        '--base-url',
        `file://${root}/rel`,
        '--prefix',
        prefix,
        '--systemd',
        '--no-start',
        '--domain',
        'relay.example.com',
      ],
      { BEAMHOP_SYSTEMD_DIR: units, BEAMHOP_ETC_DIR: etc },
    );
    expect(r.code).toBe(0);
    const unit = readFileSync(join(units, 'beamhop.service'), 'utf8');
    expect(unit).toContain(`ExecStart=${prefix}/beamhop serve`);
    for (const line of [
      'DynamicUser=yes',
      'StateDirectory=beamhop',
      'AmbientCapabilities=CAP_NET_BIND_SERVICE',
      'ProtectSystem=strict',
      'NoNewPrivileges=yes',
      `EnvironmentFile=-${etc}/beamhop.env`,
    ])
      expect(unit).toContain(line);
    expect(unit).not.toContain('MemoryDenyWriteExecute=yes');
    const env = readFileSync(join(etc, 'beamhop.env'), 'utf8');
    expect(env).toContain('BEAMHOP_DOMAIN=relay.example.com');
    expect(env).toContain('BEAMHOP_LISTEN=0.0.0.0:443');
    expect(env).toContain('BEAMHOP_DATA_DIR=/var/lib/beamhop');
    expect(r.out).toContain('systemctl enable --now beamhop');

    // Re-running with another domain updates it in place (no duplicates).
    const again = run(
      [
        '--base-url',
        `file://${root}/rel`,
        '--prefix',
        prefix,
        '--systemd',
        '--no-start',
        '--domain',
        'r2.example.com',
      ],
      { BEAMHOP_SYSTEMD_DIR: units, BEAMHOP_ETC_DIR: etc },
    );
    expect(again.code).toBe(0);
    const env2 = readFileSync(join(etc, 'beamhop.env'), 'utf8');
    expect(env2.match(/BEAMHOP_DOMAIN=/g)?.length).toBe(1);
    expect(env2).toContain('BEAMHOP_DOMAIN=r2.example.com');
  });

  test('--systemd without a domain listens on :3334', () => {
    const units = join(root, 'sys2/units');
    const etc = join(root, 'sys2/etc');
    const r = run(
      [
        '--base-url',
        `file://${root}/rel`,
        '--prefix',
        join(root, 'sys2/bin'),
        '--systemd',
        '--no-start',
      ],
      { BEAMHOP_SYSTEMD_DIR: units, BEAMHOP_ETC_DIR: etc },
    );
    expect(r.code).toBe(0);
    expect(readFileSync(join(etc, 'beamhop.env'), 'utf8')).toContain('BEAMHOP_LISTEN=0.0.0.0:3334');
  });

  test('--systemd refuses a home-directory install', () => {
    const r = run(['--base-url', `file://${root}/rel`, '--systemd', '--no-start'], {
      BEAMHOP_SYSTEMD_DIR: join(root, 'sys3'),
    });
    if (r.out.includes('/usr/local/bin/beamhop')) return; // root
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('system-wide install');
  });

  test('rejects unknown options', () => {
    const r = run(['--frobnicate']);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('unknown option');
  });
});
