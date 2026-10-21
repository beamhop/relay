// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-app update on the single binary: the real updater (files in a temp dir,
 * fake release server, minisign) behind the `system.*` actions, the restart
 * watchdog, the crash-loop guard, install detection and the doctor service.
 */
import { describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ActionContext,
  type Principal,
  createKernel,
  defineModule,
  parseConfig,
} from '@beamhop/core';
import {
  type DoctorReport,
  UPDATER_SERVICE,
  type UpdateCheckOutput,
  type UpdateStatus,
  VERIFY_JOB,
  createLifecycleModule,
  createSystemModule,
} from '@beamhop/lifecycle';
import { MemoryBlobStore, memoryPorts } from '@beamhop/testkit';
import { ed25519 } from '@noble/curves/ed25519';
import { runCli } from '../src/cli.ts';
import type { DoctorProbes } from '../src/commands/doctor.ts';
import { publicKeyLine, signMinisign } from '../src/minisign.ts';
import {
  type ChildLike,
  RESTART_EXIT_CODE,
  type SpawnFn,
  binarySystemModule,
  createBinaryUpdater,
  createDoctorRunner,
  detectInstall,
} from '../src/system.ts';
import { bootGuard, pendingPath, swapBinary } from '../src/updater.ts';
import { testContext, tmp } from './helpers.ts';

const OWNER: Principal = { id: 'owner', roles: { '*': 'owner' }, via: 'cli' };
const enc = new TextEncoder();
const script = (version: string) =>
  `#!/bin/sh\ncase "$1" in\n  --version) echo "${version}" ;;\nesac\n`;
const shaHex = (t: string) => new Bun.CryptoHasher('sha256').update(t).digest('hex');

function releaseKey() {
  const sk = ed25519.utils.randomPrivateKey();
  const keyId = crypto.getRandomValues(new Uint8Array(8));
  return { sk, keyId, pub: publicKeyLine(sk, keyId) };
}

/** Fake release server: manifest + binary + signature (no network). */
function releaseServer(newBin: string, signature?: string) {
  const asset: Record<string, unknown> = {
    url: 'https://dl.example/beamhop-test-os',
    sha256: shaHex(newBin),
    size: newBin.length,
  };
  if (signature) asset.signature = signature;
  const manifest = { version: '0.2.0', notes: 'Faster sign-in.', assets: { 'test-os': asset } };
  return async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://dl.example/latest.json') return Response.json(manifest);
    if (url === 'https://dl.example/beamhop-test-os') return new Response(newBin);
    return new Response('not found', { status: 404 });
  };
}

function installed() {
  const dir = tmp();
  const bin = join(dir, 'beamhop');
  writeFileSync(bin, script('0.1.0'), { mode: 0o755 });
  return { dir, bin };
}

/** A fake child process: `code` → exits at once with it; undefined → keeps running. */
function fakeSpawn(codes: Array<number | undefined>) {
  const calls: Array<{ cmd: string[]; env: Record<string, string | undefined> }> = [];
  const spawn: SpawnFn = (cmd, env) => {
    calls.push({ cmd, env });
    const code = codes.shift();
    const child: ChildLike = {
      exited: code === undefined ? new Promise(() => {}) : Promise.resolve(code),
      unref: () => {},
    };
    return child;
  };
  return { spawn, calls };
}

