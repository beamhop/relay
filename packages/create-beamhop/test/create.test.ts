// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import {
  type Files,
  type Io,
  type RunOptions,
  type RunResult,
  type Runner,
  main,
  normalizeDomain,
  parsePubkey,
  setupCloudflare,
  slugify,
  wranglerToml,
} from '../src/index.ts';
import { parseOptions } from '../src/util.ts';

const NPUB = 'npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg';
const HEX = '7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e';
const D1_ID = '11111111-2222-3333-4444-555555555555';

/** Fake Cloudflare account: remembers what exists so a second run sees it. */
class FakeCloud implements Runner {
  calls: { cmd: string; opts: RunOptions }[] = [];
  loggedIn = false;
  globalWrangler = true;
  d1: { uuid: string; name: string }[] = [];
  buckets: string[] = [];
  secrets: string[] = [];
  owners = 0;
  claim: string | null = null;

  async run(cmd: string[], opts: RunOptions = {}): Promise<RunResult> {
    const line = cmd.join(' ');
    this.calls.push({ cmd: line, opts });
    const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
    const args = cmd[0] === 'npx' ? cmd.slice(3) : cmd.slice(1);
    const sub = args.join(' ');
    if (cmd[0] === 'npm') return ok('added 120 packages');
    if (cmd[0] === 'wrangler' && !this.globalWrangler)
      return { code: 127, stdout: '', stderr: 'not found' };
    if (sub === '--version') return ok('4.40.0');
    if (sub === 'whoami')
      return ok(
        this.loggedIn
          ? 'You are logged in with an OAuth Token, associated with the email a@b.c.'
          : 'You are not authenticated. Please run `wrangler login`.',
      );
    if (sub === 'login') {
      this.loggedIn = true;
      return ok();
    }
    if (sub === 'd1 list --json') return ok(JSON.stringify(this.d1));
    if (args[0] === 'd1' && args[1] === 'create') {
      this.d1.push({ uuid: D1_ID, name: args[2]! });
      return ok(
        `✅ Successfully created DB '${args[2]}'\n{\n  "d1_databases": [{ "binding": "DB", "database_name": "${args[2]}", "database_id": "${D1_ID}" }]\n}`,
      );
    }
    if (sub === 'r2 bucket list')
      return ok(
        `Listing buckets...\n${this.buckets.map((b) => `name:           ${b}\ncreation_date:  2025-01-01T00:00:00.000Z\n`).join('\n')}`,
      );
    if (args[0] === 'r2' && args[2] === 'create') {
      this.buckets.push(args[3]!);
      return ok(`Created bucket '${args[3]}'`);
    }
    if (args[0] === 'd1' && args[1] === 'migrations') return ok('No migrations to apply!');
    if (sub === 'deploy')
      return ok(
        'Uploaded my-relay\nDeployed my-relay triggers\n  https://my-relay.alice.workers.dev\n  schedule: * * * * *',
      );
    if (sub === 'secret list')
      return ok(JSON.stringify(this.secrets.map((name) => ({ name, type: 'secret_text' }))));
    if (args[0] === 'secret' && args[1] === 'put') {
      this.secrets.push(args[2]!);
      return ok('Success! Uploaded secret');
    }
    if (args[0] === 'd1' && args[1] === 'execute') {
      const sql = args[args.length - 1]!;
      const m = sql.match(/'(\{"code":[^']*\})'/);
      if (m && !this.claim && this.owners === 0) this.claim = m[1]!;
      return ok(
        JSON.stringify([
          { results: [], success: true },
          { results: [{ owners: this.owners, claim: this.claim }], success: true },
        ]),
      );
    }
    return { code: 1, stdout: '', stderr: `unexpected command: ${line}` };
  }

  /** Commands without the wrangler prefix, for readable assertions. */
  get commands(): string[] {
    return this.calls.map((c) => c.cmd.replace(/^npx --yes wrangler /, 'wrangler '));
  }
}

class MemFiles implements Files {
  data = new Map<string, string>();
  exists = (p: string) => this.data.has(p);
  read = (p: string) => this.data.get(p) ?? '';
  write = (p: string, c: string) => void this.data.set(p, c);
}

function memIo(answers: string[] = []): Io & { lines: string[]; asked: string[] } {
  const lines: string[] = [];
  const asked: string[] = [];
  return {
    lines,
    asked,
    log: (l = '') => void lines.push(l),
    async ask(q, fallback) {
      asked.push(q);
      return answers.shift() || fallback || '';
    },
  };
}

const deps = (runner: Runner, files: Files, io: Io) => ({
  runner,
  files,
  io,
  claimCode: () => 'ABCD-EFGH-JKMN-PQRS',
  secret: () => 'salty',
  now: () => 1_700_000_000_000,
});

