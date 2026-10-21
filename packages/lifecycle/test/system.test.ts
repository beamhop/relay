// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, test } from 'bun:test';
import {
  type ActionContext,
  type BeamhopConfig,
  type HealthCheck,
  type Kernel,
  createKernel,
  defineAction,
  defineModule,
  parseConfig,
} from '@beamhop/core';
import { MemoryBlobStore, memoryPorts } from '@beamhop/testkit';
import { z } from 'zod';
import {
  type AdvisorFacts,
  DOCTOR_SERVICE,
  type DoctorFinding,
  type DoctorReport,
  HOST_SERVICE,
  type HostInfo,
  type InstallInfo,
  type ReleaseCheck,
  type StagedRelease,
  UPDATER_SERVICE,
  type UpdateCheckOutput,
  type UpdateProgress,
  type UpdateStatus,
  type Updater,
  VERIFY_JOB,
  advise,
  createLifecycleModule,
  createSystemModule,
  daysLeft,
  recommendSize,
} from '../src/index.ts';
import { OWNER } from './helpers.ts';

type Ports = ReturnType<typeof memoryPorts>;

/** In-memory "binary": versions instead of files. */
class FakeUpdater implements Updater {
  installed = '0.1.0';
  prev: string | null = null;
  latest = '0.2.0';
  signature: ReleaseCheck['signature'] = 'verifiable';
  allowUnsigned = false;
  info: InstallInfo = { kind: 'binary', canSelfUpdate: true, restart: 're-exec' };
  failStage?: string;
  calls: string[] = [];
  progress: UpdateProgress[] = [];

  async install() {
    return this.info;
  }
  async check(): Promise<ReleaseCheck> {
    return {
      current: this.installed,
      latest: this.latest,
      updateAvailable: this.latest !== this.installed,
      notes: 'Faster sign-in.\nFewer spam reports.\nSmaller downloads.\nMore.',
      downloadBytes: 40 * 1024 * 1024,
      signature: this.signature,
      allowUnsigned: this.allowUnsigned,
      source: 'https://dl.example/latest.json',
    };
  }
  async stage(onProgress?: (p: UpdateProgress) => void): Promise<StagedRelease> {
    this.calls.push('stage');
    if (this.failStage) throw new Error(this.failStage);
    for (const p of [
      { done: 50, total: 100 },
      { done: 100, total: 100 },
    ]) {
      onProgress?.(p);
      this.progress.push(p);
    }
    return { version: this.latest, path: '/tmp/x', sha256: 'aa', signed: true, bytes: 100 };
  }
  async swap() {
    this.calls.push('swap');
    this.prev = this.installed;
    this.installed = this.latest;
    return { previousVersion: this.prev };
  }
  async confirm() {
    this.calls.push('confirm');
  }
  async previous() {
    return this.prev ? { version: this.prev } : null;
  }
  async rollback() {
    if (!this.prev) throw new Error('There is no previous version to go back to.');
    this.calls.push('rollback');
    const v = this.prev;
    this.installed = v;
    this.prev = null;
    return { version: v };
  }
  async restart(reason: string) {
    this.calls.push(`restart:${reason}`);
  }
}

interface BootOptions {
  ports?: Ports;
  version: string;
  updater?: Updater;
  runtime?: 'test' | 'cloudflare';
  health?: HealthCheck[];
  findings?: DoctorFinding[];
  host?: HostInfo;
  config?: Record<string, unknown>;
  configApply?: boolean;
  /** Backup storage (shared across "restarts"). */
  target?: MemoryBlobStore;
  /** Pretend the media module with storage tiers is on (its status action exists). */
  mediaTiers?: boolean;
}

const kernels: Kernel[] = [];
afterEach(() => {
  kernels.length = 0;
});