async function bootKernel(o: {
  bin: string;
  version: string;
  fetch: ReturnType<typeof releaseServer>;
  env: Record<string, string | undefined>;
  spawn: SpawnFn;
  exits: number[];
  ports?: ReturnType<typeof memoryPorts>;
  target?: MemoryBlobStore;
}) {
  const ports = o.ports ?? memoryPorts();
  if (!o.ports)
    for (const s of [ports.events, ports.docs, ports.blobs, ports.blobIndex]) await s.init();
  const target = o.target ?? new MemoryBlobStore();
  const stopped: string[] = [];
  const updaterModule = defineModule({
    id: 'test-binary',
    register(k) {
      k.provide(
        UPDATER_SERVICE,
        createBinaryUpdater({
          execPath: o.bin,
          argv: ['--config', 'beamhop.yaml'],
          env: o.env,
          fetch: o.fetch as never,
          settings: () => ({ manifestUrl: 'https://dl.example/latest.json' }),
          stopServer: async (reason) => {
            stopped.push(reason);
          },
          platform: 'test-os',
          currentVersion: o.version,
          spawn: o.spawn,
          exit: (code) => {
            o.exits.push(code);
          },
          sleep: async () => {},
          install: { exists: () => false, writable: () => true },
        }),
      );
    },
  });
  const kernel = await createKernel({
    runtime: 'bun',
    ports,
    config: parseConfig({ relays: [{ id: 'main', hosts: ['relay.example.com'] }] }),
    modules: [
      createLifecycleModule({ backupTarget: target }),
      createSystemModule({ version: () => o.version, graceSeconds: 5, windowSeconds: 30 }),
      updaterModule,
    ],
  });
  const ctx: ActionContext = { principal: OWNER, relayId: null, ports };
  const run = async <O>(id: string, input: unknown = {}) => {
    const def = kernel.actions.get(id);
    if (!def) throw new Error(`no action ${id}`);
    return (await def.run(def.input.parse(input), ctx)).output as O;
  };
  const idle = () => (kernel.use('system.updates') as { idle(): Promise<void> }).idle();
  return { kernel, ports, run, idle, stopped, target };
}

