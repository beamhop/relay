// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createKernel, defineModule, dispatchHttp, parseConfig } from '@beamhop/core';
import { FakeClock, MemoryLogger, memoryPorts } from '@beamhop/testkit';
import {
  type AcmeBackend,
  AcmeManager,
  BunCrypto,
  BunScheduler,
  ChallengeStore,
  InProcessPubSub,
  JsonLogger,
  acmeDomains,
  createAssetServer,
  createDefaultPorts,
  decideTls,
  deepMerge,
  ensureDataDir,
  envToConfig,
  isPublicIp,
  loadConfig,
  loadModules,
  parseArgs,
  parseListen,
  registerAssets,
  truncateIp,
} from '../src/index.ts';
import { tempDir } from './helpers.ts';

describe('config precedence', () => {
  test('env maps BEAMHOP_* paths with camelCase and JSON values', () => {
    expect(
      envToConfig({
        BEAMHOP_NODE__TRUST_PROXY: 'true',
        BEAMHOP_BLOB_STORAGE__ACCESS_KEY_ID: 'AK',
        BEAMHOP_NODE__TLS__MODE: 'proxy',
        BEAMHOP_LISTEN: '0.0.0.0:9000',
        BEAMHOP_SAFE: '1',
        OTHER: 'x',
      }),
    ).toEqual({
      node: { trustProxy: true, tls: { mode: 'proxy' }, listen: '0.0.0.0:9000' },
      blobStorage: { accessKeyId: 'AK' },
    });
    expect(envToConfig({ BEAMHOP_DOMAIN: 'a.example, b.example' }).relays).toEqual([
      { id: 'main', hosts: ['a.example', 'b.example'] },
    ]);
    // Empty values (e.g. unset compose interpolations) are ignored.
    expect(envToConfig({ BEAMHOP_NODE__TLS__EMAIL: '', BEAMHOP_DOMAIN: '' })).toEqual({});
  });

  test('defaults < env < file < CLI flags', () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, 'beamhop.yaml'),
      'node:\n  listen: 0.0.0.0:7000\n  id: from-file\nrelays:\n  - id: r1\n    hosts: [r1.example]\n',
    );
    const env = {
      BEAMHOP_NODE__LISTEN: '0.0.0.0:8000',
      BEAMHOP_NODE__TRUST_PROXY: 'true',
      BEAMHOP_NODE__ID: 'from-env',
    };
    const a = loadConfig({ cwd, env });
    expect(a.file).toBe(join(cwd, 'beamhop.yaml'));
    expect(a.config.node.listen).toBe('0.0.0.0:7000'); // file beats env
    expect(a.config.node.id).toBe('from-file');
    expect(a.config.node.trustProxy).toBe(true); // env beats default
    expect(a.config.node.tls.mode).toBe('auto'); // default
    expect(a.config.relays.map((r) => r.id)).toEqual(['r1']);
    expect(a.defaultRelay).toBe(false);
    expect(a.config.node.dataDir).toBe(join(cwd, 'data'));

    const b = loadConfig({ cwd, env, args: { listen: '127.0.0.1:1', dataDir: 'elsewhere' } });
    expect(b.config.node.listen).toBe('127.0.0.1:1'); // CLI beats file
    expect(b.config.node.dataDir).toBe(join(cwd, 'elsewhere'));
  });

  test('no file and no relays → catch-all default relay', () => {
    const r = loadConfig({ cwd: tempDir(), env: {} });
    expect(r.file).toBeUndefined();
    expect(r.defaultRelay).toBe(true);
    expect(r.config.relays[0]?.hosts).toEqual(['*']);
  });

  test('explicit missing config file is an error; file in data dir is found', () => {
    const cwd = tempDir();
    expect(() => loadConfig({ cwd, env: { BEAMHOP_CONFIG: 'nope.yaml' } })).toThrow(/not found/);
    mkdirSync(join(cwd, 'd'));
    writeFileSync(join(cwd, 'd', 'beamhop.yaml'), 'node:\n  id: in-data\n');
    expect(loadConfig({ cwd, env: { BEAMHOP_DATA_DIR: 'd' } }).config.node.id).toBe('in-data');
  });

  test('args, listen parsing, deep merge', () => {
    expect(parseArgs(['--safe', '--config=x.yaml', '--data-dir', '/d'])).toMatchObject({
      safe: true,
      configPath: 'x.yaml',
      dataDir: '/d',
    });
    expect(parseArgs([], { BEAMHOP_SAFE: 'true' }).safe).toBe(true);
    expect(parseListen('0.0.0.0:3334')).toEqual({ hostname: '0.0.0.0', port: 3334 });
    expect(parseListen('[::]:443')).toEqual({ hostname: '::', port: 443 });
    expect(parseListen(':80')).toEqual({ hostname: '0.0.0.0', port: 80 });
    expect(() => parseListen('nope')).toThrow();
    expect(deepMerge({ a: { b: 1, c: [1] } }, { a: { c: [2] } })).toEqual({ a: { b: 1, c: [2] } });
  });

  test('data dir layout', () => {
    const l = ensureDataDir(join(tempDir(), 'data'));
    for (const d of [l.dbDir, l.blobsDir, l.tlsDir, l.secretsDir, l.backupsDir]) {
      expect(existsSync(d)).toBe(true);
    }
    expect(l.sqlitePath.endsWith('db/beamhop.sqlite')).toBe(true);
  });
});

