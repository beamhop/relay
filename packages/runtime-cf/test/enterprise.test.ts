// SPDX-License-Identifier: AGPL-3.0-or-later
/** Cloudflare runtime pieces for enterprise modules: claim code, background work, store views, bundling. */
import { describe, expect, test } from 'bun:test';
import {
  type BeamhopModule,
  type Kernel,
  createKernel,
  defineModule,
  parseConfig,
} from '@beamhop/core';
import { MemoryBlobStore, MemoryDocStore, memoryPorts } from '@beamhop/testkit';
import { generateImportMap, optionalPackages } from '../src/bundle/import-map.ts';
import {
  BACKGROUND_SERVICE,
  BackgroundTasks,
  CLAIM_COLLECTION,
  CLAIM_KEY,
  CfLogger,
  backgroundOf,
  ensureClaimCode,
  storeView,
  withRuntimeDeps,
} from '../src/index.ts';
import { setup } from './fakes.ts';

/** Stand-in for the admin module's `admin.claim` service (same doc and CAS semantics). */
function claimModule(docs: MemoryDocStore, owners: { n: number }): BeamhopModule {
  return defineModule({
    id: 'admin-stub',
    register(kernel) {
      kernel.provide('admin.claim', {
        isClaimed: async () => owners.n > 0,
        async issueCode() {
          const cur = await docs.get<{ code: string }>(CLAIM_COLLECTION, CLAIM_KEY);
          if (cur) return { code: cur.code };
          const next = { code: 'ABCD-EFGH-IJKL-MNOP', createdAt: 1 };
          await docs.cas(CLAIM_COLLECTION, CLAIM_KEY, null, next);
          return { code: (await docs.get<{ code: string }>(CLAIM_COLLECTION, CLAIM_KEY))!.code };
        },
      });
    },
  });
}

async function claimEnv(owners = { n: 0 }) {
  const docs = new MemoryDocStore();
  const lines: string[] = [];
  const logger = new CfLogger('debug', {}, (l) => lines.push(l));
  const ports = memoryPorts({ docs });
  const kernel = await createKernel({
    runtime: 'cloudflare',
    ports,
    config: parseConfig({}),
    modules: [claimModule(docs, owners)],
  });
  const deps = { docs, logger, clock: ports.clock };
  return { docs, lines, kernel, deps };
}

describe('first-run claim code on Cloudflare', () => {
  test('created once and logged once', async () => {
    const { docs, lines, kernel, deps } = await claimEnv();
    expect(await ensureClaimCode(kernel, deps)).toBe('created-logged');
    expect(await ensureClaimCode(kernel, deps)).toBe('existing');
    const shown = lines.filter((l) => l.includes('ABCD-EFGH-IJKL-MNOP'));
    expect(shown).toHaveLength(1);
    expect(JSON.parse(shown[0]!)).toMatchObject({
      level: 'warn',
      claimCode: 'ABCD-EFGH-IJKL-MNOP',
    });
    expect(await docs.get(CLAIM_COLLECTION, CLAIM_KEY)).toMatchObject({
      code: 'ABCD-EFGH-IJKL-MNOP',
    });
  });

  test('keeps an unused code written by create-beamhop and does not log it', async () => {
    const { docs, lines, kernel, deps } = await claimEnv();
    await docs.put(CLAIM_COLLECTION, CLAIM_KEY, { code: 'FROM-SETUP', createdAt: 5 });
    expect(await ensureClaimCode(kernel, deps)).toBe('existing');
    expect(await docs.get(CLAIM_COLLECTION, CLAIM_KEY)).toEqual({
      code: 'FROM-SETUP',
      createdAt: 5,
    });
    expect(lines.some((l) => l.includes('FROM-SETUP'))).toBe(false);
  });

  test('BEAMHOP_CLAIM_CODE secret sets the code without printing it; short ones are ignored', async () => {
    const { docs, lines, kernel, deps } = await claimEnv();
    expect(await ensureClaimCode(kernel, { ...deps, preset: 'short' })).toBe('created-logged');
    expect(await ensureClaimCode(kernel, { ...deps, preset: 'my-own-claim-code' })).toBe('preset');
    expect(await docs.get(CLAIM_COLLECTION, CLAIM_KEY)).toMatchObject({
      code: 'my-own-claim-code',
    });
    expect(lines.some((l) => l.includes('my-own-claim-code'))).toBe(false);
    expect(lines.some((l) => l.includes('too short'))).toBe(true);
  });

  test('does nothing once the relay has an owner, or without the admin module', async () => {
    const { docs, kernel, deps } = await claimEnv({ n: 1 });
    expect(await ensureClaimCode(kernel, { ...deps, preset: 'my-own-claim-code' })).toBe('claimed');
    expect(await docs.get(CLAIM_COLLECTION, CLAIM_KEY)).toBeNull();
    const bare = await createKernel({
      runtime: 'cloudflare',
      ports: memoryPorts(),
      config: parseConfig({}),
      modules: [],
    });
    expect(await ensureClaimCode(bare, deps)).toBe('no-admin');
  });

  test('the Worker runs it at first boot', async () => {
    const docs = new MemoryDocStore();
    const ctx = setup({ modules: [claimModule(docs, { n: 0 })] });
    await ctx.runtime.worker.fetch(new Request('https://alpha.example/'), ctx.env);
    // The stub writes to its own store; the runtime logged the code it was given.
    expect(ctx.logs.filter((l) => l.includes('your one-time claim code'))).toHaveLength(1);
  });
});