describe('in-app update (single binary)', () => {
  test('signed release: backup → download → verify → swap → re-exec → healthy', async () => {
    const k = releaseKey();
    const newBin = script('0.2.0');
    const { bin } = installed();
    const fetch = releaseServer(newBin, signMinisign(enc.encode(newBin), k.sk, k.keyId));
    const env = { HOME: tmp(), BEAMHOP_UPDATE_PUBLIC_KEY: k.pub };
    const sp = fakeSpawn([undefined]); // the new binary keeps running
    const exits: number[] = [];
    const a = await bootKernel({ bin, version: '0.1.0', fetch, env, spawn: sp.spawn, exits });

    const chk = await a.run<UpdateCheckOutput>('system.update-check');
    expect(chk).toMatchObject({
      latest: '0.2.0',
      updateAvailable: true,
      canVerify: true,
      canSelfUpdate: true,
      downloadBytes: newBin.length,
    });
    await a.run('system.update', { version: '0.2.0' });
    await a.idle();

    expect(readFileSync(bin, 'utf8')).toBe(newBin);
    expect(readFileSync(`${bin}.previous`, 'utf8')).toBe(script('0.1.0'));
    expect(JSON.parse(readFileSync(pendingPath(bin), 'utf8'))).toMatchObject({
      from: '0.1.0',
      to: '0.2.0',
    });
    expect(a.stopped).toEqual(['update']);
    expect(sp.calls[0]?.cmd).toEqual([bin, '--config', 'beamhop.yaml']);
    expect(exits).toEqual([0]);
    const st = await a.run<UpdateStatus>('system.update-status');
    expect(st.phase).toBe('restarting');
    expect(st.backupId).toBeTruthy();

    // The new binary boots on the same data and passes its self-test.
    const b = await bootKernel({
      bin,
      version: '0.2.0',
      fetch,
      env,
      spawn: sp.spawn,
      exits,
      ports: a.ports,
      target: a.target,
    });
    b.ports.clock.advance(6);
    await b.ports.scheduler.tick(VERIFY_JOB);
    expect((await b.run<UpdateStatus>('system.update-status')).phase).toBe('done');
    expect(existsSync(pendingPath(bin))).toBe(false);
  });

  test('bad signature or no release key: refused, nothing changes', async () => {
    const k = releaseKey();
    const other = releaseKey();
    const newBin = script('0.2.0');
    const { bin, dir } = installed();
    const forged = releaseServer(newBin, signMinisign(enc.encode(newBin), other.sk, other.keyId));
    const sp = fakeSpawn([]);
    const exits: number[] = [];
    const a = await bootKernel({
      bin,
      version: '0.1.0',
      fetch: forged,
      env: { BEAMHOP_UPDATE_PUBLIC_KEY: k.pub },
      spawn: sp.spawn,
      exits,
    });
    await a.run('system.update', {});
    await a.idle();
    const st = await a.run<UpdateStatus>('system.update-status');
    expect(st.phase).toBe('failed');
    expect(st.message).toBe('The download is not signed by Beamhop; nothing was changed.');
    expect(readFileSync(bin, 'utf8')).toBe(script('0.1.0'));
    expect(existsSync(`${bin}.previous`)).toBe(false);
    expect(sp.calls).toEqual([]);
    expect(
      (await Array.fromAsync(new Bun.Glob('.beamhop.download-*').scan({ cwd: dir, dot: true })))
        .length,
    ).toBe(0);

    // Placeholder key: the check says why, and the update is refused up front.
    const b = await bootKernel({
      bin,
      version: '0.1.0',
      fetch: releaseServer(newBin),
      env: {},
      spawn: sp.spawn,
      exits,
    });
    const chk = await b.run<UpdateCheckOutput>('system.update-check');
    expect(chk.signature).toBe('no-key');
    expect(chk.blocked).toContain('no release signing key');
    await expect(b.run('system.update', {})).rejects.toThrow('cannot check that this download');
  });

  test('restart watchdog: a new binary that dies at once is replaced by the previous one', async () => {
    const { bin } = installed();
    const newBin = script('0.2.0');
    const staged = join(tmp(), 'staged');
    writeFileSync(staged, newBin, { mode: 0o755 });
    swapBinary(bin, { path: staged, version: '0.2.0' }, '0.1.0', Date.now());
    const sp = fakeSpawn([1, undefined]);
    const exits: number[] = [];
    const stopped: string[] = [];
    const u = createBinaryUpdater({
      execPath: bin,
      argv: [],
      env: {},
      fetch: (async () => new Response('', { status: 404 })) as never,
      settings: () => ({}),
      stopServer: async (r) => {
        stopped.push(r);
      },
      spawn: sp.spawn,
      exit: (c) => {
        exits.push(c);
      },
      sleep: () => new Promise(() => {}),
      install: { exists: () => false, writable: () => true },
    });
    await u.restart('update');
    expect(stopped).toEqual(['update']);
    expect(sp.calls).toHaveLength(2);
    expect(readFileSync(bin, 'utf8')).toBe(script('0.1.0'));
    expect(readFileSync(`${bin}.rolled-back`, 'utf8')).toBe(newBin);
    expect(exits).toEqual([0]);

    // Supervisor mode: exit and let it start the new binary.
    const ex: number[] = [];
    const sup = createBinaryUpdater({
      execPath: bin,
      argv: [],
      env: { BEAMHOP_SELF_UPDATE: 'exit' },
      fetch: (async () => new Response('')) as never,
      settings: () => ({}),
      exit: (c) => {
        ex.push(c);
      },
      install: { exists: () => false, writable: () => true },
    });
    await sup.restart('update');
    expect(ex).toEqual([RESTART_EXIT_CODE]);
  });

  test('crash-loop guard rolls back after repeated failed starts', () => {
    const { bin } = installed();
    const staged = join(tmp(), 'staged');
    writeFileSync(staged, script('0.2.0'), { mode: 0o755 });
    swapBinary(bin, { path: staged, version: '0.2.0' }, '0.1.0', Date.now());
    expect(bootGuard(bin, '0.1.0')).toBe('none');
    expect(bootGuard(bin, '0.2.0')).toBe('counted');
    expect(bootGuard(bin, '0.2.0')).toBe('counted');
    expect(bootGuard(bin, '0.2.0')).toBe('counted');
    expect(bootGuard(bin, '0.2.0')).toBe('rolled-back');
    expect(readFileSync(bin, 'utf8')).toBe(script('0.1.0'));
    expect(existsSync(pendingPath(bin))).toBe(false);
  });

  test('install detection: binary, Docker, systemd, read-only, source, override', () => {
    const w = { exists: () => false, writable: () => true };
    expect(detectInstall({}, '/opt/beamhop/beamhop', w)).toMatchObject({
      kind: 'binary',
      canSelfUpdate: true,
      restart: 're-exec',
    });
    expect(detectInstall({ container: 'docker' }, '/usr/local/bin/beamhop', w)).toMatchObject({
      kind: 'docker',
      canSelfUpdate: false,
    });
    expect(
      detectInstall({}, '/x/beamhop', { exists: (p) => p === '/.dockerenv', writable: () => true })
        .howTo,
    ).toContain('docker compose pull');
    expect(detectInstall({ INVOCATION_ID: 'abc' }, '/x/beamhop', w)).toMatchObject({
      kind: 'systemd',
      canSelfUpdate: false,
    });
    expect(
      detectInstall({ INVOCATION_ID: 'abc', BEAMHOP_SELF_UPDATE: 'exit' }, '/x/beamhop', w),
    ).toMatchObject({ kind: 'binary', canSelfUpdate: true, restart: 'exit' });
    expect(
      detectInstall({}, '/usr/bin/beamhop', { exists: () => false, writable: () => false }).kind,
    ).toBe('readonly');
    expect(detectInstall({}, '/home/me/.bun/bin/bun', w).kind).toBe('source');
    expect(detectInstall({ BEAMHOP_SELF_UPDATE: 'off' }, '/x/beamhop', w).canSelfUpdate).toBe(
      false,
    );
  });
});

