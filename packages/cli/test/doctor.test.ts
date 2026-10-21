// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig } from '@beamhop/core';
import {
  type CertInfo,
  type DoctorProbes,
  doctorCommand,
  doctorExitCode,
  runDoctor,
} from '../src/commands/doctor.ts';
import { BufferIo, EXIT } from '../src/io.ts';
import { testContext, tmp } from './helpers.ts';

const NOW = Date.UTC(2026, 9, 21);
const DAY = 86_400_000;

function goodCert(over: Partial<CertInfo> = {}): CertInfo {
  return {
    validFrom: NOW - 30 * DAY,
    validTo: NOW + 60 * DAY,
    issuer: "Let's Encrypt",
    names: ['relay.example.com'],
    trusted: true,
    ...over,
  };
}

/** Probes for a healthy server; override pieces per test. No network is touched. */
function probes(over: Partial<DoctorProbes> = {}): DoctorProbes {
  return {
    now: () => NOW,
    resolveDns: async () => ['203.0.113.7'],
    publicIps: async () => ['203.0.113.7'],
    certificate: async () => goodCert(),
    portOpen: async () => true,
    selfCheckHttp: async () => ({
      body: {
        ok: true,
        tls: 'acme',
        trustProxy: false,
        problems: [],
        seen: { host: 'relay.example.com', proto: 'https', forwardedFor: false },
      },
      date: NOW - 2000,
    }),
    selfCheckWs: async () => true,
    diskFree: async () => ({ free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 }),
    openDatabase: async () => ({ ok: true, detail: 'quick_check ok' }),
    blobRoundTrip: async () => ({ ok: true }),
    ...over,
  };
}

