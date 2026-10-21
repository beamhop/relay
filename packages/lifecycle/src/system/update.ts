// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One-tap update (§14): back up → download → check signature → swap → restart
 * → health self-test after boot → automatic rollback when the new version is
 * unhealthy. The state lives in the DocStore (`system.update/state`) so it
 * survives the restart and the app can poll it (`system.update-status`).
 *
 * Health self-test: after `graceSeconds`, any health check that is critical now
 * but was not critical before the update counts against the new version. Still
 * failing after `windowSeconds` → put the previous binary back and restart. The
 * pre-update backup is offered (never restored automatically).
 */
import { BEAMHOP_VERSION, type DiffLine, type Kernel } from '@beamhop/core';
import type { LifecycleService } from '../index.ts';
import {
  type InstallInfo,
  type ReleaseCheck,
  UPDATER_SERVICE,
  type UpdateProgress,
  type Updater,
} from './types.ts';

export const UPDATE_COL = 'system.update';
export const VERIFY_JOB = 'system.update-verify';

export const CLOUDFLARE_HOW_TO =
  'Updates on Cloudflare happen through `npm create beamhop -- --cf` again or your deploy pipeline.';
export const SOURCE_HOW_TO =
  'This server runs from source code. Update it with `git pull` and start it again.';

export type UpdatePhase =
  | 'idle'
  | 'backing-up'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'restarting'
  | 'checking'
  | 'done'
  | 'failed'
  | 'rolled-back';

/** Phases during which another update or a rollback must wait. */
export const BUSY_PHASES: readonly UpdatePhase[] = [
  'backing-up',
  'downloading',
  'verifying',
  'installing',
  'restarting',
  'checking',
];

export interface UpdateState {
  phase: UpdatePhase;
  from?: string;
  to?: string;
  /** Unix seconds. */
  startedAt?: number;
  updatedAt: number;
  /** Plain-language status line. */
  message: string;
  technical?: string;
  /** Backup made right before the update (offered after a rollback). */
  backupId?: string;
  backupSize?: number;
  progress?: UpdateProgress;
  /** Health checks already critical before the update (not blamed on it). */
  baselineCritical?: string[];
  checkingSince?: number;
  /** The new version was unhealthy and Beamhop went back by itself. */
  autoRolledBack?: boolean;
}

export interface UpdateStatus extends UpdateState {
  /** Version running now. */
  current: string;
  /** The kept previous version (system.rollback goes back to it). */
  previousVersion: string | null;
  busy: boolean;
}

export interface UpdateOptions {
  /** Seconds after boot before the health self-test starts (default 15). */
  graceSeconds?: number;
  /** Seconds the new version has to become healthy (default 60). */
  windowSeconds?: number;
  /** How often the self-test runs (default 5). */
  checkEverySeconds?: number;
  /** Version of the running code (tests). */
  version?: () => string;
}

export interface UpdateCheckOutput {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  notes?: string;
  /** First lines of the release notes. */
  notesSummary?: string;
  downloadBytes?: number;
  /** The download can be checked against the release signing key. */
  canVerify: boolean;
  signature: ReleaseCheck['signature'] | 'unknown';
  allowUnsigned: boolean;
  install: InstallInfo;
  canSelfUpdate: boolean;
  /** Plain reason an update cannot be installed from the app right now. */
  blocked?: string;
  runtime: string;
  technical: string;
  error?: string;
}

class PlainError extends Error {
  constructor(
    message: string,
    readonly technical?: string,
  ) {
    super(message);
  }
}

const techOf = (err: unknown): string | undefined =>
  (err as { technical?: string } | null)?.technical ??
  (err instanceof Error ? undefined : String(err));

export function signatureBlock(chk: Pick<ReleaseCheck, 'signature' | 'allowUnsigned'>) {
  if (chk.signature === 'verifiable' || chk.allowUnsigned) return undefined;
  return chk.signature === 'no-key'
    ? 'Beamhop cannot check that this download is genuine yet (no release signing key is set up), so it will not install it. A developer can allow it with BEAMHOP_UPDATE_ALLOW_UNSIGNED=1.'
    : 'This release is not signed, so Beamhop will not install it.';
}

