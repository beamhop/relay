// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { kernelClient } from '../src/client.ts';
import { loginCommand } from '../src/commands/login.ts';
import { credentialsPath, readCredentials } from '../src/credentials.ts';
import { BufferIo, EXIT } from '../src/io.ts';
import { nsecSigner } from '../src/nostr.ts';
import { type TestNode, bootNode, cli, testContext } from './helpers.ts';

const NOW = 1_700_000_000_000; // memoryPorts FakeClock
const PK = 'ab'.repeat(32);
const PK2 = 'cd'.repeat(32);

async function loggedIn(relays?: string[]): Promise<TestNode & { token: string; home: string }> {
  const node = await bootNode(relays);
  const io = new BufferIo();
  const { ctx, home } = testContext({ io, now: () => NOW });
  const code = await loginCommand(
    ctx as never,
    ['http://localhost', '--claim-code', node.claimCode, '--name', 'test'],
    {},
    { client: kernelClient(node.kernel, undefined), signer: nsecSigner(node.ownerNsec) },
  );
  expect(code).toBe(EXIT.ok);
  const creds = readCredentials(credentialsPath({ HOME: home }, home));
  const token = creds.servers['http://localhost']!.token;
  return { ...node, token, home };
}

describe('login', () => {
  test('claims with NIP-98, saves an API token 0600 and never prints secrets', async () => {
    const node = await bootNode();
    const io = new BufferIo();
    const { ctx, home } = testContext({ io, now: () => NOW });
    const code = await loginCommand(
      ctx as never,
      ['http://localhost', '--claim-code', node.claimCode],
      {},
      { client: kernelClient(node.kernel, undefined), signer: nsecSigner(node.ownerNsec) },
    );
    expect(code).toBe(0);
    const path = credentialsPath({}, home);
    expect(path).toBe(join(home, '.config', 'beamhop', 'credentials.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, '.config', 'beamhop')).mode & 0o777).toBe(0o700);
    const creds = readCredentials(path);
    expect(creds.default).toBe('http://localhost');
    const saved = creds.servers['http://localhost']!;
    expect(saved.token).toMatch(/^bh_[0-9a-f]{16}_[0-9a-f]{48}$/);
    expect(saved.pubkey).toBe(node.ownerPk);
    // Neither the nsec nor the token is echoed; recovery codes go to stderr.
    expect(io.stdout + io.stderr).not.toContain(node.ownerNsec);
    expect(io.stdout + io.stderr).not.toContain(saved.token);
    expect(io.stderr).toContain('recovery codes');
    // The token works.
    const me = await kernelClient(node.kernel, `Bearer ${saved.token}`).request(
      'GET',
      '/nodes/self/auth/me',
    );
    expect(me.status).toBe(200);
  });

  test('bad claim code is refused in plain language', async () => {
    const node = await bootNode();
    const io = new BufferIo();
    const { ctx } = testContext({ io, now: () => NOW });
    await expect(
      loginCommand(
        ctx as never,
        ['http://localhost', '--claim-code', 'NOPE-NOPE'],
        {},
        { client: kernelClient(node.kernel, undefined), signer: nsecSigner(node.ownerNsec) },
      ),
    ).rejects.toThrow(/claim code is not valid/);
  });

  test('refuses to run without a signer when not interactive', async () => {
    const { ctx } = testContext({ now: () => NOW });
    const node = await bootNode();
    await expect(
      loginCommand(
        ctx as never,
        ['http://localhost'],
        {},
        {
          client: kernelClient(node.kernel, undefined),
        },
      ),
    ).rejects.toThrow(/No signer given/);
  });
});

describe('generated action commands', () => {
  test('preview without --yes changes nothing (exit 3); --yes applies; undo reverts', async () => {
    const n = await loggedIn();
    const prev = await cli(n, n.token, ['moderation', 'ban-pubkey', '--pubkey', PK]);
    expect(prev.code).toBe(EXIT.notApplied);
    expect(prev.err).toContain('abababab will be banned');
    expect(prev.err).toContain('Nothing was changed');
    expect(n.banned.get('main')?.has(PK) ?? false).toBe(false);

    const tech = await cli(n, n.token, [
      'moderation',
      'ban-pubkey',
      '--pubkey',
      PK,
      '--preview',
      '--technical',
    ]);
    expect(tech.code).toBe(0);
    expect(tech.err).toContain(`banpubkey ${PK}`);

    const applied = await cli(n, n.token, [
      'moderation',
      'ban-pubkey',
      '--pubkey',
      PK,
      '--yes',
      '--json',
    ]);
    expect(applied.code).toBe(0);
    const body = JSON.parse(applied.out);
    expect(body.summary).toBe('Banned abababab');
    expect(body.undo.token).toBeString();
    expect(n.banned.get('main')!.has(PK)).toBe(true);

    const list = await cli(n, n.token, ['moderation', 'list-banned']);
    expect(list.out).toContain(PK);

    const undo = await cli(n, n.token, ['undo', body.undo.token]);
    expect(undo.code).toBe(0);
    expect(undo.out).toContain('Undone');
    expect(n.banned.get('main')!.has(PK)).toBe(false);
  });

  test('interactive confirmation', async () => {
    const n = await loggedIn();
    const no = await cli(
      n,
      n.token,
      ['moderation', 'ban-pubkey', '--pubkey', PK],
      new BufferIo(['n'], true),
    );
    expect(no.code).toBe(EXIT.notApplied);
    const yes = await cli(
      n,
      n.token,
      ['moderation', 'ban-pubkey', '--pubkey', PK],
      new BufferIo(['y'], true),
    );
    expect(yes.code).toBe(0);
    expect(yes.out).toContain('Banned abababab');
    expect(yes.out).toContain('beamhop undo ');
  });

  test('--preview --json returns the diff only', async () => {
    const n = await loggedIn();
    const r = await cli(n, n.token, [
      'moderation',
      'ban-pubkey',
      '--pubkey',
      PK,
      '--preview',
      '--json',
    ]);
    expect(JSON.parse(r.out)).toEqual({
      action: 'moderation.ban-pubkey',
      items: 1,
      diff: [{ kind: 'add', text: 'abababab will be banned', technical: `banpubkey ${PK}` }],
    });
  });

  test('validation from the JSON Schema happens before any request', async () => {
    const n = await loggedIn();
    const bad = await cli(n, n.token, ['moderation', 'ban-pubkey', '--pubkey', 'xyz', '--yes']);
    expect(bad.code).toBe(EXIT.usage);
    expect(bad.err).toContain('--pubkey has the wrong format');
    const missing = await cli(n, n.token, ['moderation', 'ban-pubkey', '--yes']);
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.err).toContain('--pubkey is required');
    const unknown = await cli(n, n.token, ['moderation', 'ban-pubkey', '--nope', '1']);
    expect(unknown.code).toBe(EXIT.usage);
    const enumErr = await cli(n, n.token, ['admins', 'invite', '--pubkey', PK, '--role', 'king']);
    expect(enumErr.err).toContain('--role must be one of: owner, admin, moderator, viewer');
    expect(enumErr.code).toBe(EXIT.usage);
  });

  test('bulk from a file: one preview, one undo for all', async () => {
    const n = await loggedIn();
    const file = join(n.home, 'bans.ndjson');
    writeFileSync(file, `{"pubkey":"${PK}"}\n# comment\n{"pubkey":"${PK2}","reason":"spam"}\n`);
    const r = await cli(n, n.token, [
      'moderation',
      'ban-pubkey',
      '--from-file',
      file,
      '--yes',
      '--json',
    ]);
    expect(r.code).toBe(0);
    const body = JSON.parse(r.out);
    expect(body.summary).toBe('Ban a user: 2 done');
    expect([...n.banned.get('main')!]).toEqual([PK, PK2]);
    const undo = await cli(n, n.token, ['undo', body.undo.token]);
    expect(undo.code).toBe(0);
    expect(n.banned.get('main')!.size).toBe(0);
  });

  test('relay-scoped actions need --relay when there are several relays', async () => {
    const n = await loggedIn(['main', 'team']);
    const r = await cli(n, n.token, ['moderation', 'ban-pubkey', '--pubkey', PK, '--yes']);
    expect(r.code).toBe(EXIT.usage);
    expect(r.err).toContain('--relay team');
    const ok = await cli(n, n.token, [
      'moderation',
      'ban-pubkey',
      '--pubkey',
      PK,
      '--yes',
      '--relay',
      'team',
    ]);
    expect(ok.code).toBe(0);
    expect(n.banned.get('team')!.has(PK)).toBe(true);
  });

  test('help, groups, catalog listing and permission errors', async () => {
    const n = await loggedIn();
    const help = await cli(n, n.token, ['moderation', 'ban-pubkey', '--help']);
    expect(help.out).toContain('Usage: beamhop moderation ban-pubkey --pubkey <pubkey> [options]');
    const group = await cli(n, n.token, ['moderation']);
    expect(group.out).toContain('ban-pubkey');
    const all = await cli(n, n.token, ['actions']);
    expect(all.out).toContain('tokens');
    const nope = await cli(n, `bh_0000000000000000_${'0'.repeat(48)}`, ['actions']);
    expect(nope.code).toBe(1);
    expect(nope.err).toContain('beamhop login');
  });

  test('status shows health and cards', async () => {
    const n = await loggedIn();
    n.kernel.health.push({
      id: 'disk',
      subsystem: 'storage',
      weight: 1,
      async run() {
        return { score: 60, status: 'warn', message: 'Disk is filling up', technical: '80% used' };
      },
    } as never);
    n.kernel.cards.push({
      id: 'c',
      async cards() {
        return [
          {
            id: 'x',
            relayId: null,
            severity: 'warning',
            title: 'Spam wave',
            body: '12 new accounts posted the same link.',
            createdAt: 1,
            primary: {
              label: 'Ban them',
              actionId: 'moderation.ban-pubkey',
              input: { pubkey: PK },
            },
          },
        ];
      },
    });
    const r = await cli(n, n.token, ['status', '--technical']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Health 60/100');
    expect(r.out).toContain('80% used');
    expect(r.out).toContain('Spam wave');
    expect(r.out).toContain('beamhop moderation ban-pubkey');
  });

  test('config export, import (preview → apply → undo) and history', async () => {
    const n = await loggedIn();
    const exp = await cli(n, n.token, ['config', 'export']);
    expect(exp.code).toBe(0);
    expect(exp.out).toContain('relays:');
    const file = join(n.home, 'beamhop.yaml');
    writeFileSync(file, exp.out.replace(/name: Beamhop Relay/, 'name: Renamed'));
    const diff = await cli(n, n.token, ['config', 'diff', file]);
    expect(diff.out).toContain('Renamed');
    const pending = await cli(n, n.token, ['config', 'import', file]);
    expect(pending.code).toBe(EXIT.notApplied);
    const applied = await cli(n, n.token, ['config', 'import', file, '--yes']);
    expect(applied.code).toBe(0);
    expect(applied.out).toMatch(/Saved as revision \d+/);
    expect(n.kernel.config().relays[0]!.info.name).toBe('Renamed');
    const hist = await cli(n, n.token, ['config', 'history']);
    expect(hist.out.trim().split('\n').length).toBeGreaterThanOrEqual(2);
    const token = /beamhop undo (\S+)/.exec(applied.out)![1]!;
    expect((await cli(n, n.token, ['undo', token])).code).toBe(0);
    expect(n.kernel.config().relays[0]!.info.name).toBe('Beamhop Relay');
  });
});