async function boot(o: BootOptions) {
  const ports = o.ports ?? memoryPorts();
  const target = o.target ?? new MemoryBlobStore();
  if (!o.ports)
    for (const s of [ports.events, ports.docs, ports.blobs, ports.blobIndex]) await s.init();
  const extras = defineModule({
    id: 'test-runtime',
    register(k) {
      if (o.updater) k.provide(UPDATER_SERVICE, o.updater);
      if (o.findings) {
        const findings = o.findings;
        k.provide(DOCTOR_SERVICE, { run: async () => findings });
      }
      if (o.host) k.provide(HOST_SERVICE, o.host);
      if (o.configApply)
        k.provide('admin.config', {
          apply: async (next: BeamhopConfig) => {
            await k.applyConfig(next);
          },
        });
      for (const h of o.health ?? []) k.health.push(h);
      if (o.mediaTiers)
        k.actions.register(
          defineAction({
            id: 'media.storage-tiers',
            title: 'Storage tiers',
            description: 'test stand-in',
            technical: 'test',
            scope: 'node',
            permission: 'relay.read',
            readOnly: true,
            input: z.object({}),
            run: async () => ({ output: {}, summary: '' }),
          }),
        );
    },
  });
  const kernel = await createKernel({
    runtime: o.runtime ?? 'test',
    ports,
    config: parseConfig({ relays: [{ id: 'main', hosts: ['relay.example.com'] }], ...o.config }),
    modules: [
      createLifecycleModule({ backupTarget: target }),
      createSystemModule({ version: () => o.version, graceSeconds: 10, windowSeconds: 60 }),
      extras,
    ],
  });
  kernels.push(kernel);
  const ctx: ActionContext = { principal: OWNER, relayId: null, ports };
  const run = async <O>(id: string, input: unknown = {}) => {
    const def = kernel.actions.get(id);
    if (!def) throw new Error(`no action ${id}`);
    return (await def.run(def.input.parse(input), ctx)) as {
      output: O;
      summary: string;
      undo?: unknown;
    };
  };
  const preview = async (id: string, input: unknown = {}) => {
    const def = kernel.actions.get(id);
    if (!def?.preview) throw new Error(`no preview for ${id}`);
    return def.preview(def.input.parse(input), ctx);
  };
  const idle = () =>
    (kernel.use('system.updates') as { idle(): Promise<void> } | undefined)?.idle() ??
    Promise.resolve();
  return { kernel, ports, run, preview, idle, target };
}

const critical = (id: string, isCritical: () => boolean): HealthCheck => ({
  id,
  subsystem: 'relay',
  weight: 1,
  run: async () =>
    isCritical()
      ? { score: 0, status: 'critical', message: 'The relay does not answer' }
      : { score: 100, status: 'ok', message: 'Fine' },
});