describe('in-app doctor', () => {
  test('runs the beamhop doctor checks against the running config', async () => {
    const dir = tmp();
    const dataDir = join(dir, 'data');
    mkdirSync(join(dataDir, 'secrets'), { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o755);
    const NOW = Date.UTC(2026, 9, 21);
    const probes: DoctorProbes = {
      now: () => NOW,
      resolveDns: async () => ['203.0.113.7'],
      publicIps: async () => ['203.0.113.7'],
      certificate: async () => null,
      portOpen: async () => true,
      selfCheckHttp: async () => null,
      selfCheckWs: async () => false,
      diskFree: async () => ({ free: 1024 ** 3, total: 100 * 1024 ** 3 }),
      openDatabase: async () => ({ ok: true, detail: 'quick_check ok' }),
      blobRoundTrip: async () => ({ ok: true }),
    };
    const ports = memoryPorts();
    const kernel = await createKernel({
      runtime: 'bun',
      ports,
      config: parseConfig({
        node: { dataDir, tls: { mode: 'off' } },
        relays: [{ id: 'main', hosts: ['relay.example.com'] }],
      }),
      modules: [
        createLifecycleModule({ backupTarget: new MemoryBlobStore() }),
        createSystemModule(),
        defineModule({
          id: 'doctor-test',
          register(k) {
            k.provide('runtime.doctor', createDoctorRunner(k, { env: {}, cwd: dir, probes }));
          },
        }),
      ],
    });
    const def = kernel.actions.get('system.doctor');
    const r = (await def?.run({}, { principal: OWNER, relayId: null, ports }))
      ?.output as DoctorReport;
    expect(r.fullChecks).toBe(true);
    const disk = r.results.find((x) => x.id === 'disk.free');
    expect(disk?.tone).not.toBe('green');
    expect(disk?.fix?.actionId).toBe('lifecycle.prune-storage');
    expect(r.results.some((x) => x.id === 'port.listen')).toBe(true);
    expect(r.results.some((x) => x.id === 'lifecycle.backups' && x.source === 'health')).toBe(true);
  });

  test('binarySystemModule provides the updater and doctor services', async () => {
    const ports = memoryPorts();
    const kernel = await createKernel({
      runtime: 'bun',
      ports,
      config: parseConfig({}),
      modules: [binarySystemModule({ execPath: '/x/beamhop', argv: [], env: {} })],
    });
    expect(kernel.use('runtime.updater')).toBeTruthy();
    expect(kernel.use('runtime.doctor')).toBeTruthy();
  });
});

describe('server flags', () => {
  test('`beamhop --verify-workers N` starts the server without `serve`', async () => {
    const served: string[][] = [];
    const { ctx } = testContext({
      serve: async (argv) => {
        served.push(argv);
      },
    });
    expect(await runCli(['--verify-workers', '2'], ctx)).toBe(0);
    expect(await runCli(['--verify-workers=0', '--listen', '127.0.0.1:0'], ctx)).toBe(0);
    expect(served).toEqual([
      ['--verify-workers', '2'],
      ['--verify-workers=0', '--listen', '127.0.0.1:0'],
    ]);
  });
});