function setup() {
  const dir = tmp();
  const dataDir = join(dir, 'data');
  mkdirSync(join(dataDir, 'secrets'), { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o755);
  const config = parseConfig({
    node: { dataDir },
    relays: [{ id: 'main', hosts: ['relay.example.com'] }],
  });
  return { dir, dataDir, config };
}

const byId = (fs: Awaited<ReturnType<typeof runDoctor>>, id: string) => fs.find((f) => f.id === id);

describe('doctor checks (injected probes)', () => {
  test('a healthy setup passes every check', async () => {
    const { dir, config } = setup();
    const f = await runDoctor({ config, cwd: dir }, probes());
    expect(f.filter((x) => x.status !== 'ok')).toEqual([]);
    expect(f.map((x) => x.id)).toEqual([
      'config.valid',
      'data.writable',
      'disk.free',
      'storage.database',
      'storage.blobs',
      'dns.relay.example.com',
      'tls.relay.example.com',
      'port.listen',
      'proxy.headers',
      'proxy.websocket',
      'clock.skew',
    ]);
    expect(doctorExitCode(f)).toBe(EXIT.ok);
  });

  test('DNS pointing elsewhere is a warning; unknown domain fails and skips TLS/ports', async () => {
    const { dir, config } = setup();
    const elsewhere = await runDoctor(
      { config, cwd: dir },
      probes({ resolveDns: async () => ['198.51.100.1'] }),
    );
    expect(byId(elsewhere, 'dns.relay.example.com')?.status).toBe('warn');
    expect(byId(elsewhere, 'dns.relay.example.com')?.technical).toContain('198.51.100.1');
    const missing = await runDoctor(
      { config, cwd: dir },
      probes({
        resolveDns: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
    );
    expect(byId(missing, 'dns.relay.example.com')?.status).toBe('fail');
    expect(byId(missing, 'tls.relay.example.com')).toBeUndefined();
    expect(doctorExitCode(missing)).toBe(EXIT.error);
    const nat = await runDoctor({ config, cwd: dir }, probes({ publicIps: async () => [] }));
    expect(byId(nat, 'dns.relay.example.com')?.status).toBe('skip');
  });

  test('certificate problems: expired, expiring, wrong name, untrusted', async () => {
    const { dir, config } = setup();
    const run = async (c: Partial<CertInfo>) =>
      byId(
        await runDoctor({ config, cwd: dir }, probes({ certificate: async () => goodCert(c) })),
        'tls.relay.example.com',
      )!;
    expect((await run({ validTo: NOW - DAY })).status).toBe('fail');
    const soon = await run({ validTo: NOW + 5 * DAY });
    expect(soon.status).toBe('warn');
    expect(soon.message).toContain('5 day');
    expect((await run({ names: ['other.example.com'] })).message).toContain('different name');
    expect((await run({ names: ['*.example.com'] })).status).toBe('ok');
    expect((await run({ trusted: false })).message).toContain('not trusted');
  });

  test('proxy problems, blocked WebSocket, closed ports and clock skew', async () => {
    const { dir, config } = setup();
    const f = await runDoctor(
      { config, cwd: dir },
      probes({
        selfCheckHttp: async () => ({
          body: {
            ok: false,
            problems: [
              {
                message: "Your proxy isn't passing on the visitor's address",
                technical: 'no X-Forwarded-For',
              },
            ],
          },
          date: NOW - 400_000,
        }),
        selfCheckWs: async () => false,
        portOpen: async (_h, port) => port !== 80,
      }),
    );
    expect(byId(f, 'proxy.0')?.technical).toBe('no X-Forwarded-For');
    expect(byId(f, 'proxy.websocket')?.status).toBe('fail');
    expect(byId(f, 'port.relay.example.com.80')?.status).toBe('warn');
    expect(byId(f, 'clock.skew')?.status).toBe('fail');
    expect(byId(f, 'clock.skew')?.technical).toContain('ahead by 400s');
  });

  test('disk, database and media storage failures', async () => {
    const { dir, config } = setup();
    const f = await runDoctor(
      { config, cwd: dir },
      probes({
        diskFree: async () => ({ free: 200 * 1024 ** 2, total: 100 * 1024 ** 3 }),
        openDatabase: async () => ({ ok: false, error: 'SQLITE_CORRUPT' }),
        blobRoundTrip: async () => ({ ok: false, error: 'AccessDenied' }),
      }),
    );
    expect(byId(f, 'disk.free')?.status).toBe('fail');
    expect(byId(f, 'storage.database')).toMatchObject({
      status: 'fail',
      technical: 'SQLITE_CORRUPT',
    });
    expect(byId(f, 'storage.blobs')).toMatchObject({ status: 'fail', technical: 'AccessDenied' });
  });

  test('fixes: create the data dir and lock down the keys folder', async () => {
    const dir = tmp();
    const dataDir = join(dir, 'data');
    const config = parseConfig({ node: { dataDir }, relays: [{ id: 'main', hosts: ['*'] }] });
    const f = await runDoctor({ config, cwd: dir }, probes());
    const missing = byId(f, 'data.exists')!;
    expect(missing.status).toBe('warn');
    expect(byId(f, 'config.domain')?.status).toBe('warn');
    expect(await missing.fix!.apply()).toContain('Created');
    expect(existsSync(join(dataDir, 'db'))).toBe(true);
    chmodSync(join(dataDir, 'secrets'), 0o755);
    const again = await runDoctor({ config, cwd: dir }, probes());
    const secrets = byId(again, 'data.secrets')!;
    expect(secrets.status).toBe('warn');
    await secrets.fix!.apply();
    expect(statSync(join(dataDir, 'secrets')).mode & 0o777).toBe(0o700);
  });

  test('broken settings file: explained, and the fix keeps the old file', async () => {
    const dir = tmp();
    const file = join(dir, 'beamhop.yaml');
    writeFileSync(file, 'node: [oops\n');
    const io = new BufferIo();
    const { ctx } = testContext({ io, cwd: dir, now: () => NOW });
    const code = await doctorCommand(ctx as never, ['--fix'], { yes: true }, probes());
    expect(io.stdout).toContain('The settings file has a mistake');
    expect(io.stdout).toContain(`Saved the old file as ${file}.broken-${NOW}`);
    expect(readFileSync(`${file}.broken-${NOW}`, 'utf8')).toBe('node: [oops\n');
    expect(readFileSync(file, 'utf8')).toContain('version: 1');
    expect(code).not.toBe(EXIT.ok); // no domain + missing data dir remain as warnings/problems
  });

  test('command output: JSON and exit codes for CI', async () => {
    const { dir, dataDir } = setup();
    writeFileSync(
      join(dir, 'beamhop.yaml'),
      `node:\n  dataDir: ${dataDir}\nrelays:\n  - id: main\n    hosts: [relay.example.com]\n`,
    );
    const io = new BufferIo();
    const { ctx } = testContext({ io, cwd: dir, now: () => NOW });
    expect(await doctorCommand(ctx as never, [], { json: true }, probes())).toBe(EXIT.ok);
    const body = JSON.parse(io.stdout);
    expect(body.exitCode).toBe(0);
    expect(body.findings.length).toBeGreaterThan(5);
    const io2 = new BufferIo();
    const code = await doctorCommand(
      { ...ctx, io: io2 } as never,
      [],
      { technical: true },
      probes({
        selfCheckWs: async () => true,
        diskFree: async () => ({ free: 3 * 1024 ** 3, total: 100 * 1024 ** 3 }),
      }),
    );
    expect(code).toBe(EXIT.warnings);
    expect(io2.stdout).toContain('Disk space is getting low');
    expect(io2.stdout).toContain('3.0 GB free');
  });
});