describe('bun ports', () => {
  test('scheduler: no overlap, jitter, cancel, stop waits for in-flight', async () => {
    const s = new BunScheduler({ jitter: 0.5, random: () => 0 }); // delay = interval * 0.5
    let running = 0;
    let maxConcurrent = 0;
    let runs = 0;
    s.every('slow', 0.01, async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await Bun.sleep(30);
      running--;
      runs++;
    });
    await Bun.sleep(120);
    expect(runs).toBeGreaterThanOrEqual(2);
    expect(maxConcurrent).toBe(1);
    s.every('other', 100, async () => {});
    expect(s.names().sort()).toEqual(['other', 'slow']);
    s.cancel('other');
    expect(s.names()).toEqual(['slow']);
    await s.stop();
    expect(running).toBe(0);
    const after = runs;
    await Bun.sleep(50);
    expect(runs).toBe(after);
  });

  test('scheduler survives job errors', async () => {
    const logger = new MemoryLogger();
    const s = new BunScheduler({ logger, jitter: 0 });
    let n = 0;
    s.every('boom', 0.005, async () => {
      n++;
      throw new Error('x');
    });
    await Bun.sleep(40);
    await s.stop();
    expect(n).toBeGreaterThanOrEqual(2);
    expect(logger.lines.some((l) => l.level === 'error')).toBe(true);
  });

  test('crypto: daily rotating salted IP hash', async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1, 10));
    const c = new BunCrypto({ secret: new Uint8Array(32).fill(1), clock });
    const h1 = c.hashIp('203.0.113.5');
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
    expect(c.hashIp('203.0.113.5')).toBe(h1);
    expect(c.hashIp('203.0.113.6')).not.toBe(h1);
    clock.advance(86400);
    expect(c.hashIp('203.0.113.5')).not.toBe(h1);
    const other = new BunCrypto({ secret: new Uint8Array(32).fill(2), clock });
    expect(other.hashIp('203.0.113.5')).not.toBe(c.hashIp('203.0.113.5'));
    const trunc = new BunCrypto({ clock, ipLogging: 'truncated' });
    expect(trunc.hashIp('203.0.113.5')).toBe(trunc.hashIp('203.0.113.77'));
    expect(new BunCrypto({ ipLogging: 'off' }).hashIp('1.2.3.4')).toBe('anon');
    expect(truncateIp('2001:db8:1:2::5')).toBe('2001:db8:1::');
    expect(await c.sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(c.randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
  });

  test('json logger and pubsub', async () => {
    const lines: string[] = [];
    const log = new JsonLogger({ level: 'info', write: (l) => lines.push(l) });
    log.log('debug', 'hidden');
    log.child({ mod: 'x' }).log('info', 'hello', { err: new Error('bad') });
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      level: 'info',
      msg: 'hello',
      mod: 'x',
      err: { message: 'bad' },
    });

    const ps = new InProcessPubSub();
    const got: unknown[] = [];
    ps.subscribe('c', () => {
      throw new Error('bad handler');
    });
    const off = ps.subscribe('c', (m) => got.push(m));
    await ps.publish('c', 1);
    off();
    await ps.publish('c', 2);
    expect(got).toEqual([1]);
  });

  test('default ports load storage-sql / blobs factories when present', async () => {
    const dir = tempDir();
    const layout = ensureDataDir(dir);
    const cfg = parseConfig({ node: { dataDir: dir } });
    const { MemoryEventStore, MemoryBlobStore } = await import('@beamhop/testkit');
    let sqlOpts: unknown;
    const events = new MemoryEventStore();
    const res = await createDefaultPorts(cfg, layout, new MemoryLogger(), {
      importSql: async () => ({
        createSqlStores: (o) => {
          sqlOpts = o;
          return { events };
        },
      }),
      importBlobs: async () => ({ createBlobStore: () => new MemoryBlobStore() }),
    });
    expect(res.ports.events).toBe(events);
    expect(sqlOpts).toMatchObject({ driver: 'sqlite', dataDir: dir });
    expect(res.memoryFallbacks.sort()).toEqual(['blobIndex', 'docs', 'metrics']);
    expect(existsSync(join(layout.secretsDir, 'ip-salt.key'))).toBe(true);
    await res.close();
  });

  test('default ports wire ports.media from @beamhop/media/bun when tools exist', async () => {
    const dir = tempDir();
    const layout = ensureDataDir(dir);
    const cfg = parseConfig({ node: { dataDir: dir }, storage: { driver: 'memory' } });
    const processor = { supports: ['resize'] as const, process: async () => [] };
    const withMedia = await createDefaultPorts(cfg, layout, new MemoryLogger(), {
      importMedia: async () => ({ createBunMediaProcessor: async () => ({ processor }) }),
    });
    expect(withMedia.ports.media).toBe(processor);
    await withMedia.close();
    const without = await createDefaultPorts(cfg, layout, new MemoryLogger(), {
      importMedia: async () => ({ createBunMediaProcessor: async () => ({}) }),
    });
    expect(without.ports.media).toBeUndefined();
    await without.close();
  });
});

