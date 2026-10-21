// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Services the runtime provides for in-app updates, doctor and the resource
 * advisor. The system module itself is runtime-agnostic; on Bun the single
 * binary (packages/cli) provides the updater and doctor, runtime-bun the host
 * facts and process control. On Cloudflare none exist and the actions explain
 * how updates happen there instead.
 */

/** `kernel.use<Updater>(UPDATER_SERVICE)` — self-update of the running binary. */
export const UPDATER_SERVICE = 'runtime.updater';
/** `kernel.use<DoctorRunner>(DOCTOR_SERVICE)` — the `beamhop doctor` checks. */
export const DOCTOR_SERVICE = 'runtime.doctor';
/** `kernel.use<HostInfo>(HOST_SERVICE)` — machine facts for the resource advisor. */
export const HOST_SERVICE = 'runtime.host';

export type InstallKind =
  | 'binary'
  | 'docker'
  | 'systemd'
  | 'source'
  | 'readonly'
  | 'cloudflare'
  | 'unknown';

export interface InstallInfo {
  kind: InstallKind;
  /** This server can replace and restart itself from the app. */
  canSelfUpdate: boolean;
  /** Plain "how to update" when it cannot. */
  howTo?: string;
  technical?: string;
  /** How a self-update restarts: start the new binary, or exit for a supervisor. */
  restart?: 're-exec' | 'exit';
}

export type SignatureState =
  /** A release key is set and the release is signed: the download can be checked. */
  | 'verifiable'
  /** No release key is set (placeholder): downloads cannot be checked. */
  | 'no-key'
  /** A key is set but this release has no signature. */
  | 'unsigned-release';

export interface ReleaseCheck {
  current: string;
  /** null when the release server could not be reached. */
  latest: string | null;
  updateAvailable: boolean;
  notes?: string;
  /** Size of the download for this system, when the release lists it. */
  downloadBytes?: number;
  signature: SignatureState;
  /** Developer override: install even when the download cannot be checked. */
  allowUnsigned: boolean;
  /** Release manifest URL (technical lens). */
  source: string;
  /** Plain reason the check failed (latest is null). */
  error?: string;
  technical?: string;
}

export interface StagedRelease {
  version: string;
  /** Verified new binary next to the old one. */
  path: string;
  sha256: string;
  signed: boolean;
  bytes: number;
}

export interface UpdateProgress {
  done: number;
  total?: number;
}

/**
 * Self-update primitives. Errors thrown are plain-language (`Error.message`),
 * optionally with a `technical` property.
 */
export interface Updater {
  install(): Promise<InstallInfo>;
  check(): Promise<ReleaseCheck>;
  /** Download → checksum → signature → smoke test, next to the current binary. */
  stage(onProgress?: (p: UpdateProgress) => void): Promise<StagedRelease>;
  /** Atomic swap; the replaced binary is kept for rollback. */
  swap(staged: StagedRelease): Promise<{ previousVersion: string }>;
  /** Remove a staged download that will not be installed. */
  discard?(staged: StagedRelease): Promise<void>;
  /** A healthy boot after an update: clear the crash-loop guard. */
  confirm(): Promise<void>;
  /** The kept previous version, if any. */
  previous(): Promise<{ version: string } | null>;
  /** Put the previous binary back (the current one is kept as rolled-back). */
  rollback(): Promise<{ version: string }>;
  /** Restart into whatever binary is installed now. */
  restart(reason: string): Promise<void>;
}

export interface DoctorFinding {
  id: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  title: string;
  message: string;
  technical?: string;
  /** What `beamhop doctor --fix` would do (shown as advice; never applied from the app). */
  fixHint?: string;
}

export interface DoctorRunner {
  run(): Promise<DoctorFinding[]>;
}

export interface HostInfo {
  cpus: number;
  memoryBytes: number;
  /** Resident memory of this process now. */
  rssBytes(): number;
  /** Signature checking threads running now (0 = main thread). */
  verifyWorkers: number;
}