describe('system.update', () => {
  test('happy path: backup → download → verify → swap → restart → healthy boot', async () => {
    const u = new FakeUpdater();
    const a = await boot({ version: '0.1.0', updater: u });

    const chk = (await a.run<UpdateCheckOutput>('system.update-check')).output;
    expect(chk).toMatchObject({
      current: '0.1.0',
      latest: '0.2.0',
      updateAvailable: true,
      canVerify: true,
      canSelfUpdate: true,
    });
    expect(chk.notesSummary).toBe('Faster sign-in.\nFewer spam reports.\nSmaller downloads.\n…');
    expect(chk.blocked).toBeUndefined();

    const steps = (await a.preview('system.update', { version: '0.2.0' })).map((l) => l.text);
    expect(steps[0]).toContain('Back up your data');
    expect(steps[1]).toBe('Download version 0.2.0 (40 MB)');
    expect(steps.join(' | ')).toContain('Restart into 0.2.0 (about 5 seconds offline)');

    const r = await a.run<{ phase: string }>('system.update', { version: '0.2.0' });
    expect(r.output.phase).toBe('backing-up');
    expect(r.undo).toBeTruthy();
    await a.idle();
    expect(u.calls).toEqual(['stage', 'swap', 'restart:update']);
    let st = (await a.run<UpdateStatus>('system.update-status')).output;
    expect(st).toMatchObject({ phase: 'restarting', from: '0.1.0', to: '0.2.0', busy: true });
    expect(st.backupId).toBeTruthy();
    expect(st.previousVersion).toBe('0.1.0');
    await expect(a.run('system.update', {})).rejects.toThrow('already running');

    // The new process boots with the same data.
    const b = await boot({ ports: a.ports, version: '0.2.0', updater: u });
    st = (await b.run<UpdateStatus>('system.update-status')).output;
    expect(st.phase).toBe('checking');
    expect(b.ports.scheduler.jobs.has(VERIFY_JOB)).toBe(true);
    await b.ports.scheduler.tick(VERIFY_JOB); // still in the grace period
    expect((await b.run<UpdateStatus>('system.update-status')).output.phase).toBe('checking');
    b.ports.clock.advance(11);
    await b.ports.scheduler.tick(VERIFY_JOB);
    st = (await b.run<UpdateStatus>('system.update-status')).output;
    expect(st.phase).toBe('done');
    expect(st.message).toContain('Updated to 0.2.0');
    expect(u.calls).toContain('confirm');
    expect(b.ports.scheduler.jobs.has(VERIFY_JOB)).toBe(false);
  });

  test('a release that cannot be checked (no release key) is refused with a plain message', async () => {
    const u = new FakeUpdater();
    u.signature = 'no-key';
    const a = await boot({ version: '0.1.0', updater: u });
    const chk = (await a.run<UpdateCheckOutput>('system.update-check')).output;
    expect(chk.canVerify).toBe(false);
    expect(chk.blocked).toContain('cannot check that this download is genuine');
    const pv = await a.preview('system.update', {});
    expect(pv[0]).toMatchObject({ kind: 'warning' });
    await expect(a.run('system.update', {})).rejects.toThrow('cannot check that this download');
    expect(u.calls).toEqual([]);

    // Developer override.
    u.allowUnsigned = true;
    await a.run('system.update', {});
    await a.idle();
    expect(u.calls).toEqual(['stage', 'swap', 'restart:update']);
  });

  test('a signature failure during download leaves everything as it was', async () => {
    const u = new FakeUpdater();
    u.failStage = 'The download is not signed by Beamhop; nothing was changed.';
    const a = await boot({ version: '0.1.0', updater: u });
    await a.run('system.update', {});
    await a.idle();
    const st = (await a.run<UpdateStatus>('system.update-status')).output;
    expect(st.phase).toBe('failed');
    expect(st.message).toBe('The download is not signed by Beamhop; nothing was changed.');
    expect(u.calls).toEqual(['stage']);
    expect(u.installed).toBe('0.1.0');
  });

  test('unhealthy after the restart → automatic rollback; the backup is offered', async () => {
    const u = new FakeUpdater();
    let broken = false;
    const preexisting = critical('test.always-red', () => true);
    const relayCheck = critical('test.relay', () => broken);
    const a = await boot({ version: '0.1.0', updater: u, health: [preexisting, relayCheck] });
    await a.run('system.update', {});
    await a.idle();
    const backupId = (await a.run<UpdateStatus>('system.update-status')).output.backupId;

    broken = true; // the new version breaks the relay
    const b = await boot({
      ports: a.ports,
      version: '0.2.0',
      updater: u,
      health: [preexisting, relayCheck],
    });
    b.ports.clock.advance(20);
    await b.ports.scheduler.tick(VERIFY_JOB); // failing, but still inside the window
    expect((await b.run<UpdateStatus>('system.update-status')).output.phase).toBe('checking');
    b.ports.clock.advance(60);
    await b.ports.scheduler.tick(VERIFY_JOB);
    const st = (await b.run<UpdateStatus>('system.update-status')).output;
    expect(st.phase).toBe('rolled-back');
    expect(st.autoRolledBack).toBe(true);
    expect(st.message).toBe('Version 0.2.0 was not healthy, so Beamhop went back to 0.1.0.');
    expect(st.technical).toContain('test.relay');
    expect(st.technical).not.toContain('test.always-red');
    expect(st.backupId).toBe(backupId);
    expect(u.installed).toBe('0.1.0');
    expect(u.calls.slice(-2)).toEqual(['rollback', 'restart:rollback']);

    // Old version boots again: the state stays "rolled back".
    const c = await boot({ ports: a.ports, version: '0.1.0', updater: u });
    expect((await c.run<UpdateStatus>('system.update-status')).output.phase).toBe('rolled-back');
  });

  test('new version never started → shown as rolled back on the old one', async () => {
    const u = new FakeUpdater();
    const a = await boot({ version: '0.1.0', updater: u });
    await a.run('system.update', {});
    await a.idle();
    const b = await boot({ ports: a.ports, version: '0.1.0', updater: u });
    const st = (await b.run<UpdateStatus>('system.update-status')).output;
    expect(st.phase).toBe('rolled-back');
    expect(st.message).toBe('Version 0.2.0 did not start, so Beamhop went back to 0.1.0.');
  });

  test('system.rollback: swaps back, optionally restores the pre-update backup', async () => {
    const u = new FakeUpdater();
    const a = await boot({ version: '0.1.0', updater: u });
    await a.run('system.update', {});
    await a.idle();
    const b = await boot({ ports: a.ports, version: '0.2.0', updater: u, target: a.target });
    b.ports.clock.advance(11);
    await b.ports.scheduler.tick(VERIFY_JOB);

    const keep = (await b.preview('system.rollback', {})).map((l) => l.text);
    expect(keep[0]).toBe('Go back to version 0.1.0 (about 5 seconds offline)');
    expect(keep).toContain('Your data stays as it is now');
    const lose = await b.preview('system.rollback', { restoreBackup: true });
    expect(lose.find((l) => l.kind === 'remove')?.text).toContain(
      'Restore the data from before the update',
    );

    const r = await b.run<{ version: string; restored: boolean }>('system.rollback', {
      restoreBackup: true,
    });
    expect(r.output).toEqual({ version: '0.1.0', restored: true });
    await Bun.sleep(0);
    expect(u.calls.slice(-2)).toEqual(['rollback', 'restart:rollback']);
    const st = (await b.run<UpdateStatus>('system.update-status')).output;
    expect(st.phase).toBe('rolled-back');
    expect(st.previousVersion).toBeNull();
    await expect(b.run('system.rollback', {})).rejects.toThrow('no previous version');
  });

  test('Docker / Cloudflare / source installs explain how to update instead', async () => {
    const u = new FakeUpdater();
    u.info = { kind: 'docker', canSelfUpdate: false, howTo: 'Pull the new image.' };
    const a = await boot({ version: '0.1.0', updater: u });
    const chk = (await a.run<UpdateCheckOutput>('system.update-check')).output;
    expect(chk).toMatchObject({ canSelfUpdate: false, blocked: 'Pull the new image.' });
    await expect(a.run('system.update', {})).rejects.toThrow('Pull the new image.');

    const cf = await boot({ version: '0.1.0', runtime: 'cloudflare' });
    const c = (await cf.run<UpdateCheckOutput>('system.update-check')).output;
    expect(c.install.kind).toBe('cloudflare');
    expect(c.blocked).toBe(
      'Updates on Cloudflare happen through `npm create beamhop -- --cf` again or your deploy pipeline.',
    );
    await expect(cf.run('system.update', {})).rejects.toThrow('npm create beamhop -- --cf');
    await expect(cf.run('system.rollback', {})).rejects.toThrow('npm create beamhop');

    const src = await boot({ version: '0.1.0' });
    const s = (await src.run<UpdateCheckOutput>('system.update-check')).output;
    expect(s.install.kind).toBe('source');
    expect(s.blocked).toContain('git pull');
  });
});