describe('create-beamhop --cf', () => {
  test('fresh setup runs the full command sequence', async () => {
    const cloud = new FakeCloud();
    const files = new MemFiles();
    const io = memIo(['My Relay', '', NPUB]);
    const res = await setupCloudflare(parseOptions(['--cf']), deps(cloud, files, io));

    expect(io.asked).toHaveLength(3);
    expect(cloud.commands).toEqual([
      'wrangler --version',
      'wrangler whoami',
      'wrangler login',
      'npm install --no-fund --no-audit',
      'wrangler d1 list --json',
      'wrangler d1 create my-relay',
      'wrangler r2 bucket list',
      'wrangler r2 bucket create my-relay-blobs',
      'wrangler d1 migrations apply my-relay --remote',
      'wrangler deploy',
      'wrangler secret list',
      'wrangler secret put IP_HASH_SALT',
      expect.stringMatching(/^wrangler d1 execute my-relay --remote --json --command INSERT/),
    ]);
    expect(cloud.calls.find((c) => c.cmd.endsWith('login'))?.opts.interactive).toBe(true);
    expect(cloud.calls.find((c) => c.cmd.includes('secret put'))?.opts.input).toBe('salty');
    expect(cloud.calls.find((c) => c.cmd === 'wrangler deploy')?.opts.cwd).toBe('my-relay');

    expect(res).toMatchObject({
      projectDir: 'my-relay',
      url: 'https://my-relay.alice.workers.dev',
      adminUrl: 'https://my-relay.alice.workers.dev/admin/',
      claimCode: 'ABCD-EFGH-JKMN-PQRS',
      created: { d1: true, r2: true, secret: true },
    });
    const out = io.lines.join('\n');
    expect(out).toContain('Admin:       https://my-relay.alice.workers.dev/admin/');
    expect(out).toContain('Claim code:  ABCD-EFGH-JKMN-PQRS');
    expect(out).not.toContain('salty');

    const config = JSON.parse(files.read('my-relay/beamhop.config.json'));
    expect(config.relays[0]).toEqual({
      id: 'main',
      hosts: ['*'],
      info: { name: 'My Relay', description: '', pubkey: HEX },
    });
    expect(config.storage.driver).toBe('d1');
    const pkg = JSON.parse(files.read('my-relay/package.json'));
    expect(pkg.dependencies).toEqual({ '@beamhop/runtime-cf': 'latest' });
  });

  test('re-run reuses database, bucket, secret and claim code', async () => {
    const cloud = new FakeCloud();
    const files = new MemFiles();
    const flags = ['--cf', '--yes', '--name', 'My Relay'];
    await setupCloudflare(parseOptions(flags), deps(cloud, files, memIo()));
    files.write('my-relay/node_modules/@beamhop/runtime-cf/package.json', '{}');
    // user edits survive
    const cfg = JSON.parse(files.read('my-relay/beamhop.config.json'));
    cfg.plugins = ['spam-pack'];
    files.write('my-relay/beamhop.config.json', JSON.stringify(cfg));

    cloud.calls = [];
    const io = memIo();
    const res = await setupCloudflare(parseOptions(flags), {
      ...deps(cloud, files, io),
      claimCode: () => 'ZZZZ-ZZZZ-ZZZZ-ZZZZ',
    });
    expect(cloud.commands).toEqual([
      'wrangler --version',
      'wrangler whoami',
      'wrangler d1 list --json',
      'wrangler r2 bucket list',
      'wrangler d1 migrations apply my-relay --remote',
      'wrangler deploy',
      'wrangler secret list',
      expect.stringMatching(/^wrangler d1 execute/),
    ]);
    expect(res.created).toEqual({ d1: false, r2: false, secret: false });
    expect(res.claimCode).toBe('ABCD-EFGH-JKMN-PQRS'); // the unused code from the first run
    expect(cloud.d1).toHaveLength(1);
    expect(JSON.parse(files.read('my-relay/beamhop.config.json')).plugins).toEqual(['spam-pack']);
    expect(files.read('my-relay/wrangler.toml')).toContain(`database_id = "${D1_ID}"`);

    // once someone has claimed it, no code is printed
    cloud.owners = 1;
    const io2 = memIo();
    const again = await setupCloudflare(parseOptions(flags), deps(cloud, files, io2));
    expect(again.claimCode).toBeNull();
    expect(io2.lines.join('\n')).toContain('already has an owner');
  });

  test('falls back to npx when wrangler is not installed', async () => {
    const cloud = new FakeCloud();
    cloud.globalWrangler = false;
    cloud.loggedIn = true;
    await setupCloudflare(
      parseOptions(['--cf', '-y', '--name', 'x']),
      deps(cloud, new MemFiles(), memIo()),
    );
    expect(cloud.calls[1]?.cmd).toBe('npx --yes wrangler whoami');
    expect(cloud.calls.some((c) => c.cmd === 'npx --yes wrangler deploy')).toBe(true);
  });

  test('dry run prints every command and writes nothing', async () => {
    const cloud = new FakeCloud();
    const files = new MemFiles();
    const io = memIo();
    const res = await setupCloudflare(
      parseOptions([
        '--cf',
        '--dry-run',
        '--yes',
        '--name',
        'My Relay',
        '--domain',
        'relay.example.com',
      ]),
      deps(cloud, files, io),
    );
    expect(cloud.calls).toHaveLength(0);
    expect(files.data.size).toBe(0);
    const out = io.lines.join('\n');
    for (const cmd of [
      '$ wrangler --version',
      '$ wrangler whoami',
      '$ npm install --no-fund --no-audit  (in my-relay)',
      '$ wrangler d1 list --json',
      '$ wrangler d1 create my-relay',
      '$ wrangler r2 bucket create my-relay-blobs',
      '$ wrangler d1 migrations apply my-relay --remote  (in my-relay)',
      '$ wrangler deploy  (in my-relay)',
      '$ wrangler secret put IP_HASH_SALT  (in my-relay)  (value hidden)',
      '$ wrangler d1 execute my-relay --remote --json --command',
    ]) {
      expect(out).toContain(`[dry run] ${cmd}`);
    }
    expect(out).toContain('[dry run] would write my-relay/wrangler.toml');
    expect(out).toContain('database_id = "<new-d1-database-id>"');
    expect(out).toContain('Admin:       https://relay.example.com/admin/');
    expect(out).toContain('Nothing was changed');
    expect(res.adminUrl).toBe('https://relay.example.com/admin/');
  });

  test('without --cf prints the one-line installs', async () => {
    const io = memIo();
    expect(await main([], { io })).toBe(0);
    expect(io.lines.join('\n')).toContain('curl -fsSL https://get.beamhop.dev | sh');
  });

  test('failed step stops with a plain message', async () => {
    const cloud = new FakeCloud();
    cloud.loggedIn = true;
    const failing: Runner = {
      run: (cmd, o) =>
        cmd.includes('deploy')
          ? Promise.resolve({ code: 1, stdout: '', stderr: 'Error: zone not found' })
          : cloud.run(cmd, o),
    };
    const io = memIo();
    const code = await main(['--cf', '-y'], { ...deps(failing, new MemFiles(), io) });
    expect(code).toBe(1);
    expect(io.lines.join('\n')).toContain('Setup stopped: Could not deploy the Worker.');
  });
});

