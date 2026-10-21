// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Kernel } from '@beamhop/core';
import { makeKey } from '@beamhop/testkit';
import type { RunCommand } from '../src/bun/authoring.ts';
import { createBunPluginHost } from '../src/bun/index.ts';
import {
  type Catalog,
  CatalogError,
  computeIntegrity,
  fetchCatalog,
  npmTarballUrl,
  signCatalog,
  verifyCatalogEvent,
  verifyIntegrity,
} from '../src/catalog/index.ts';
import { bootKernel, ev, runAction, runEvent, tempDir } from './helpers.ts';

const publisher = makeKey();
const tarball = new TextEncoder().encode('pretend this is a .tgz');

async function catalogFor(integrity: string): Promise<Catalog> {
  return {
    version: 1,
    name: 'Test catalog',
    plugins: [
      {
        id: 'spam-pack',
        name: 'Spam pack',
        package: 'beamhop-plugin-spam-pack',
        version: '2.0.0',
        integrity,
        tarball: 'https://plugins.example.org/spam-pack-2.0.0.tgz',
        description: 'Blocks common spam',
        permissions: ['network'],
        minBeamhop: '0.0.0',
      },
    ],
  };
}

describe('catalog signatures', () => {
  test('valid signature from a trusted key verifies', async () => {
    const signed = signCatalog(await catalogFor(await computeIntegrity(tarball)), publisher.sk);
    const c = verifyCatalogEvent(signed, [publisher.pk]);
    expect(c.plugins[0]!.id).toBe('spam-pack');
  });

  test('tampered content, untrusted key, wrong kind and junk are rejected', async () => {
    const signed = signCatalog(await catalogFor('sha512-x'), publisher.sk);
    expect(() =>
      verifyCatalogEvent({ ...signed, content: signed.content.replace('Spam', 'Ham') }, [
        publisher.pk,
      ]),
    ).toThrow('signature is not valid');
    expect(() => verifyCatalogEvent(signed, [makeKey().pk])).toThrow('not trusted');
    expect(() => verifyCatalogEvent({ ...signed, kind: 1 }, [publisher.pk])).toThrow(CatalogError);
    expect(() => verifyCatalogEvent({ hello: 1 }, [publisher.pk])).toThrow('not a signed');
    const forged = { ...signed, sig: signed.sig.replace(/^./, signed.sig[0] === 'a' ? 'b' : 'a') };
    expect(() => verifyCatalogEvent(forged, [publisher.pk])).toThrow('signature');
  });

  test('fetchCatalog requires trusted keys and verifies the download', async () => {
    const signed = signCatalog(await catalogFor('sha512-x'), publisher.sk);
    const f = (async () => Response.json(signed)) as unknown as typeof fetch;
    await expect(fetchCatalog('https://c.example/catalog.json', [], f)).rejects.toThrow('trusted');
    expect(
      (await fetchCatalog('https://c.example/catalog.json', [publisher.pk], f)).plugins,
    ).toHaveLength(1);
  });
});

describe('integrity', () => {
  test('SRI and hex sha256 match; mismatches and missing hashes fail', async () => {
    await verifyIntegrity(tarball, { integrity: await computeIntegrity(tarball) });
    await verifyIntegrity(tarball, { integrity: await computeIntegrity(tarball, 'sha256') });
    await expect(
      verifyIntegrity(tarball, { integrity: await computeIntegrity(new Uint8Array([1])) }),
    ).rejects.toThrow('fingerprint');
    await expect(verifyIntegrity(tarball, {})).rejects.toThrow('no integrity');
    await expect(verifyIntegrity(tarball, { sha256: '0'.repeat(64) })).rejects.toThrow(
      'fingerprint',
    );
    expect(npmTarballUrl('@scope/pkg', '1.0.0')).toBe(
      'https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz',
    );
  });
});