describe('kernel dispatch', () => {
  test('dispatchHttp sets the route variable before module routes run', async () => {
    const kernel = await createKernel({
      runtime: 'test',
      ports: memoryPorts(),
      config: parseConfig({}),
      modules: [
        defineModule({
          id: 'r',
          register(k) {
            k.http.get('/x', (c) => c.json(c.get('route')));
          },
        }),
      ],
    });
    const route = { relayId: 'a', publicUrl: 'https://a.test', ipHash: 'h' };
    const res = await dispatchHttp(kernel, new Request('http://h/x'), route);
    expect(await res.json()).toEqual(route);
  });
});

describe('modules loader', () => {
  const mod = (id: string, dependsOn?: string[]) => defineModule({ id, dependsOn, register() {} });
  test('collects module exports, honours opt-in and drops missing deps', async () => {
    const cfg = parseConfig({ modules: { 'ent-a': {} } });
    const mods = await loadModules(cfg, new MemoryLogger(), [
      { name: 'a', load: async () => ({ aModule: mod('a'), helper: 1 }) },
      { name: 'broken', load: async () => Promise.reject(new Error('missing')) },
      { name: 'b', load: async () => ({ bModule: mod('b', ['zzz']) }) },
      { name: 'skip', load: async () => ({ s: mod('s') }), when: () => false },
      { name: 'ent', load: async () => ({ x: mod('ent-a'), y: mod('ent-b') }), optIn: true },
    ]);
    expect(mods.map((m) => m.id).sort()).toEqual(['a', 'ent-a']);
  });
});

