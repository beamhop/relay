// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVersions, rollbackCommand, updateCommand } from '../src/commands/update.ts';
import { BufferIo } from '../src/io.ts';
import { testContext, tmp } from './helpers.ts';

const script = (version: string, healthy = true) =>
  `#!/bin/sh\ncase "$1" in\n  --version) echo "${version}" ;;\n  --healthcheck) exit ${healthy ? 0 : 1} ;;\nesac\n`;

function sha(text: string) {
  return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

/** A fake release server (manifest + binary), no network. */
function releases(newBin: string, opts: { sha?: string; version?: string } = {}) {
  const version = opts.version ?? '0.2.0';
  const manifest = {
    version,
    notes: 'Faster sign-in.\nFewer spam reports.',
    assets: {
      'test-os': { url: 'https://dl.example/beamhop-test-os', sha256: opts.sha ?? sha(newBin) },
    },
  };
  return async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('latest.json')) return Response.json(manifest);
    if (url === 'https://dl.example/beamhop-test-os') return new Response(newBin);
    return new Response('not found', { status: 404 });
  };
}

/** The fake release is unsigned: these tests use the developer override. */
const DEV_ENV = (home = tmp('beamhop-home-')) => ({
  HOME: home,
  BEAMHOP_UPDATE_ALLOW_UNSIGNED: '1',
});

function install() {
  const dir = tmp();
  const bin = join(dir, 'beamhop');
  writeFileSync(bin, script('0.1.0'), { mode: 0o755 });
  return { dir, bin };
}

const deps = { platform: 'test-os', currentVersion: '0.1.0', serverUrl: async () => null };

describe('update and rollback', () => {
  test('versions compare semantically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1);
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
  });

  test('download → verify → smoke test → atomic swap → rollback', async () => {
    const { bin } = install();
    const newBin = script('0.2.0');
    const io = new BufferIo();
    const { ctx } = testContext({
      io,
      fetch: releases(newBin) as never,
      execPath: bin,
      env: DEV_ENV(),
    });
    expect(
      await updateCommand(ctx as never, ['--manifest', 'https://dl.example/latest.json'], {}, deps),
    ).toBe(0);
    expect(readFileSync(bin, 'utf8')).toBe(newBin);
    expect(statSync(bin).mode & 0o111).toBeTruthy();
    expect(readFileSync(`${bin}.previous`, 'utf8')).toBe(script('0.1.0'));
    expect(io.stdout).toContain('Installed 0.2.0');
    expect(io.stdout).toContain('Faster sign-in.');

    const io2 = new BufferIo();
    expect(await rollbackCommand({ ...ctx, io: io2 } as never, [], {})).toBe(0);
    expect(readFileSync(bin, 'utf8')).toBe(script('0.1.0'));
    expect(readFileSync(`${bin}.rolled-back`, 'utf8')).toBe(newBin);
    expect(existsSync(`${bin}.previous`)).toBe(false);
    expect(io2.stdout).toContain('Went back to 0.1.0');
    await expect(rollbackCommand(ctx as never, [], {})).rejects.toThrow('no previous version');
  });

  test('checksum mismatch leaves the binary untouched', async () => {
    const { dir, bin } = install();
    const { ctx } = testContext({
      fetch: releases(script('0.2.0'), { sha: 'ff'.repeat(32) }) as never,
      execPath: bin,
      env: DEV_ENV(),
    });
    await expect(
      updateCommand(ctx as never, ['--manifest', 'https://dl.example/latest.json'], {}, deps),
    ).rejects.toThrow('checksum mismatch');
    expect(readFileSync(bin, 'utf8')).toBe(script('0.1.0'));
    expect(existsSync(`${bin}.previous`)).toBe(false);
    expect(readdirSync(dir)).toEqual(['beamhop']);
  });

  test('a new binary that fails its smoke test or health check is not installed', async () => {
    const { bin } = install();
    const wrong = script('0.1.5'); // reports the wrong version
    const { ctx } = testContext({ fetch: releases(wrong) as never, execPath: bin, env: DEV_ENV() });
    await expect(
      updateCommand(ctx as never, ['--manifest', 'https://dl.example/latest.json'], {}, deps),
    ).rejects.toThrow('did not start correctly');
    expect(readFileSync(bin, 'utf8')).toBe(script('0.1.0'));

    const sick = script('0.2.0', false);
    const { ctx: ctx2 } = testContext({
      fetch: releases(sick) as never,
      execPath: bin,
      env: DEV_ENV(),
    });
    await expect(
      updateCommand(
        ctx2 as never,
        ['--manifest', 'https://dl.example/latest.json'],
        {},
        {
          ...deps,
          serverUrl: async () => 'http://127.0.0.1:3334',
        },
      ),
    ).rejects.toThrow('failed its health check');
    expect(readFileSync(bin, 'utf8')).toBe(script('0.1.0'));
  });

  test('--check and up to date; a bad signature is refused', async () => {
    const { bin } = install();
    const io = new BufferIo();
    const { ctx } = testContext({ io, fetch: releases(script('0.2.0')) as never, execPath: bin });
    await updateCommand(
      ctx as never,
      ['--manifest', 'https://dl.example/latest.json', '--check'],
      {},
      deps,
    );
    expect(io.stdout).toContain('Version 0.2.0 is available');
    const io2 = new BufferIo();
    await updateCommand(
      { ...ctx, io: io2 } as never,
      ['--manifest', 'https://dl.example/latest.json'],
      {},
      {
        ...deps,
        currentVersion: '0.2.0',
      },
    );
    expect(io2.stdout).toContain('latest version');
    await expect(
      updateCommand(
        ctx as never,
        ['--manifest', 'https://dl.example/latest.json'],
        {},
        {
          ...deps,
          verifySignature: async () => 'bad',
        },
      ),
    ).rejects.toThrow('not signed');
    expect(readFileSync(bin, 'utf8')).toBe(script('0.1.0'));
  });
});