export function summarizeNotes(notes: string | undefined, lines = 3): string | undefined {
  const l = (notes ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!l.length) return undefined;
  return l.slice(0, lines).join('\n') + (l.length > lines ? '\n…' : '');
}

export function mb(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${Math.round(bytes / (1024 * 1024))} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export class UpdateManager {
  private job: Promise<void> | null = null;
  private live: UpdateState | null = null;
  readonly graceSeconds: number;
  readonly windowSeconds: number;
  readonly checkEverySeconds: number;

  constructor(
    private readonly kernel: Kernel,
    opts: UpdateOptions = {},
  ) {
    this.graceSeconds = opts.graceSeconds ?? 15;
    this.windowSeconds = opts.windowSeconds ?? 60;
    this.checkEverySeconds = opts.checkEverySeconds ?? 5;
    this.version = opts.version ?? (() => BEAMHOP_VERSION);
  }

  readonly version: () => string;

  private now() {
    return this.kernel.ports.clock.now();
  }

  private log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
    this.kernel.ports.logger.log(level, msg, { module: 'system', ...fields });
  }

  updater(): Updater | undefined {
    return this.kernel.use<Updater>(UPDATER_SERVICE);
  }

  async install(): Promise<InstallInfo> {
    if (this.kernel.runtime === 'cloudflare')
      return { kind: 'cloudflare', canSelfUpdate: false, howTo: CLOUDFLARE_HOW_TO };
    const u = this.updater();
    if (!u)
      return {
        kind: 'source',
        canSelfUpdate: false,
        howTo: SOURCE_HOW_TO,
        technical: `no ${UPDATER_SERVICE} service (runtime ${this.kernel.runtime})`,
      };
    return u.install();
  }

  // ── state ──

  async state(): Promise<UpdateState> {
    if (this.live) return this.live;
    const s = await this.kernel.ports.docs.get<UpdateState>(UPDATE_COL, 'state');
    return s ?? { phase: 'idle', updatedAt: 0, message: 'No update has run yet' };
  }

  private async save(patch: Partial<UpdateState>): Promise<UpdateState> {
    const prev = await this.state();
    const next: UpdateState = { ...prev, ...patch, updatedAt: this.now() };
    for (const k of Object.keys(patch) as Array<keyof UpdateState>)
      if (patch[k] === undefined) delete next[k];
    this.live = next;
    await this.kernel.ports.docs.put(UPDATE_COL, 'state', next);
    return next;
  }

  async status(): Promise<UpdateStatus> {
    const s = await this.state();
    const prev = await this.updater()
      ?.previous()
      .catch(() => null);
    return {
      ...s,
      current: this.version(),
      previousVersion: prev?.version ?? null,
      busy: BUSY_PHASES.includes(s.phase),
    };
  }

  // ── check ──

  async check(): Promise<UpdateCheckOutput> {
    const install = await this.install();
    const u = this.updater();
    const base = {
      current: this.version(),
      install,
      canSelfUpdate: install.canSelfUpdate,
      runtime: this.kernel.runtime,
    };
    if (!u)
      return {
        ...base,
        latest: null,
        updateAvailable: false,
        canVerify: false,
        signature: 'unknown',
        allowUnsigned: false,
        blocked: install.howTo,
        technical: install.technical ?? `runtime ${this.kernel.runtime}`,
      };
    const chk = await u.check();
    const notesSummary = summarizeNotes(chk.notes);
    const blocked = !install.canSelfUpdate
      ? install.howTo
      : chk.latest === null
        ? chk.error
        : chk.updateAvailable
          ? signatureBlock(chk)
          : undefined;
    return {
      ...base,
      current: chk.current,
      latest: chk.latest,
      updateAvailable: chk.updateAvailable,
      ...(chk.notes ? { notes: chk.notes } : {}),
      ...(notesSummary ? { notesSummary } : {}),
      ...(chk.downloadBytes ? { downloadBytes: chk.downloadBytes } : {}),
      canVerify: chk.signature === 'verifiable',
      signature: chk.signature,
      allowUnsigned: chk.allowUnsigned,
      ...(blocked ? { blocked } : {}),
      ...(chk.error ? { error: chk.error } : {}),
      technical: [
        `manifest ${chk.source}`,
        `install ${install.kind}${install.restart ? ` (restart: ${install.restart})` : ''}`,
        `signature ${chk.signature}${chk.allowUnsigned ? ' (unsigned allowed: BEAMHOP_UPDATE_ALLOW_UNSIGNED)' : ''}`,
        chk.technical,
        install.technical,
      ]
        .filter(Boolean)
        .join(' · '),
    };
  }

  private lifecycle(): LifecycleService | undefined {
    return this.kernel.use<LifecycleService>('lifecycle');
  }

  private async backupEstimate(): Promise<number | undefined> {
    const last = await this.lifecycle()
      ?.lastBackup()
      .catch(() => null);
    return last?.ok ? last.size : undefined;
  }

  /** Plain step list for the preview ("Back up data (≈120 MB) → download 0.2.0 → …"). */
  async previewSteps(input: { skipBackup?: boolean }): Promise<DiffLine[]> {
    const chk = await this.check();
    if (chk.blocked && (!chk.canSelfUpdate || chk.updateAvailable))
      return [{ kind: 'warning', text: chk.blocked, technical: chk.technical }];
    if (!chk.updateAvailable || !chk.latest)
      return [{ kind: 'info', text: `You already have the latest version (${chk.current})` }];
    const lines: DiffLine[] = [];
    if (input.skipBackup)
      lines.push({
        kind: 'warning',
        text: 'Skip the backup: if the update goes wrong, recent data cannot be restored',
      });
    else {
      const size = await this.backupEstimate();
      lines.push({
        kind: 'add',
        text: `Back up your data${size ? ` (≈${mb(size)})` : ''}`,
        technical: 'backups.run-now (lifecycle) before anything changes',
      });
    }
    lines.push(
      {
        kind: 'change',
        text: `Download version ${chk.latest}${chk.downloadBytes ? ` (${mb(chk.downloadBytes)})` : ''}`,
        technical: chk.technical,
      },
      {
        kind: 'info',
        text: chk.canVerify
          ? 'Check that it is the genuine release'
          : 'Check the download (the signature cannot be checked: developer override)',
        technical: 'SHA-256 + minisign (Ed25519) signature, then `--version` smoke test',
      },
      {
        kind: 'change',
        text: `Restart into ${chk.latest} (about 5 seconds offline)`,
        technical: `atomic rename; previous binary kept; restart: ${chk.install.restart ?? 're-exec'}`,
      },
      {
        kind: 'info',
        text: 'If the new version is not healthy within a minute, Beamhop goes back by itself',
        technical: `health self-test after ${this.graceSeconds}s, window ${this.windowSeconds}s; new critical health checks → rollback`,
      },
    );
    if (chk.notesSummary) lines.push({ kind: 'info', text: `What's new: ${chk.notesSummary}` });
    return lines;
  }

  // ── run ──

  private async criticalIds(): Promise<string[]> {
    const out: string[] = [];
    for (const check of this.kernel.health) {
      try {
        if ((await check.run(null)).status === 'critical') out.push(check.id);
      } catch {
        // A broken check is not evidence of a broken update.
      }
    }
    return out;
  }

  /** Validate and start the update in the background; returns the first state. */
  async start(input: { version?: string; skipBackup?: boolean }): Promise<UpdateState> {
    const cur = await this.state();
    if (this.job || BUSY_PHASES.includes(cur.phase))
      throw new PlainError('An update is already running.', `phase ${cur.phase}`);
    const install = await this.install();
    const u = this.updater();
    if (!u || !install.canSelfUpdate)
      throw new PlainError(install.howTo ?? 'This server cannot update itself.', install.technical);
    const chk = await u.check();
    if (chk.latest === null)
      throw new PlainError(chk.error ?? 'Could not reach the release server.', chk.technical);
    if (!chk.updateAvailable)
      throw new PlainError(`You already have the latest version (${chk.current}).`);
    if (input.version && input.version !== chk.latest)
      throw new PlainError(
        `Version ${input.version} is no longer the newest (${chk.latest} is). Check again.`,
      );
    const block = signatureBlock(chk);
    if (block) throw new PlainError(block, `signature ${chk.signature}; ${chk.source}`);
    if (!input.skipBackup && !this.lifecycle())
      throw new PlainError(
        'Backups are not available here, so the update was not started. Turn backups on first.',
        'lifecycle service missing',
      );
    const baselineCritical = await this.criticalIds();
    const state = await this.save({
      phase: 'backing-up',
      from: chk.current,
      to: chk.latest,
      startedAt: this.now(),
      message: input.skipBackup ? 'Getting ready' : 'Backing up your data',
      technical: undefined,
      backupId: undefined,
      backupSize: undefined,
      progress: undefined,
      baselineCritical,
      checkingSince: undefined,
      autoRolledBack: undefined,
    });
    this.log('info', 'update started', { from: chk.current, to: chk.latest });
    const p: Promise<void> = this.runJob(u, chk.latest, !!input.skipBackup).finally(() => {
      if (this.job === p) this.job = null;
    });
    this.job = p;
    return state;
  }

  private async runJob(u: Updater, to: string, skipBackup: boolean): Promise<void> {
    try {
      if (!skipBackup) {
        const last = await this.lifecycle()?.backups.run('manual');
        if (!last?.ok)
          throw new PlainError(
            'The backup before the update failed, so nothing was changed.',
            last?.error,
          );
        await this.save({
          ...(last.id ? { backupId: last.id } : {}),
          ...(last.size ? { backupSize: last.size } : {}),
        });
      }
      await this.save({ phase: 'downloading', message: `Downloading ${to}` });
      let verifying = false;
      const staged = await u.stage((p) => {
        const s = this.live;
        if (!s) return;
        s.progress = p;
        if (!verifying && p.total !== undefined && p.done >= p.total) {
          verifying = true;
          s.phase = 'verifying';
          s.message = 'Checking the download';
        }
      });
      await this.save({ phase: 'installing', message: `Installing ${to}`, progress: undefined });
      try {
        await u.swap(staged);
      } catch (err) {
        await u.discard?.(staged).catch(() => {});
        throw err;
      }
      await this.save({
        phase: 'restarting',
        message: `Restarting into ${to} (about 5 seconds offline)`,
      });
      this.log('info', 'update installed; restarting', { to });
      await u.restart('update');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.log('warn', 'update failed', { to, err: message });
      await this.save({
        phase: 'failed',
        message: /nothing was changed|not installed/i.test(message)
          ? message
          : `The update did not finish: ${message}`,
        technical: techOf(err),
        progress: undefined,
      });
    }
  }

  // ── after restart ──

  /** Called when the module starts: continue an update that restarted us. */
  async onBoot(): Promise<void> {
    const s = await this.state();
    if (s.phase !== 'restarting' && s.phase !== 'checking') return;
    const running = this.version();
    if (s.to && running === s.to) {
      await this.save({
        phase: 'checking',
        message: `Checking that ${s.to} works`,
        checkingSince: this.now(),
      });
      this.kernel.ports.scheduler.every(VERIFY_JOB, this.checkEverySeconds, () =>
        this.verifyTick().then(() => {}),
      );
      return;
    }
    if (s.from && running === s.from) {
      await this.save({
        phase: 'rolled-back',
        autoRolledBack: true,
        message: `Version ${s.to} did not start, so Beamhop went back to ${s.from}.`,
        technical: `booted ${running}; expected ${s.to}`,
      });
      return;
    }
    await this.save({
      phase: 'failed',
      message: `Expected version ${s.to} after the restart, but ${running} is running.`,
    });
  }

  /** One health self-test step; returns the phase after it. */
  async verifyTick(): Promise<UpdatePhase> {
    const s = await this.state();
    if (s.phase !== 'checking') {
      this.kernel.ports.scheduler.cancel(VERIFY_JOB);
      return s.phase;
    }
    const since = s.checkingSince ?? this.now();
    const age = this.now() - since;
    if (age < this.graceSeconds) return s.phase;
    const baseline = new Set(s.baselineCritical ?? []);
    const failing = (await this.criticalIds()).filter((id) => !baseline.has(id));
    if (!failing.length) {
      this.kernel.ports.scheduler.cancel(VERIFY_JOB);
      await this.updater()
        ?.confirm()
        .catch(() => {});
      await this.save({
        phase: 'done',
        message: `Updated to ${s.to}. Everything looks healthy.`,
        technical: undefined,
      });
      this.log('info', 'update healthy', { to: s.to });
      return 'done';
    }
    if (age < this.windowSeconds) return s.phase;
    this.kernel.ports.scheduler.cancel(VERIFY_JOB);
    const u = this.updater();
    this.log('error', 'update unhealthy; rolling back', { to: s.to, failing });
    if (!u) {
      await this.save({ phase: 'failed', message: `Version ${s.to} is not healthy.` });
      return 'failed';
    }
    try {
      const back = await u.rollback();
      await this.save({
        phase: 'rolled-back',
        autoRolledBack: true,
        message: `Version ${s.to} was not healthy, so Beamhop went back to ${back.version}.`,
        technical: `new critical health checks: ${failing.join(', ')}`,
      });
      await u.restart('rollback');
    } catch (err) {
      await this.save({
        phase: 'failed',
        message: `Version ${s.to} is not healthy and going back failed: ${(err as Error).message}`,
        technical: techOf(err),
      });
      return 'failed';
    }
    return 'rolled-back';
  }

  // ── rollback ──

  async rollbackPreview(input: { restoreBackup?: boolean }): Promise<DiffLine[]> {
    const s = await this.status();
    const u = this.updater();
    if (!u || !s.previousVersion)
      return [{ kind: 'warning', text: 'There is no previous version to go back to' }];
    const lines: DiffLine[] = [
      {
        kind: 'change',
        text: `Go back to version ${s.previousVersion} (about 5 seconds offline)`,
        technical: `swap <bin>.previous → <bin>; ${s.current} kept as <bin>.rolled-back`,
      },
    ];
    if (input.restoreBackup) {
      if (!s.backupId)
        lines.push({ kind: 'warning', text: 'There is no backup from before the update' });
      else {
        const lc = this.lifecycle();
        const at = s.startedAt ? new Date(s.startedAt * 1000).toUTCString() : 'the update';
        lines.push({
          kind: 'remove',
          text: `Restore the data from before the update: posts, uploads and changes since ${at} are lost`,
          technical: `backups.restore ${s.backupId}`,
        });
        if (lc) lines.push(...(await lc.backups.restorePreview(s.backupId).catch(() => [])));
      }
    } else {
      lines.push({ kind: 'info', text: 'Your data stays as it is now' });
    }
    return lines;
  }

  async rollback(input: { restoreBackup?: boolean }): Promise<{
    version: string;
    restored: boolean;
  }> {
    const cur = await this.state();
    if (this.job || (BUSY_PHASES.includes(cur.phase) && cur.phase !== 'checking'))
      throw new PlainError('Wait until the update has finished.', `phase ${cur.phase}`);
    const u = this.updater();
    if (!u) throw new PlainError((await this.install()).howTo ?? 'This server cannot roll back.');
    const prev = await u.previous();
    if (!prev) throw new PlainError('There is no previous version to go back to.');
    let restored = false;
    if (input.restoreBackup) {
      if (!cur.backupId) throw new PlainError('There is no backup from before the update.');
      const lc = this.lifecycle();
      if (!lc) throw new PlainError('Backups are not available here.');
      const r = await lc.backups.restore(cur.backupId);
      if (!r.ok)
        throw new PlainError(
          'Restoring the backup did not work, so the version was not changed.',
          r.problems.join('; '),
        );
      restored = true;
    }
    this.kernel.ports.scheduler.cancel(VERIFY_JOB);
    const back = await u.rollback();
    await this.save({
      phase: 'rolled-back',
      autoRolledBack: undefined,
      from: cur.to ?? this.version(),
      to: back.version,
      message: `Went back to ${back.version}${restored ? ' and restored the data from before the update' : ''}.`,
      technical: undefined,
    });
    this.log('info', 'rolled back', { to: back.version, restored });
    void u
      .restart('rollback')
      .catch((err) => this.log('error', 'restart after rollback failed', { err: String(err) }));
    return { version: back.version, restored };
  }

  /** Wait for a running update job (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.job) await this.job;
  }

  stop(): void {
    this.kernel.ports.scheduler.cancel(VERIFY_JOB);
  }
}
