// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDataDir } from '@beamhop/runtime-bun';
import { runCli } from '../src/cli.ts';
import { resolveTarget } from '../src/context.ts';
import { saveServer } from '../src/credentials.ts';
import { BufferIo, EXIT } from '../src/io.ts';
import { testContext, tmp } from './helpers.ts';

function localNode() {
  const dir = tmp();
  const dataDir = join(dir, 'data');
  ensureDataDir(dataDir);
  writeFileSync(
    join(dir, 'beamhop.yaml'),
    `node:\n  dataDir: ${dataDir}\n  listen: 127.0.0.1:39999\nrelays:\n  - id: main\n    hosts: [relay.example.com]\n`,
  );
  return { dir, dataDir };
}

describe('local mode (in-process kernel on the data dir)', () => {
  test('runs generated actions against the real modules and SQLite, audited as the CLI', async () => {
    const { dir } = localNode();
    const io = new BufferIo();
    const { ctx } = testContext({ io, cwd: dir });
    const code = await runCli(['admins', 'list', '--json'], ctx);
    expect(io.stderr).toBe('');
    expect(code).toBe(0);
    expect(JSON.parse(io.stdout).output).toBeDefined();

    const io2 = new BufferIo();
    expect(await runCli(['claim-code'], { ...ctx, io: io2 })).toBe(0);
    expect(io2.stdout).toMatch(/Claim code: [A-Z0-9-]{9,}/);
    const io3 = new BufferIo();
    expect(await runCli(['claim-code'], { ...ctx, io: io3 })).toBe(0);
    expect(io3.stdout).toBe(io2.stdout); // stable until redeemed
  }, 30_000);

  test('refuses while the server is running, and when there is no data', async () => {
    const { dir } = localNode();
    const io = new BufferIo();
    const { ctx } = testContext({
      io,
      cwd: dir,
      fetch: (async (url: string) =>
        String(url).endsWith('/healthz')
          ? Response.json({ status: 'ok' })
          : new Response('', { status: 404 })) as never,
    });
    expect(await runCli(['admins', 'list'], ctx)).toBe(EXIT.error);
    expect(io.stderr).toContain('The server is running');
    expect(io.stderr).toContain('beamhop login');

    const empty = tmp();
    const io2 = new BufferIo();
    expect(await runCli(['status'], testContext({ io: io2, cwd: empty }).ctx)).toBe(EXIT.error);
    expect(io2.stderr).toContain('No Beamhop data found');
  });

  test('target resolution: --url, saved login, --local', () => {
    const { ctx, home } = testContext();
    const c = ctx as never;
    expect(resolveTarget(c, {})).toEqual({ kind: 'local' });
    saveServer(join(home, '.config', 'beamhop', 'credentials.json'), 'https://relay.example.com', {
      token: 'bh_saved',
      savedAt: 'x',
    });
    expect(resolveTarget(c, {})).toEqual({
      kind: 'remote',
      url: 'https://relay.example.com',
      token: 'bh_saved',
    });
    expect(resolveTarget(c, { local: true })).toEqual({ kind: 'local' });
    expect(resolveTarget(c, { url: 'other.example.com', token: 'bh_flag' })).toEqual({
      kind: 'remote',
      url: 'https://other.example.com',
      token: 'bh_flag',
    });
  });

  test('no arguments or server flags start the server; --version and help', async () => {
    const calls: string[][] = [];
    const serve = async (argv: string[]) => {
      calls.push(argv);
    };
    const { ctx } = testContext({ serve });
    expect(await runCli([], ctx)).toBe(0);
    expect(await runCli(['--healthcheck'], ctx)).toBe(0);
    expect(await runCli(['serve', '--listen', ':1'], ctx)).toBe(0);
    expect(calls).toEqual([[], ['--healthcheck'], ['--listen', ':1']]);
    const io = new BufferIo();
    expect(await runCli(['--version'], { ...ctx, io })).toBe(0);
    expect(io.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    const io2 = new BufferIo();
    expect(
      await runCli(['nonsense-command'], {
        ...ctx,
        io: io2,
        client: async () => ({
          mode: 'remote',
          target: 'x',
          urlFor: (p) => p,
          request: async () => ({
            status: 200,
            json: { actions: [] },
            text: '',
            headers: new Headers(),
          }),
          close: async () => {},
        }),
      }),
    ).toBe(EXIT.usage);
    expect(io2.stderr).toContain('Unknown command');
  });
});