describe('system.doctor', () => {
  test('maps doctor findings and health checks to plain results with fixes and lens', async () => {
    const a = await boot({
      version: '0.1.0',
      findings: [
        { id: 'port.listen', status: 'ok', title: 'Port', message: 'Port 3334 answers.' },
        {
          id: 'disk.free',
          status: 'warn',
          title: 'Disk space',
          message: 'Only 3 GB free.',
          technical: 'statfs free=3221225472',
        },
        {
          id: 'data.permissions',
          status: 'fail',
          title: 'Data folder',
          message: 'Other users can read your data.',
          fixHint: 'chmod 700 data',
        },
        { id: 'clock.skew', status: 'skip', title: 'Clock', message: 'Not checked.' },
      ],
      health: [critical('test.relay', () => true)],
    });
    const r = (await a.run<DoctorReport>('system.doctor')).output;
    expect(r.fullChecks).toBe(true);
    const byId = Object.fromEntries(r.results.map((x) => [x.id, x]));
    expect(byId['port.listen']?.tone).toBe('green');
    expect(byId['disk.free']).toMatchObject({
      tone: 'amber',
      fix: { actionId: 'lifecycle.prune-storage' },
    });
    expect(byId['disk.free']?.lens).toEqual(['check disk.free', 'statfs free=3221225472']);
    expect(byId['data.permissions']).toMatchObject({ tone: 'red' });
    expect(byId['data.permissions']?.fix).toBeUndefined();
    expect(byId['data.permissions']?.advice).toContain('beamhop doctor --fix');
    expect(byId['clock.skew']?.tone).toBe('grey');
    expect(byId['test.relay']).toMatchObject({ source: 'health', tone: 'red' });
    // Backups are off by default → lifecycle health warns, fix = set up backups.
    expect(byId['lifecycle.backups']).toMatchObject({
      tone: 'amber',
      fix: { actionId: 'backups.setup' },
    });
    // Worst first.
    expect(r.results[0]?.tone).toBe('red');
    expect(r.counts.red).toBe(2);
  });

  test('without a runtime doctor (Cloudflare) only the health checks run', async () => {
    const a = await boot({ version: '0.1.0', runtime: 'cloudflare' });
    const r = (await a.run<DoctorReport>('system.doctor')).output;
    expect(r.fullChecks).toBe(false);
    expect(r.results.every((x) => x.source === 'health')).toBe(true);
  });
});

