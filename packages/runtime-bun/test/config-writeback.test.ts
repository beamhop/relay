// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { chmodSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AdminConfigService, adminApiModule } from '@beamhop/admin-api';
import { type BeamhopConfig, createKernel } from '@beamhop/core';
import { MemoryLogger, memoryPorts } from '@beamhop/testkit';
import YAML from 'yaml';
import {
  CONFIG_FILE_SERVICE,
  type ConfigFileWriter,
  configDiff,
  installConfigWriteBack,
} from '../src/config-writeback.ts';
import { type Env, interpolateEnv, loadConfig, parseArgs } from '../src/config.ts';
import { startServer } from '../src/server.ts';
import { canBind, tempDir } from './helpers.ts';

const FILE = `# Beamhop settings — kept in git
node:
  dataDir: ./data # local data
  listen: 127.0.0.1:0

# Privacy first
privacy:
  ipLogging: hashed

relays:
  - id: main
    hosts: [relay.example.com]
    info:
      name: Cozy relay # shown to apps

ai:
  apiKey: \${AI_KEY}
`;

async function boot(text = FILE, env: Env = { AI_KEY: 'sk-from-env' }) {
  const dir = tempDir('beamhop-wb-');
  const file = join(dir, 'beamhop.yaml');
  writeFileSync(file, text, { mode: 0o640 });
  chmodSync(file, 0o640);
  const loaded = loadConfig({ env, args: { configPath: file }, cwd: dir });
  const ports = memoryPorts();
  const kernel = await createKernel({
    runtime: 'test',
    ports,
    config: loaded.config,
    modules: [adminApiModule],
  });
  const svc = kernel.use<AdminConfigService>('admin.config')!;
  await svc.adoptBootConfig(loaded.config, { source: 'file', path: file });
  const logger = new MemoryLogger();
  const writer = installConfigWriteBack(kernel, {
    path: file,
    overridePaths: loaded.overridePaths,
    logger,
  })!;
  const change = async (fn: (c: BeamhopConfig) => void) => {
    const next = structuredClone((await svc.current()).config);
    fn(next);
    return svc.apply(next, { principalId: 'test', summary: 'test change' });
  };
  return { dir, file, kernel, svc, writer, logger, change, loaded };
}