describe('background work', () => {
  test('drain waits for tracked work, including work it starts', async () => {
    const bg = new BackgroundTasks();
    const done: string[] = [];
    bg.waitUntil(
      (async () => {
        await Promise.resolve();
        done.push('a');
        bg.waitUntil(Promise.resolve().then(() => done.push('b')));
      })(),
    );
    bg.waitUntil(Promise.reject(new Error('ignored')));
    await bg.drain();
    expect(done).toEqual(['a', 'b']);
    expect(bg.size).toBe(0);
  });

  test('the Worker hands pending module work to ctx.waitUntil', async () => {
    let kernelRef: Kernel | null = null;
    let release: () => void = () => {};
    const mod = defineModule({
      id: 'bg-user',
      register(kernel) {
        kernelRef = kernel;
        kernel.http.get('/work', (c) => {
          kernel.use<BackgroundTasks>(BACKGROUND_SERVICE)?.waitUntil(
            new Promise<void>((r) => {
              release = r;
            }),
          );
          return c.text('ok');
        });
      },
    });
    const ctx = setup({ modules: [mod] });
    const waited: Promise<unknown>[] = [];
    const res = await ctx.runtime.worker.fetch(new Request('https://alpha.example/work'), ctx.env, {
      waitUntil: (p) => waited.push(p),
      passThroughOnException() {},
    });
    expect(await res.text()).toBe('ok');
    expect(waited).toHaveLength(1);
    expect(backgroundOf(kernelRef!)?.size).toBe(1);
    release();
    await Promise.all(waited);
    expect(backgroundOf(kernelRef!)?.size).toBe(0);
  });
});

describe('per-kernel store views', () => {
  test('patching a view does not touch the shared store or other views', async () => {
    const shared = new MemoryBlobStore();
    const a = storeView(shared);
    const b = storeView(shared);
    a.delete = async () => false; // e.g. a legal-hold guard installed by kernel A
    const bytes = new Uint8Array([1, 2, 3]);
    const meta = { sha256: 'f'.repeat(64), size: 3, type: 'application/octet-stream' };
    await b.put(meta, bytes);
    expect(await a.delete(meta.sha256)).toBe(false);
    expect(await shared.head(meta.sha256)).not.toBeNull();
    expect(await b.delete(meta.sha256)).toBe(true);
    expect(a.kind).toBe(shared.kind);
  });
});

describe('enterprise packages in the Worker build', () => {
  test('bundled only when configured, or all with --enterprise', () => {
    const vanilla = parseConfig({});
    expect(optionalPackages(vanilla)).toEqual([]);
    const net = parseConfig({ modules: { 'enterprise-network': {} } });
    expect(optionalPackages(net)).toEqual(['@beamhop/enterprise-compliance']);
    expect(optionalPackages(vanilla, true)).toEqual([
      '@beamhop/enterprise-compliance',
      '@beamhop/enterprise-identity',
      '@beamhop/enterprise-keyvault',
    ]);
    const r = generateImportMap({
      config: { modules: { 'enterprise-keyvault': {} } },
      builtins: ['@beamhop/relay'],
      resolve: (p) => `./${p}`,
      runtimeSpecifier: 'x',
    });
    expect(r.builtins.map((b) => b.pkg)).toEqual([
      '@beamhop/relay',
      '@beamhop/enterprise-keyvault',
    ]);
    expect(r.code).not.toContain('enterprise-compliance');
  });

  test('key vault module is rebuilt with Worker secrets as its environment', () => {
    let seen: ((n: string) => string | undefined) | undefined;
    const placeholder = defineModule({ id: 'enterprise-keyvault', register() {} });
    const other = defineModule({ id: 'x', register() {} });
    const out = withRuntimeDeps(
      [other, placeholder],
      {
        '@beamhop/enterprise-keyvault': {
          createKeyvaultModule: (deps: { env: (n: string) => string | undefined }) => {
            seen = deps.env;
            return defineModule({ id: 'enterprise-keyvault', register() {} });
          },
        },
      },
      { RELAY_ROOM: {} as never, BEAMHOP_MASTER_KEY: 'k'.repeat(64) },
    );
    expect(out[0]).toBe(other);
    expect(out[1]).not.toBe(placeholder);
    expect(seen?.('BEAMHOP_MASTER_KEY')).toBe('k'.repeat(64));
    expect(seen?.('RELAY_ROOM')).toBeUndefined();
  });
});
