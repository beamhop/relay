// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sandboxWorkerUrl, setSandboxWorkerUrl } from '@beamhop/plugins/bun';
import {
  PLUGIN_WORKER,
  commonRoot,
  compileArgs,
  embeddedWorkerPath,
  generateEntry,
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

  test('the sandbox worker URL can be overridden', () => {
    const before = sandboxWorkerUrl();
    expect(before).toEndWith('/worker-entry.ts');
    setSandboxWorkerUrl('./plugins/src/bun/worker-entry.ts');
    expect(sandboxWorkerUrl()).toBe('./plugins/src/bun/worker-entry.ts');
    setSandboxWorkerUrl(before);
  });
});
