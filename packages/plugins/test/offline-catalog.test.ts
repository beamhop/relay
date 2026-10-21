// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Kernel } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import type { RunCommand } from '../src/bun/authoring.ts';
import { createBunPluginHost, readTextFile } from '../src/bun/index.ts';
import {
  type Catalog,
  computeIntegrity,
  filePathOf,
  isFileUrl,
  loadCatalog,
  signCatalog,
} from '../src/catalog/index.ts';
import { bootKernel, ev, runAction, runEvent, tempDir } from './helpers.ts';

const publisher = makeKey();
const tarball = new TextEncoder().encode('offline tarball bytes');

function catalog(integrity: string, tarballUrl: string): Catalog {
  return {
    version: 1,
    name: 'Offline catalog',
    plugins: [
      {
        id: 'spam-pack',
        name: 'Spam pack',
        package: 'beamhop-plugin-spam-pack',
        version: '2.0.0',
        integrity,
        tarball: tarballUrl,
        description: 'Blocks common spam',
        permissions: [],
        minBeamhop: '0.0.0',
      },
    ],
  };
}

describe('file:// catalogs', () => {
  test('URL helpers', () => {
    expect(isFileUrl('file:///srv/c.json')).toBe(true);
    expect(isFileUrl('https://x/c.json')).toBe(false);
    expect(filePathOf('file:///srv/my%20catalogs/c.json')).toBe('/srv/my catalogs/c.json');
  });

  test('plain JSON without keys; signed with keys; unreadable/unsupported errors', async () => {
    const dir = tempDir();
    const plain = join(dir, 'plain.json');
    const signedPath = join(dir, 'signed.json');
    const c = catalog('sha512-x', 'https://plugins.example.org/x.tgz');
    writeFileSync(plain, JSON.stringify(c));
    writeFileSync(signedPath, JSON.stringify(signCatalog(c, publisher.sk)));
    const opts = { readFile: readTextFile };
    expect((await loadCatalog(`file://${plain}`, [], opts)).plugins[0]?.id).toBe('spam-pack');
    expect((await loadCatalog(`file://${signedPath}`, [], opts)).name).toBe('Offline catalog');
    expect((await loadCatalog(`file://${signedPath}`, [publisher.pk], opts)).plugins).toHaveLength(
      1,
    );
    // With trusted keys a plain file is not enough, and the signer must be trusted.
    await expect(loadCatalog(`file://${plain}`, [publisher.pk], opts)).rejects.toThrow(
      'not a signed',
    );
    await expect(loadCatalog(`file://${signedPath}`, [makeKey().pk], opts)).rejects.toThrow(
      'not trusted',
    );
    await expect(loadCatalog(`file://${join(dir, 'nope.json')}`, [], opts)).rejects.toThrow(
      'could not be read',
    );
    await expect(loadCatalog(`file://${plain}`, [])).rejects.toThrow('not supported');
  });
});

describe('install from an offline catalog', () => {
  let kernels: Kernel[] = [];
  afterEach(async () => {
    for (const k of kernels) await k.use<{ stop(): Promise<void> }>('plugins')?.stop();
    kernels = [];
  });

  test('catalog and tarball come from disk; integrity is still checked', async () => {
    const dir = tempDir();
    const offline = tempDir();
    const tgz = join(offline, 'spam-pack-2.0.0.tgz');
    writeFileSync(tgz, tarball);
    const catPath = join(offline, 'catalog.json');
    writeFileSync(
      catPath,
      JSON.stringify(catalog(await computeIntegrity(tarball), `file://${tgz}`)),
    );
    const network: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      network.push(String(input));
      return new Response('offline', { status: 503 });
    }) as typeof fetch;
    const commands: string[][] = [];
    const run: RunCommand = async (cmd, o) => {
      commands.push(cmd.slice(1));
      if (cmd[1] === 'add') {
        const pkgDir = join(o.cwd, 'node_modules', 'beamhop-plugin-spam-pack');
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(
          join(pkgDir, 'package.json'),
          JSON.stringify({ name: 'beamhop-plugin-spam-pack', version: '2.0.0', main: 'index.ts' }),
        );
        const sdk = join(import.meta.dir, '..', 'src', 'sdk', 'index.ts');
        writeFileSync(
          join(pkgDir, 'index.ts'),
          `import { definePlugin, reject } from ${JSON.stringify(sdk)};
export default definePlugin({ id: 'spam-pack', name: 'Spam pack', description: 'x', version: '2.0.0',
  onEvent(e) { if (e.content === 'spam') return reject('blocked', 'spam pack'); } });`,
        );
      }
      return { code: 0, output: '' };
    };
    const { kernel } = await bootKernel(
      { modules: { plugins: { catalogUrl: `file://${catPath}`, timeBudgetMs: 500 } } },
      [createBunPluginHost({ dir, fetch: fetchFn, run, watch: () => () => {} })],
    );
    kernels.push(kernel);
    const { result } = await runAction(kernel, 'plugins.catalog', {});
    const out = result.output as { items: Array<{ id: string }>; remoteError?: string };
    expect(out.remoteError).toBeUndefined();
    expect(out.items.map((i) => i.id)).toContain('spam-pack');

    await runAction(kernel, 'plugins.install', { id: 'spam-pack' });
    expect(readFileSync(join(dir, 'tarballs', 'spam-pack-2.0.0.tgz'))).toEqual(
      Buffer.from(tarball),
    );
    expect((await runEvent(kernel, ev('spam'))).action).toBe('reject');
    expect(network).toEqual([]);

    // A tampered tarball on disk is refused.
    writeFileSync(tgz, 'tampered');
    await runAction(kernel, 'plugins.uninstall', { id: 'spam-pack' });
    await expect(runAction(kernel, 'plugins.install', { id: 'spam-pack' })).rejects.toThrow(
      'fingerprint',
    );
    expect(commands.filter((c) => c[0] === 'add')).toHaveLength(1);
  });
});
