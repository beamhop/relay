// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the single binary adds to the server for the admin app's
 * "Updates & health" screen: the `runtime.updater` service (self-update with
 * the same code as `beamhop update`) and `runtime.doctor` (the `beamhop
 * doctor` checks). The `system.*` actions themselves live in @beamhop/lifecycle.
 *
 * Restart after an update: by default the server stops, starts the new
 * binary with the same arguments and watches it for a few seconds; if it dies
 * at once, the previous binary is put back and started instead. With
 * BEAMHOP_SELF_UPDATE=exit the process exits (code 75) for a supervisor to
 * restart it, and `bootGuard()` rolls back a new version that keeps crashing.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { constants, accessSync, existsSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { type BeamhopModule, type Kernel, defineModule } from '@beamhop/core';
import {
  DOCTOR_SERVICE,
  type DoctorFinding,
  type InstallInfo,
  SOURCE_HOW_TO,
  UPDATER_SERVICE,
  type Updater,
} from '@beamhop/lifecycle';
import { PROCESS_SERVICE, type ProcessControl, VERSION } from '@beamhop/runtime-bun';
import type { FetchLike } from './client.ts';
import { type DoctorProbes, defaultProbes, runDoctor } from './commands/doctor.ts';
import { defaultContext } from './context.ts';
import {
  type ReleaseSource,
  type RunBinary,
  type SignatureCheck,
  type UpdatesSettings,
  allowUnsignedFromEnv,
  checkRelease,
  fetchManifest,
  hostPlatform,
  pendingPath,
  previousVersion,
  resolveManifestUrl,
  resolvePublicKey,
  rollbackBinary,
  stageRelease,
  swapBinary,
} from './updater.ts';

type Env = Record<string, string | undefined>;

/** Exit code asking a supervisor to start the (new) binary. */
export const RESTART_EXIT_CODE = 75;

export const HOW_TO = {
  docker:
    'Beamhop runs in Docker. Update it by pulling the new image: `docker compose pull && docker compose up -d` (your data folder is kept).',
  systemd:
    'Beamhop runs as a system service. On the server run `sudo beamhop update`, then `sudo systemctl restart beamhop`.',
  readonly:
    'Beamhop cannot replace its own program file (no permission). On the server run `sudo beamhop update`, then restart it.',
  off: 'Updates from the app are turned off on this server (BEAMHOP_SELF_UPDATE=off). Run `beamhop update` on the server.',
} as const;

export interface InstallProbe {
  exists(path: string): boolean;
  writable(path: string): boolean;
}

const realProbe: InstallProbe = {
  exists: (p) => existsSync(p),
  writable: (p) => {
    try {
      accessSync(p, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Can this install replace itself? Single binary with a writable path → yes;
 * Docker, systemd-managed, read-only or running from source → no, with a plain
 * "how to update". BEAMHOP_SELF_UPDATE=re-exec|exit forces self-update (e.g. a
 * systemd unit with Restart=always and a writable binary), `off` disables it.
 */
export function detectInstall(env: Env, bin: string, probe: InstallProbe = realProbe): InstallInfo {
  const tech = `binary ${bin}`;
  if (/^bun(\.exe)?$/.test(basename(bin)))
    return { kind: 'source', canSelfUpdate: false, howTo: SOURCE_HOW_TO, technical: tech };
  const mode = env.BEAMHOP_SELF_UPDATE?.trim().toLowerCase();
  if (mode === 'off')
    return { kind: 'unknown', canSelfUpdate: false, howTo: HOW_TO.off, technical: tech };
  const forced = mode === 're-exec' || mode === 'exit';
  if (!forced) {
    if (env.container || env.BEAMHOP_DOCKER || probe.exists('/.dockerenv'))
      return {
        kind: 'docker',
        canSelfUpdate: false,
        howTo: HOW_TO.docker,
        technical: `${tech}; container detected`,
      };
    if (env.INVOCATION_ID || env.NOTIFY_SOCKET)
      return {
        kind: 'systemd',
        canSelfUpdate: false,
        howTo: HOW_TO.systemd,
        technical: `${tech}; systemd detected (INVOCATION_ID); BEAMHOP_SELF_UPDATE=exit allows app updates with Restart=always`,
      };
  }
  if (!probe.writable(dirname(bin)) || !probe.writable(bin))
    return {
      kind: 'readonly',
      canSelfUpdate: false,
      howTo: HOW_TO.readonly,
      technical: `${tech}; ${dirname(bin)} is not writable`,
    };
  return {
    kind: 'binary',
    canSelfUpdate: true,
    restart: mode === 'exit' ? 'exit' : 're-exec',
    technical: tech,
  };
}

export interface ChildLike {
  exited: Promise<number | null>;
  unref(): void;
}

export type SpawnFn = (cmd: string[], env: Env) => ChildLike;

const defaultSpawn: SpawnFn = (cmd, env) => {
  const [file, ...args] = cmd as [string, ...string[]];
  const child = nodeSpawn(file, args, { env, detached: true, stdio: 'inherit' });
  const exited = new Promise<number | null>((done) => {
    child.on('exit', (code) => done(code));
    child.on('error', () => done(-1));
  });
  return { exited, unref: () => child.unref() };
};

export interface BinaryUpdaterOptions {
  /** The binary to replace (default: process.execPath). */
  execPath: string;
  /** Arguments to start the server with again. */
  argv: string[];
  env: Env;
  fetch: FetchLike;
  /** `modules.updates` (manifestUrl, publicKey). */
  settings: () => UpdatesSettings;
  /** Stop the server before restarting (runtime-bun `runtime.process`). */
  stopServer?: (reason: string) => Promise<void>;
  now?: () => number;
  platform?: string;
  currentVersion?: string;
  run?: RunBinary;
  verifySignature?: SignatureCheck;
  spawn?: SpawnFn;
  exit?: (code: number) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Seconds to watch a re-executed binary before handing over (default 8). */
  watchSeconds?: number;
  install?: InstallProbe;
}

export function createBinaryUpdater(o: BinaryUpdaterOptions): Updater {
  const bin = o.execPath;
  const current = o.currentVersion ?? VERSION;
  const now = o.now ?? (() => Date.now());
  const exit = o.exit ?? ((code: number) => process.exit(code));
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms));
  const spawn = o.spawn ?? defaultSpawn;
  const source = (): ReleaseSource => {
    const s = o.settings();
    return {
      manifestUrl: resolveManifestUrl(o.env, s),
      publicKey: resolvePublicKey(o.env, s),
      allowUnsigned: allowUnsignedFromEnv(o.env),
      platform: o.platform ?? hostPlatform(),
      fetch: o.fetch,
    };
  };
  const install = () => detectInstall(o.env, bin, o.install);

  return {
    async install() {
      return install();
    },
    async check() {
      return checkRelease(source(), current);
    },
    async stage(onProgress) {
      const src = source();
      const manifest = await fetchManifest(src.fetch, src.manifestUrl);
      return stageRelease(src, manifest, {
        bin,
        env: { ...o.env },
        ...(onProgress ? { onProgress } : {}),
        ...(o.run ? { run: o.run } : {}),
        ...(o.verifySignature ? { verifySignature: o.verifySignature } : {}),
      });
    },
    async swap(staged) {
      return swapBinary(bin, staged, current, now());
    },
    async discard(staged) {
      const { rmSync } = await import('node:fs');
      rmSync(staged.path, { force: true });
    },
    async confirm() {
      const { rmSync } = await import('node:fs');
      rmSync(pendingPath(bin), { force: true });
    },
    async previous() {
      return previousVersion(bin);
    },
    async rollback() {
      return rollbackBinary(bin);
    },
    async restart(reason) {
      const how = install().restart ?? 're-exec';
      await o.stopServer?.(reason);
      if (how === 'exit') {
        exit(RESTART_EXIT_CODE);
        return;
      }
      const env = { ...o.env, BEAMHOP_RESTARTED_BY: reason };
      const child = spawn([bin, ...o.argv], env);
      const code = await Promise.race([
        child.exited,
        sleep((o.watchSeconds ?? 8) * 1000).then(() => 'running' as const),
      ]);
      if (code !== 'running' && code !== 0 && reason === 'update' && previousVersion(bin)) {
        // The new version died at once: put the previous one back and start it.
        try {
          rollbackBinary(bin);
        } catch {
          // keep going: start whatever is installed
        }
        spawn([bin, ...o.argv], env).unref();
      } else child.unref();
      exit(0);
    },
  };
}

export interface DoctorRunnerOptions {
  env: Env;
  fetch?: FetchLike;
  cwd?: string;
  configFile?: string;
  probes?: DoctorProbes;
}

/** `runtime.doctor`: the `beamhop doctor` checks against the running config. */
export function createDoctorRunner(kernel: Kernel, o: DoctorRunnerOptions) {
  return {
    async run(): Promise<DoctorFinding[]> {
      const ctx = defaultContext({
        env: o.env,
        ...(o.fetch ? { fetch: o.fetch } : {}),
        ...(o.cwd ? { cwd: o.cwd } : {}),
      });
      const probes = o.probes ?? defaultProbes(ctx);
      const findings = await runDoctor(
        {
          config: kernel.config(),
          cwd: o.cwd ?? process.cwd(),
          ...(o.configFile ? { configFile: o.configFile } : {}),
        },
        probes,
      );
      return findings.map((f) => ({
        id: f.id,
        status: f.status,
        title: f.title,
        message: f.message,
        ...(f.technical ? { technical: f.technical } : {}),
        ...(f.fix ? { fixHint: f.fix.description } : {}),
      }));
    },
  };
}

export interface BinarySystemOptions
  extends Omit<BinaryUpdaterOptions, 'settings' | 'stopServer' | 'fetch'> {
  fetch?: FetchLike;
  doctor?: Omit<DoctorRunnerOptions, 'env'>;
}

/** Module the single binary adds to the server: updater + doctor services. */
export function binarySystemModule(o: BinarySystemOptions): BeamhopModule {
  return defineModule({
    id: 'binary-system',
    register(kernel) {
      const fetchFn: FetchLike = o.fetch ?? ((input, init) => fetch(input, init));
      kernel.provide(
        UPDATER_SERVICE,
        createBinaryUpdater({
          ...o,
          fetch: fetchFn,
          settings: () => (kernel.config().modules.updates as UpdatesSettings | undefined) ?? {},
          stopServer: async (reason) => {
            await kernel.use<ProcessControl>(PROCESS_SERVICE)?.stop(reason);
          },
        }),
      );
      kernel.provide(
        DOCTOR_SERVICE,
        createDoctorRunner(kernel, { env: o.env, fetch: fetchFn, ...o.doctor }),
      );
    },
  });
}