describe('tls', () => {
  const cfg = (mode: string, hosts = ['relay.example.com']) =>
    parseConfig({ node: { tls: { mode } }, relays: [{ id: 'r', hosts }] });

  test('auto mode decision', () => {
    const pub = () => ['203.0.113.10'];
    expect(decideTls(cfg('auto'), 443, pub).mode).toBe('acme');
    expect(decideTls(cfg('auto'), 3334, pub).mode).toBe('proxy');
    expect(decideTls(cfg('auto'), 443, () => []).mode).toBe('proxy');
    expect(decideTls(cfg('auto', ['*']), 443, pub).mode).toBe('proxy');
    expect(decideTls(cfg('acme'), 8443, () => []).mode).toBe('acme');
    expect(decideTls(cfg('off'), 443, pub).mode).toBe('off');
    expect(isPublicIp('10.1.2.3')).toBe(false);
    expect(isPublicIp('192.168.1.1')).toBe(false);
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('fd00::1')).toBe(false);
    expect(isPublicIp('2001:4860::8888')).toBe(true);
    expect(acmeDomains(cfg('auto', ['A.example.com', '*', 'localhost', '1.2.3.4']))).toEqual([
      'a.example.com',
    ]);
  });

  test('ACME manager obtains via HTTP-01, stores, and renews when close to expiry', async () => {
    const dir = ensureDataDir(tempDir()).tlsDir;
    const challenges = new ChallengeStore();
    let now = Date.UTC(2026, 0, 1);
    let orders = 0;
    const seen: Array<string | null> = [];
    const backend: AcmeBackend = {
      createAccountKey: async () => 'ACCOUNT',
      async obtain(o) {
        orders++;
        await o.onChallenge('tok', 'tok.thumb');
        const res = challenges.respond('/.well-known/acme-challenge/tok');
        seen.push(res ? await res.text() : null);
        await o.onChallengeDone('tok');
        return { cert: `CERT-${now + 90 * 86_400_000}`, key: 'KEY' };
      },
      notAfter: (pem) => new Date(Number(pem.slice(5))),
    };
    const m = new AcmeManager({
      tlsDir: dir,
      domains: ['relay.example.com'],
      challenges,
      logger: new MemoryLogger(),
      backend,
      now: () => now,
    });
    const first = await m.ensure();
    expect(first.renewed).toBe(true);
    expect(seen).toEqual(['tok.thumb']);
    expect(challenges.get('tok')).toBeUndefined();
    expect(existsSync(m.certPath) && existsSync(m.accountKeyPath)).toBe(true);
    expect((await m.ensure()).renewed).toBe(false);
    now += 70 * 86_400_000; // 20 days left
    expect((await m.ensure()).renewed).toBe(true);
    expect(orders).toBe(2);
    expect(challenges.respond('/other')).toBeNull();
    expect(challenges.respond('/.well-known/acme-challenge/x')?.status).toBe(404);
  });
});

describe('assets', () => {
  test('serves embedded assets under /admin with SPA fallback', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'index.html'), '<h1>admin</h1>');
    writeFileSync(join(dir, 'app.js'), 'x');
    const disk = createAssetServer({ mount: '/admin', dir });
    expect(disk.source).toBe('disk');
    const get = (p: string, accept = '*/*') =>
      disk.serve(new Request(`http://h${p}`, { headers: { accept } }), p);
    expect(await get('/admin/')?.text()).toBe('<h1>admin</h1>');
    expect(await get('/admin/app.js')?.text()).toBe('x');
    expect(get('/admin/missing.js')).toBeNull();
    expect(await get('/admin/settings', 'text/html')?.text()).toBe('<h1>admin</h1>');
    expect(get('/admin/../../etc/passwd')).toBeNull();
    expect(get('/other')).toBeNull();

    registerAssets({ '/index.html': join(dir, 'index.html') });
    const emb = createAssetServer({ mount: '/admin' });
    expect(emb.source).toBe('embedded');
    expect(await emb.serve(new Request('http://h/admin'), '/admin')?.text()).toBe('<h1>admin</h1>');
  });
});
