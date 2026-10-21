// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sandboxWorkerUrl, setSandboxWorkerUrl } from '@beamhop/plugins/bun';
import {
  IMAGE_WORKER,
  PLUGIN_WORKER,
  VERIFY_WORKER,
  binaryPath,
  commonRoot,
  compileArgs,
  embeddedWorkerPath,
  generateEntry,
  parseBuildArgs,
  uiProblem,
} from '../scripts/build.ts';
import { tempDir } from './helpers.ts';

describe('single binary: plugin sandbox worker', () => {
  test('the worker is an extra compile entrypoint with a fixed root', () => {
    const entry = resolve(import.meta.dir, '../dist/.gen/entry.ts');
    const root = commonRoot([join(entry, '..'), join(PLUGIN_WORKER, '..')]);
    expect(root).toBe(resolve(import.meta.dir, '../..'));
    expect(embeddedWorkerPath(entry)).toBe('./plugins/src/bun/worker-entry.ts');
    const args = compileArgs(entry, 'linux-x64', '/out/beamhop', PLUGIN_WORKER);
    expect(args).toContain('--compile');
    expect(args).toContain(`--root=${root}`);
    expect(args.slice(args.indexOf(entry), args.indexOf(entry) + 2)).toEqual([
      entry,
      PLUGIN_WORKER,
    ]);
    expect(compileArgs(entry, 'linux-x64', '/o', null)).not.toContain(PLUGIN_WORKER);
  });

  test('the generated entry points the sandbox at the embedded worker', () => {
    const out = tempDir('beamhop-build-');
    const r = generateEntry(out, join(out, 'no-pwa'), join(out, 'no-team'));
    expect(r.worker).toBe(PLUGIN_WORKER);
    const src = readFileSync(r.entry, 'utf8');
    expect(src).toContain('import { setSandboxWorkerUrl } from');
    expect(src).toContain(`setSandboxWorkerUrl(${JSON.stringify(embeddedWorkerPath(r.entry))});`);
    // The call runs before main().
    expect(src.indexOf('setSandboxWorkerUrl(')).toBeLessThan(src.indexOf('await main();'));
  });

  test('the signature worker is embedded and the pool is pointed at it', () => {
    const out = tempDir('beamhop-build-');
    const r = generateEntry(out, join(out, 'no-pwa'), join(out, 'no-team'));
    expect(r.workers).toEqual([PLUGIN_WORKER, VERIFY_WORKER, IMAGE_WORKER]);
    const distEntry = resolve(import.meta.dir, '../dist/.gen/entry.ts');
    expect(embeddedWorkerPath(distEntry, VERIFY_WORKER)).toBe('./runtime-bun/src/verify-worker.ts');
    expect(embeddedWorkerPath(distEntry)).toBe('./plugins/src/bun/worker-entry.ts');
    const src = readFileSync(r.entry, 'utf8');
    expect(src).toContain(
      `setVerifyWorkerUrl(${JSON.stringify(embeddedWorkerPath(r.entry, VERIFY_WORKER))});`,
    );
    expect(src.indexOf('setVerifyWorkerUrl(')).toBeLessThan(src.indexOf('await main();'));
    const args = compileArgs(distEntry, 'linux-x64', '/o', r.workers);
    expect(args).toContain(VERIFY_WORKER);
    expect(args).toContain(PLUGIN_WORKER);
    expect(args).toContain(`--root=${resolve(import.meta.dir, '../..')}`);
  });

  test('the sandbox worker URL can be overridden', () => {
    const before = sandboxWorkerUrl();
    expect(before).toEndWith('/worker-entry.ts');
    setSandboxWorkerUrl('./plugins/src/bun/worker-entry.ts');
    expect(sandboxWorkerUrl()).toBe('./plugins/src/bun/worker-entry.ts');
    setSandboxWorkerUrl(before);
  });
});

describe('single binary: one file with everything', () => {
  test('the image worker (wasm codecs) is embedded and the pool is pointed at it', () => {
    const out = tempDir('beamhop-build-');
    const r = generateEntry(out, join(out, 'no-pwa'), join(out, 'no-team'));
    const distEntry = resolve(import.meta.dir, '../dist/.gen/entry.ts');
    expect(embeddedWorkerPath(distEntry, IMAGE_WORKER)).toBe('./media/src/image-worker.ts');
    const src = readFileSync(r.entry, 'utf8');
    expect(src).toContain(
      `setImageWorkerUrl(${JSON.stringify(embeddedWorkerPath(r.entry, IMAGE_WORKER))});`,
    );
    expect(src.indexOf('setImageWorkerUrl(')).toBeLessThan(src.indexOf('await main();'));
    expect(compileArgs(distEntry, 'linux-x64', '/o', r.workers)).toContain(IMAGE_WORKER);
    // Nothing ships next to the binary any more.
    expect(compileArgs(distEntry, 'linux-x64', '/o', r.workers)).not.toContain(
      '--compile-autoload-package-json',
    );
  });

  test('one output file per target; Windows gets .exe', () => {
    expect(binaryPath('/d', 'linux-x64')).toBe('/d/beamhop-linux-x64');
    expect(binaryPath('/d', 'windows-x64')).toBe('/d/beamhop-windows-x64.exe');
    const a = parseBuildArgs([]);
    expect(a.targets).toEqual(['linux-x64', 'linux-arm64', 'darwin-arm64', 'windows-x64']);
    expect(a.allowMissingUi).toBe(false);
    expect(parseBuildArgs(['--allow-missing-ui']).allowMissingUi).toBe(true);
    expect(parseBuildArgs(['--version', '1.2.3', '--target', 'linux-x64']).targets).toEqual([
      'linux-x64',
    ]);
    // Removed sharp options are refused instead of silently ignored.
    expect(() => parseBuildArgs(['--no-sharp'])).toThrow('unknown option');
  });

  test('a missing or empty app build is reported', () => {
    const out = tempDir('beamhop-build-');
    expect(uiProblem(join(out, 'nope'), 'Admin app', 'hint')).toContain(
      'Admin app build not found',
    );
    mkdirSync(join(out, 'empty'));
    expect(uiProblem(join(out, 'empty'), 'Team app', 'hint')).toContain('index.html is missing');
    mkdirSync(join(out, 'ok'));
    writeFileSync(join(out, 'ok', 'index.html'), '<!doctype html>');
    expect(uiProblem(join(out, 'ok'), 'Admin app', 'hint')).toBeNull();
  });
});