describe('system.advisor', () => {
  const base: AdvisorFacts = {
    runtime: 'bun',
    connections: 40,
    eventsPerSecond: 2,
    dbBytes: 200 * 1024 * 1024,
    blobBytes: 1024 ** 3,
    blobDriver: 'fs',
    storageDriver: 'sqlite',
    backupsEnabled: true,
  };

  test('machine size from traffic and storage', () => {
    expect(recommendSize(base)).toEqual({ vcpus: 1, memoryGb: 1, diskGb: 10 });
    expect(recommendSize({ ...base, connections: 10_000, eventsPerSecond: 5000 })).toMatchObject({
      vcpus: 7,
      memoryGb: 8,
    });
    const r = advise(base);
    expect(r.advice[0]?.title).toBe('Your relay would run comfortably on 1 vCPU / 1 GB');
    expect(r.advice.map((a) => a.id)).toEqual(['machine-size']);
  });

  test('rules: big machine, one core with threads, busy without threads, disk, media, backups', () => {
    const host = { cpus: 16, memoryBytes: 64 * 1024 ** 3, rssBytes: 1e8, verifyWorkers: 15 };
    expect(advise({ ...base, host }).advice.map((a) => a.id)).toContain('machine-too-big');

    const one = advise({
      ...base,
      host: { ...host, cpus: 1, memoryBytes: 2 * 1024 ** 3, verifyWorkers: 1 },
    });
    const off = one.advice.find((a) => a.id === 'verify-workers-off');
    expect(off?.apply).toEqual({
      label: 'Use the main thread',
      actionId: 'system.apply-advice',
      input: { id: 'verify-workers-off' },
    });

    const busy = advise({
      ...base,
      eventsPerSecond: 800,
      host: { ...host, cpus: 4, memoryBytes: 8 * 1024 ** 3, verifyWorkers: 0 },
    });
    expect(busy.advice.find((a) => a.id === 'verify-workers-on')?.title).toBe(
      'Check signatures in parallel',
    );

    const small = advise({
      ...base,
      connections: 12_000,
      host: { ...host, cpus: 1, memoryBytes: 1024 ** 3, verifyWorkers: 0 },
    });
    expect(small.advice.find((a) => a.id === 'machine-too-small')?.severity).toBe('warning');

    const disk = advise({
      ...base,
      disk: { freeBytes: 10 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
      diskDaysLeft: 23.2,
    });
    const d = disk.advice.find((a) => a.id === 'disk-forecast');
    expect(d?.title).toBe('The disk will be full in about 23 days');
    expect(d?.apply?.actionId).toBe('lifecycle.prune-storage');

    const media = advise({ ...base, blobBytes: 40 * 1024 ** 3 });
    expect(media.advice.find((a) => a.id === 'media-to-bucket')?.title).toBe(
      'Move 40.0 GB of media to cloud storage',
    );

    const nobackup = advise({ ...base, backupsEnabled: false });
    expect(nobackup.advice.find((a) => a.id === 'backups-off')?.apply?.actionId).toBe(
      'backups.setup',
    );
  });

  test('disk trend', () => {
    const day = 86_400;
    expect(
      daysLeft([
        { t: 0, v: 100 },
        { t: 10 * day, v: 50 },
      ]),
    ).toBe(10);
    expect(
      daysLeft([
        { t: 0, v: 100 },
        { t: 3600, v: 50 },
      ]),
    ).toBeUndefined();
    expect(
      daysLeft([
        { t: 0, v: 50 },
        { t: 2 * day, v: 80 },
      ]),
    ).toBeUndefined();
  });

  test('system.advisor + system.apply-advice: preview → apply → undo', async () => {
    const a = await boot({
      version: '0.1.0',
      host: { cpus: 1, memoryBytes: 2 * 1024 ** 3, rssBytes: () => 1e8, verifyWorkers: 1 },
      configApply: true,
    });
    const r = (await a.run<{ advice: Array<{ id: string }> }>('system.advisor')).output;
    expect(r.advice.map((x) => x.id)).toContain('verify-workers-off');
    const pv = await a.preview('system.apply-advice', { id: 'verify-workers-off' });
    expect(pv[0]?.technical).toBe('node.verifyWorkers: auto → 0');
    const res = await a.run('system.apply-advice', { id: 'verify-workers-off' });
    expect(a.kernel.config().node.verifyWorkers).toBe(0);
    const def = a.kernel.actions.get('system.apply-advice');
    await def?.undo?.((res.undo as { payload: unknown }).payload, {
      principal: OWNER,
      relayId: null,
      ports: a.ports,
    });
    expect(a.kernel.config().node.verifyWorkers).toBeUndefined();
    expect(await a.preview('system.apply-advice', { id: 'verify-workers-on' })).toEqual([
      { kind: 'info', text: 'This suggestion no longer applies' },
    ]);
  });

  test('cold storage: suggested for unopened media instead of moving everything', () => {
    const GB = 1024 ** 3;
    const cold = { enabled: false, days: 90, staleBytes: 12.4 * GB, staleFiles: 300 };
    const r = advise({ ...base, blobBytes: 40 * GB, coldStorage: cold });
    const a = r.advice.find((x) => x.id === 'cold-storage-on');
    expect(a?.title).toBe("Turn on cold storage — 12 GB of files haven't been opened in 90 days");
    expect(a?.severity).toBe('suggestion');
    expect(a?.apply).toEqual({
      label: 'Turn on cold storage',
      actionId: 'system.cold-storage',
      input: { afterDays: 90 },
    });
    expect(a?.lens.join(' ')).toContain('blossom.tiers');
    expect(r.advice.map((x) => x.id)).not.toContain('media-to-bucket');
    // Too little unopened media, already on, or on Workers: no suggestion.
    const ids = (f: Partial<AdvisorFacts>) => advise({ ...base, ...f }).advice.map((x) => x.id);
    expect(ids({ coldStorage: { ...cold, staleBytes: GB / 2 } })).not.toContain('cold-storage-on');
    expect(ids({ coldStorage: { ...cold, enabled: true } })).not.toContain('cold-storage-on');
    expect(ids({ runtime: 'cloudflare', coldStorage: cold })).not.toContain('cold-storage-on');
    // Without the media module the old advice stays.
    expect(ids({ blobBytes: 40 * GB })).toContain('media-to-bucket');
  });

  test('system.advisor reads unopened media duck-typed; system.cold-storage preview → apply → undo', async () => {
    const MB = 1024 * 1024;
    const a = await boot({ version: '0.1.0', configApply: true, mediaTiers: true });
    const now = a.ports.clock.now();
    const put = async (sha: string, size: number) =>
      a.ports.blobs.put({ sha256: sha, size, type: 'image/png' }, new Uint8Array(1));
    const old = 'a'.repeat(64);
    const fresh = 'b'.repeat(64);
    const uploadedLongAgo = 'c'.repeat(64);
    const alreadyCold = 'd'.repeat(64);
    for (const sha of [old, fresh, uploadedLongAgo, alreadyCold]) await put(sha, 600 * MB);
    await a.ports.docs.put('blossom.tiers', old, { lastAccess: now - 100 * 86_400 });
    await a.ports.docs.put('blossom.tiers', fresh, { lastAccess: now - 86_400 });
    await a.ports.docs.put('blossom.tiers', alreadyCold, {
      lastAccess: now - 200 * 86_400,
      tier: 'cold',
    });
    await a.ports.blobIndex.addOwner({
      relayId: 'main',
      sha256: uploadedLongAgo,
      pubkey: 'e'.repeat(64),
      size: 600 * MB,
      type: 'image/png',
      uploadedAt: now - 120 * 86_400,
    });
    const r = (
      await a.run<{ facts: AdvisorFacts; advice: Array<{ id: string; title: string }> }>(
        'system.advisor',
      )
    ).output;
    expect(r.facts.coldStorage).toMatchObject({
      enabled: false,
      days: 90,
      staleFiles: 2,
      staleBytes: 1200 * MB,
    });
    expect(r.advice.find((x) => x.id === 'cold-storage-on')?.title).toBe(
      "Turn on cold storage — 1 GB of files haven't been opened in 90 days",
    );

    // The store still has to be chosen: preview asks for it (the app shows the form).
    await expect(a.preview('system.cold-storage', { afterDays: 90 })).rejects.toThrow(
      'Choose where older files go',
    );
    const store = { driver: 'r2', bucket: 'cold-media', endpoint: 'https://r2.example' };
    const pv = await a.preview('system.cold-storage', { afterDays: 90, store });
    expect(pv[0]?.text).toBe(
      'Move media files nobody opened for 90 days to R2 bucket cold-media. They keep working.',
    );
    expect(pv[0]?.technical).toContain('modules.blossom.tiers.cold');
    const res = await a.run('system.cold-storage', { afterDays: 90, store });
    const blossom = a.kernel.config().modules.blossom as { tiers: { cold: unknown } };
    expect(blossom.tiers.cold).toMatchObject({ afterDays: 90, store: { bucket: 'cold-media' } });
    const after = (await a.run<{ advice: Array<{ id: string }> }>('system.advisor')).output;
    expect(after.advice.map((x) => x.id)).not.toContain('cold-storage-on');
    expect(await a.preview('system.cold-storage', { store })).toEqual([
      { kind: 'info', text: 'Cold storage is already on' },
    ]);
    const def = a.kernel.actions.get('system.cold-storage');
    await def?.undo?.((res.undo as { payload: unknown }).payload, {
      principal: OWNER,
      relayId: null,
      ports: a.ports,
    });
    expect(a.kernel.config().modules.blossom).toBeUndefined();
  });

  test('no cold-storage facts without the media module', async () => {
    const a = await boot({ version: '0.1.0' });
    const r = (await a.run<{ facts: AdvisorFacts }>('system.advisor')).output;
    expect(r.facts.coldStorage).toBeUndefined();
    expect(await a.preview('system.cold-storage', {})).toEqual([
      { kind: 'info', text: 'Media storage is not turned on' },
    ]);
  });
});