describe('wrangler.toml', () => {
  const base = {
    worker: 'my-relay',
    relayName: 'My Relay',
    d1Name: 'my-relay',
    d1Id: D1_ID,
    bucket: 'my-relay-blobs',
  };

  test('workers.dev setup has real bindings', () => {
    const toml = wranglerToml(base);
    expect(toml).toContain('name = "my-relay"');
    expect(toml).toContain('workers_dev = true');
    expect(toml).not.toContain('routes');
    expect(toml).toContain('binding = "DB"\ndatabase_name = "my-relay"');
    expect(toml).toContain(`database_id = "${D1_ID}"`);
    expect(toml).toContain(
      'migrations_dir = "node_modules/@beamhop/storage-sql/migrations/sqlite"',
    );
    expect(toml).toContain('binding = "BLOBS"\nbucket_name = "my-relay-blobs"');
    expect(toml).toContain('name = "RELAY_ROOM"\nclass_name = "RelayRoom"');
    expect(toml).toContain('new_sqlite_classes = ["RelayRoom"]');
    expect(toml).toContain('command = "npx beamhop-cf-build');
    expect(toml).toContain('crons = ["* * * * *"]');
    expect(toml).not.toContain('00000000-0000');
  });

  test('custom domain becomes a custom_domain route', () => {
    const toml = wranglerToml({ ...base, domain: 'relay.example.com' });
    expect(toml).toContain('routes = [{ pattern = "relay.example.com", custom_domain = true }]');
    expect(toml).not.toContain('workers_dev');
  });
});

describe('helpers', () => {
  test('npub decoding', () => {
    expect(parsePubkey(NPUB)).toBe(HEX);
    expect(parsePubkey(HEX)).toBe(HEX);
    expect(parsePubkey(`${NPUB.slice(0, -1)}q`)).toBeNull();
    expect(parsePubkey('nsec1abc')).toBeNull();
  });

  test('names and domains', () => {
    expect(slugify('My Cool Relay!')).toBe('my-cool-relay');
    expect(slugify('***')).toBe('beamhop');
    expect(normalizeDomain('https://Relay.Example.com/')).toBe('relay.example.com');
    expect(normalizeDomain('workers.dev')).toBeUndefined();
    expect(normalizeDomain('')).toBeUndefined();
    expect(() => normalizeDomain('not a domain')).toThrow();
  });
});