describe('install from a signed remote catalog', () => {
  let kernels: Kernel[] = [];
  afterEach(async () => {
    for (const k of kernels) await k.use<{ stop(): Promise<void> }>('plugins')?.stop();
    kernels = [];
  });

  async function setup(served: Uint8Array) {
    const dir = tempDir();
    const signed = signCatalog(await catalogFor(await computeIntegrity(tarball)), publisher.sk);
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('catalog.json')) return Response.json(signed);
      if (url.endsWith('.tgz')) return new Response(served as Uint8Array<ArrayBuffer>);
      return new Response('no', { status: 404 });
    }) as typeof fetch;
    const commands: string[][] = [];
    // Fake `bun add`: drop a tiny plugin package into node_modules.
    const run: RunCommand = async (cmd, opts) => {
      commands.push(cmd.slice(1));
      if (cmd[1] === 'add') {
        const pkgDir = join(opts.cwd, 'node_modules', 'beamhop-plugin-spam-pack');
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
  permissions: ['network'],
  onEvent(e) { if (e.content === 'spam') return reject('blocked', 'spam pack'); } });`,
        );
      }
      return { code: 0, output: '' };
    };
    const r = await bootKernel(
      {
        modules: {
          plugins: {
            catalogUrl: 'https://c.example/catalog.json',
            catalogPubkeys: [publisher.pk],
            timeBudgetMs: 500,
          },
        },
      },
      [createBunPluginHost({ dir, fetch: fetchFn, run, watch: () => () => {} })],
    );
    kernels.push(r.kernel);
    return { ...r, dir, commands };
  }

  test('catalog lists built-ins and remote entries; preview explains permissions', async () => {
    const { kernel } = await setup(tarball);
    const { result } = await runAction(kernel, 'plugins.catalog', {});
    const items = (result.output as { items: Array<{ id: string; builtin: boolean }> }).items;
    expect(items.map((i) => i.id)).toContain('spam-pack');
    expect(items.find((i) => i.id === 'keyword-filter')!.builtin).toBe(true);
    const def = kernel.actions.get('plugins.install')!;
    const preview = await def.preview!(def.input.parse({ id: 'spam-pack' }), {
      principal: { id: 'o', roles: { '*': 'owner' }, via: 'cli' },
      relayId: null,
      ports: kernel.ports,
    });
    const text = preview.map((l) => l.text).join('\n');
    expect(text).toContain('connect to other websites');
    expect(text).toContain('sandbox');
    expect(preview.some((l) => l.kind === 'warning')).toBe(true);
  });

  test('installs a verified package and runs it sandboxed', async () => {
    const { kernel, host, dir, commands } = await setup(tarball);
    await runAction(kernel, 'plugins.install', { id: 'spam-pack' });
    expect(commands[0]).toEqual(['add', './tarballs/spam-pack-2.0.0.tgz']);
    expect(readFileSync(join(dir, 'tarballs', 'spam-pack-2.0.0.tgz'))).toEqual(
      Buffer.from(tarball),
    );
    const row = host.status().find((r) => r.id === 'spam-pack')!;
    expect(row).toMatchObject({ status: 'running', mode: 'sandbox', version: '2.0.0' });
    expect((await runEvent(kernel, ev('spam'))).action).toBe('reject');

    await runAction(kernel, 'plugins.uninstall', { id: 'spam-pack' });
    expect(commands.at(-1)).toEqual(['remove', 'beamhop-plugin-spam-pack']);
    expect(host.status().find((r) => r.id === 'spam-pack')).toBeUndefined();
    expect((await runEvent(kernel, ev('spam'))).action).toBe('accept');
  });

  test('integrity mismatch refuses the install and writes nothing', async () => {
    const { kernel, dir, commands } = await setup(new TextEncoder().encode('evil tarball'));
    await expect(runAction(kernel, 'plugins.install', { id: 'spam-pack' })).rejects.toThrow(
      'fingerprint',
    );
    expect(commands).toHaveLength(0);
    expect(existsSync(join(dir, 'tarballs'))).toBe(false);
    expect(kernel.config().plugins).toHaveLength(0);
  });
});

describe('plugin actions', () => {
  test('install a built-in, configure, disable, enable, status, undo, uninstall', async () => {
    const { kernel, host } = await bootKernel({}, [
      createBunPluginHost({ dir: tempDir(), watch: () => () => {} }),
    ]);
    const { preview, result } = await runAction(kernel, 'plugins.install', {
      id: 'keyword-filter',
      config: { keywords: ['spam'] },
    });
    expect(preview.map((l) => l.text).join(' ')).toContain('cannot read your data');
    expect(result.undo).toBeDefined();
    expect((await runEvent(kernel, ev('spam'))).action).toBe('reject');

    const cfg = await runAction(kernel, 'plugins.configure', {
      id: 'keyword-filter',
      config: { keywords: ['eggs'] },
      run: { failMode: 'closed' },
    });
    expect(cfg.preview.some((l) => l.text.includes('keywords'))).toBe(true);
    expect(cfg.preview.some((l) => l.text.includes('blocked'))).toBe(true);
    expect((await runEvent(kernel, ev('spam'))).action).toBe('accept');
    expect((await runEvent(kernel, ev('eggs'))).action).toBe('reject');
    await expect(
      runAction(kernel, 'plugins.configure', {
        id: 'keyword-filter',
        config: { action: 'explode' },
      }),
    ).rejects.toThrow('not valid');

    await runAction(kernel, 'plugins.disable', { id: 'keyword-filter' });
    expect((await runEvent(kernel, ev('eggs'))).action).toBe('accept');
    const en = await runAction(kernel, 'plugins.enable', { id: 'keyword-filter' });
    expect((await runEvent(kernel, ev('eggs'))).action).toBe('reject');

    // Undo the enable → off again.
    await kernel.actions.get('plugins.enable')!.undo!(en.result.undo!.payload, {
      principal: { id: 'o', roles: { '*': 'owner' }, via: 'cli' },
      relayId: null,
      ports: kernel.ports,
    });
    expect((await runEvent(kernel, ev('eggs'))).action).toBe('accept');

    const st = await runAction(kernel, 'plugins.status', {});
    const rows = (st.result.output as { plugins: Array<{ id: string; stats: { calls: number } }> })
      .plugins;
    expect(rows[0]!.id).toBe('keyword-filter');
    expect(rows[0]!.stats.calls).toBeGreaterThan(0);

    await runAction(kernel, 'plugins.uninstall', { id: 'keyword-filter' });
    expect(kernel.config().plugins).toHaveLength(0);
    await expect(runAction(kernel, 'plugins.enable', { id: 'nope' })).rejects.toThrow('no plugin');
    await host.stop();
  });
});
