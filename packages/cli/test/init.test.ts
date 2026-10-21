// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@beamhop/core';
import { initCommand, normalizeDomain, renderInitYaml } from '../src/commands/init.ts';
import { forgetServer, readCredentials, saveServer } from '../src/credentials.ts';
import { BufferIo } from '../src/io.ts';
import { testContext, tmp } from './helpers.ts';

const parse = (yaml: string) => parseConfig(Bun.YAML.parse(yaml));

describe('init', () => {
  test('YAML output (snapshot) is valid config', () => {
    const yaml = renderInitYaml(
      {
        domain: 'relay.example.com',
        persona: 'private-team',
        storage: 'sqlite',
        email: 'me@example.com',
      },
      '2026-10-21',
    );
    expect(yaml).toMatchSnapshot();
    const c = parse(yaml);
    expect(c.relays[0]).toMatchObject({
      id: 'main',
      hosts: ['relay.example.com'],
      persona: 'private-team',
    });
    expect(c.node.tls).toEqual({ mode: 'auto', email: 'me@example.com' });

    const local = parse(
      renderInitYaml({ domain: null, persona: 'media-host', storage: 'memory' }, '2026-10-21'),
    );
    expect(local.relays[0]!.hosts).toEqual(['*']);
    expect(local.node.tls.mode).toBe('off');
    expect(local.storage.driver).toBe('memory');
    expect(local.blobStorage.driver).toBe('memory');

    const pg = renderInitYaml(
      {
        domain: 'r.example.org',
        persona: 'organization',
        storage: 'postgres',
        postgresUrl: 'postgres://u:p@db/bh',
      },
      '2026-10-21',
    );
    expect(parse(pg).storage).toEqual({ driver: 'postgres', url: 'postgres://u:p@db/bh' });
  });

  test('non-interactive flags write the file; existing files need --force', async () => {
    const dir = tmp();
    const { ctx } = testContext({ cwd: dir });
    expect(
      await initCommand(
        ctx as never,
        ['--domain', 'wss://Relay.Example.com/', '--persona', 'wot', '--storage', '1'],
        {},
      ),
    ).toBe(0);
    const c = parse(readFileSync(join(dir, 'beamhop.yaml'), 'utf8'));
    expect(c.relays[0]).toMatchObject({ hosts: ['relay.example.com'], persona: 'wot-community' });
    expect(c.storage.driver).toBe('sqlite');
    await expect(initCommand(ctx as never, [], {})).rejects.toThrow('--force');
    await expect(
      initCommand(ctx as never, ['--force', '--domain', 'not a domain'], {}),
    ).rejects.toThrow('does not look like a domain');
  });

  test('three interactive questions; a postgres URL is asked hidden and the file is private', async () => {
    const dir = tmp();
    const io = new BufferIo(
      ['relay.example.net', '2', 'postgres', 'postgres://u:secret@db/bh'],
      true,
    );
    const { ctx } = testContext({ io, cwd: dir });
    expect(await initCommand(ctx as never, [], {})).toBe(0);
    expect(io.prompts.length).toBe(4);
    const file = join(dir, 'beamhop.yaml');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const c = parse(readFileSync(file, 'utf8'));
    expect(c.relays[0]!.persona).toBe('private-team');
    expect(c.storage).toEqual({ driver: 'postgres', url: 'postgres://u:secret@db/bh' });
    expect(io.stdout).not.toContain('secret');
  });

  test('domain normalization', () => {
    expect(normalizeDomain(' HTTPS://Relay.Example.com/path ')).toBe('relay.example.com');
    expect(normalizeDomain('')).toBeNull();
    expect(normalizeDomain('*')).toBeNull();
  });
});

describe('credentials file', () => {
  test('0600 file in a 0700 directory; forget removes the entry', () => {
    const dir = tmp();
    const path = join(dir, 'cfg', 'beamhop', 'credentials.json');
    saveServer(path, 'https://a.example', { token: 'bh_x', savedAt: 'now' });
    saveServer(path, 'https://b.example', { token: 'bh_y', savedAt: 'now' }, false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'cfg', 'beamhop')).mode & 0o777).toBe(0o700);
    expect(readCredentials(path).default).toBe('https://a.example');
    expect(forgetServer(path, 'https://a.example')).toBe(true);
    const after = readCredentials(path);
    expect(Object.keys(after.servers)).toEqual(['https://b.example']);
    expect(after.default).toBe('https://b.example');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, 'garbage');
    expect(readCredentials(path).servers).toEqual({});
  });
});