describe('settings file write-back (GitOps)', () => {
  test('app changes are written into the YAML, keeping comments, order and ${VAR} references', async () => {
    const { file, kernel, change, writer, loaded } = await boot();
    expect(loaded.config.ai.apiKey).toBe('sk-from-env');
    expect(kernel.use<ConfigFileWriter>(CONFIG_FILE_SERVICE)).toBe(writer);

    await change((c) => {
      c.privacy.ipLogging = 'off';
      c.relays[0]!.info.name = 'Cosy relay';
      c.relays[0]!.hosts.push('www.example.com');
    });
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# Beamhop settings — kept in git');
    expect(text).toContain('# Privacy first');
    expect(text).toContain('dataDir: ./data # local data'); // runtime paths untouched
    expect(text).toContain('name: Cosy relay # shown to apps');
    expect(text).toContain('apiKey: ${AI_KEY}');
    expect(text).not.toContain('sk-from-env');
    expect(text.indexOf('node:')).toBeLessThan(text.indexOf('privacy:'));
    const parsed = YAML.parse(text);
    expect(parsed.privacy.ipLogging).toBe('off');
    expect(parsed.relays[0].hosts).toEqual(['relay.example.com', 'www.example.com']);
    // Only the changed settings were added, not the whole defaulted config.
    expect(parsed.limits).toBeUndefined();
    expect(statSync(file).mode & 0o777).toBe(0o640);
    // No temp files left behind.
    expect(readdirSync(join(file, '..')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(writer.status().error).toBeUndefined();
  });

  test('a changed value that comes from ${VAR} or env is never written as plain text', async () => {
    const { file, change, writer, kernel } = await boot(FILE, {
      AI_KEY: 'sk-from-env',
      BEAMHOP_NODE__TRUST_PROXY: 'true',
    });
    await change((c) => {
      c.ai.apiKey = 'sk-typed-in-app';
      c.node.trustProxy = false;
      c.privacy.ipLogging = 'off';
    });
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('apiKey: ${AI_KEY}');
    expect(text).not.toContain('sk-typed-in-app');
    expect(text).not.toContain('trustProxy');
    expect(YAML.parse(text).privacy.ipLogging).toBe('off');
    expect(writer.status().skipped.sort()).toEqual(['ai.apiKey', 'node.trustProxy']);
    const cards = (await Promise.all(kernel.cards.map((s) => s.cards(null)))).flat();
    const card = cards.find((c) => c.id === 'runtime.config-writeback.overrides')!;
    expect(card.severity).toBe('info');
    expect(card.technical).toContain('ai.apiKey');
    expect(card.body).not.toContain('apiKey');
  });

  test('a secret typed in the app for a plain file value is written; adding keys and relays works', async () => {
    const { file, change } = await boot('relays:\n  - id: main\n    hosts: [a.example]\n');
    await change((c) => {
      c.relays.push({ ...structuredClone(c.relays[0]!), id: 'team', hosts: ['t.example'] });
      c.privacy.ipLogging = 'off';
    });
    const parsed = YAML.parse(readFileSync(file, 'utf8'));
    expect(parsed.relays.map((r: { id: string }) => r.id)).toEqual(['main', 'team']);
    expect(parsed.privacy).toEqual({ ipLogging: 'off' });
    expect(parsed.node).toBeUndefined(); // absolute data dir is not baked in
  });

  test('no reload loop: our write is recognised and re-syncing the file changes nothing', async () => {
    const { file, svc, change, writer } = await boot();
    const before = (await svc.current()).revision;
    await change((c) => {
      c.privacy.ipLogging = 'off';
    });
    const after = (await svc.current()).revision;
    expect(after).toBe(before + 1);
    const text = readFileSync(file, 'utf8');
    expect(writer.isOwnWrite(text)).toBe(true);
    expect(writer.isOwnWrite(`${text}\n# hand edit`)).toBe(false);
    // A watcher that re-reads the file (env-resolved) would find nothing new.
    const reread = loadConfig({
      env: { AI_KEY: 'sk-from-env' },
      args: { configPath: file },
      cwd: join(file, '..'),
    });
    expect(await svc.syncFromFile(YAML.stringify(reread.config))).toEqual({
      changed: false,
      revision: after,
    });
    // An unchanged config does not rewrite the file.
    const mtime = statSync(file).mtimeMs;
    await writer.write(await svc.exportYaml());
    expect(statSync(file).mtimeMs).toBe(mtime);
  });

  test('read-only file: the change still applies, one log line, a card; recovers later', async () => {
    if (process.getuid?.() === 0) return; // root ignores file modes
    const { file, change, writer, logger, kernel, svc } = await boot();
    const original = readFileSync(file, 'utf8');
    chmodSync(file, 0o444);
    await change((c) => {
      c.privacy.ipLogging = 'off';
    });
    await change((c) => {
      c.relays[0]!.info.name = 'Renamed';
    });
    expect(kernel.config().privacy.ipLogging).toBe('off');
    expect((await svc.current()).config.relays[0]!.info.name).toBe('Renamed');
    expect(readFileSync(file, 'utf8')).toBe(original);
    const warns = logger.lines.filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0]!.fields).toMatchObject({ file, code: 'EACCES' });
    const cards = (await Promise.all(kernel.cards.map((s) => s.cards(null)))).flat();
    const card = cards.find((c) => c.id === 'runtime.config-writeback')!;
    expect(card.severity).toBe('warning');
    expect(card.body).toContain("can't be written to beamhop.yaml");
    expect(card.technical).toContain(file);
    expect(card.technical).toContain('EACCES');

    // Writable again: the next change brings the file fully up to date.
    chmodSync(file, 0o640);
    await change((c) => {
      c.relays[0]!.hosts = ['relay.example.com', 'b.example.com'];
    });
    const parsed = YAML.parse(readFileSync(file, 'utf8'));
    expect(parsed.privacy.ipLogging).toBe('off');
    expect(parsed.relays[0].info.name).toBe('Renamed');
    expect(parsed.relays[0].hosts).toEqual(['relay.example.com', 'b.example.com']);
    expect(writer.status().error).toBeUndefined();
    expect(writer.cards()).toEqual([]);
  });

  test('read-only directory (ConfigMap-style mount) is handled', async () => {
    if (process.getuid?.() === 0) return;
    const { dir, file, change, writer } = await boot();
    chmodSync(dir, 0o555);
    try {
      await change((c) => {
        c.privacy.ipLogging = 'off';
      });
      expect(writer.status().error?.code).toBe('EACCES');
      expect(YAML.parse(readFileSync(file, 'utf8')).privacy.ipLogging).toBe('hashed');
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});

describe('config helpers for write-back', () => {
  test('--no-config-writeback and BEAMHOP_CONFIG_WRITEBACK', () => {
    expect(parseArgs([]).configWriteBack).toBe(true);
    expect(parseArgs(['--no-config-writeback']).configWriteBack).toBe(false);
    expect(parseArgs([], { BEAMHOP_CONFIG_WRITEBACK: 'false' }).configWriteBack).toBe(false);
  });

  test('${VAR} interpolation', () => {
    const env = { A: 'x', N: '42' };
    expect(interpolateEnv({ a: '${A}', n: '${N}', s: 'p-${A}-${B:-d}', l: '$${A}' }, env)).toEqual({
      a: 'x',
      n: 42,
      s: 'p-x-d',
      l: '${A}',
    });
    expect(() => interpolateEnv('${MISSING}', env)).toThrow('MISSING');
  });

  test('override paths: env values not in the file, CLI flags', () => {
    const dir = tempDir('beamhop-wb-');
    const file = join(dir, 'beamhop.yaml');
    writeFileSync(file, 'privacy:\n  ipLogging: hashed\n');
    const loaded = loadConfig({
      env: { BEAMHOP_PRIVACY__IP_LOGGING: 'off', BEAMHOP_NODE__TRUST_PROXY: 'true' },
      args: { configPath: file, listen: '127.0.0.1:9' },
      cwd: dir,
    });
    expect(loaded.overridePaths).toContainEqual(['node', 'trustProxy']);
    expect(loaded.overridePaths).toContainEqual(['node', 'listen']);
    expect(loaded.overridePaths).not.toContainEqual(['privacy', 'ipLogging']);
  });

  test('configDiff', () => {
    expect(configDiff({ a: 1, b: [1, 2], c: { d: 1 } }, { a: 1, b: [1, 3], c: {} })).toEqual([
      { path: ['b', 1], value: 3 },
      { path: ['c', 'd'], value: undefined },
    ]);
    expect(configDiff({ b: [1] }, { b: [1, 2] })).toEqual([{ path: ['b'], value: [1, 2] }]);
  });
});

const BIND = canBind();
(BIND ? describe : describe.skip)('startServer wiring', () => {
  const start = async (extra: Partial<Parameters<typeof startServer>[0]>) => {
    const dir = tempDir('beamhop-wb-');
    const file = join(dir, 'beamhop.yaml');
    writeFileSync(file, `node:\n  dataDir: ${join(dir, 'data')}\nprivacy:\n  ipLogging: hashed\n`);
    const loaded = loadConfig({ env: {}, args: { configPath: file }, cwd: dir });
    const s = await startServer({
      config: loaded.config,
      modules: [adminApiModule],
      ports: memoryPorts(),
      hostname: '127.0.0.1',
      port: 0,
      print: () => {},
      shutdownTimeoutMs: 500,
      optionalModules: false,
      bootFile: file,
      overridePaths: loaded.overridePaths,
      ...extra,
    });
    const svc = s.kernel.use<AdminConfigService>('admin.config')!;
    const next = structuredClone((await svc.current()).config);
    next.privacy.ipLogging = 'off';
    await svc.apply(next, { principalId: 'test' });
    await s.stop('test');
    return { s, file };
  };

  test('a server started from a file writes app changes back to it', async () => {
    const { s, file } = await start({});
    expect(s.kernel.use(CONFIG_FILE_SERVICE)).toBeDefined();
    expect(YAML.parse(readFileSync(file, 'utf8')).privacy.ipLogging).toBe('off');
  });

  test('configWriteBack: false (--no-config-writeback) leaves the file alone', async () => {
    const { s, file } = await start({ configWriteBack: false });
    expect(s.kernel.use(CONFIG_FILE_SERVICE)).toBeUndefined();
    expect(YAML.parse(readFileSync(file, 'utf8')).privacy.ipLogging).toBe('hashed');
  });
});
