// SPDX-License-Identifier: AGPL-3.0-or-later
/** deploy/ha/failover.sh with stub commands: threshold, promotion order, hooks, marker. */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '../../deploy/ha/failover.sh');
const HOOKS = resolve(import.meta.dir, '../../deploy/ha/hooks');
const root = mkdtempSync(join(tmpdir(), 'beamhop-failover-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(name: string, env: Record<string, string>) {
  const dir = join(root, name);
  const log = join(dir, 'steps.log');
  Bun.spawnSync(['mkdir', '-p', dir]);
  const p = Bun.spawnSync(['sh', SCRIPT], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      CHECK_INTERVAL: '0',
      STATE_DIR: join(dir, 'state'),
      DB_PATH: join(dir, 'db/beamhop.sqlite'),
      RESTORE_CMD: `echo restore >> ${log}`,
      START_CMD: `echo start >> ${log}`,
      LOCAL_HEALTH_CMD: 'true',
      ...env,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const steps = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { code: p.exitCode, out: p.stdout.toString(), steps, dir };
}

describe('failover.sh', () => {
  test('syntax', () => {
    expect(Bun.spawnSync(['sh', '-n', SCRIPT]).exitCode).toBe(0);
    for (const h of [
      'hetzner-floating-ip',
      'digitalocean-reserved-ip',
      'gcp-static-ip',
      'cloudflare-dns',
    ])
      expect(Bun.spawnSync(['sh', '-n', join(HOOKS, `${h}.sh`)]).exitCode).toBe(0);
  });

  test('a healthy primary is never taken over', () => {
    const r = run('healthy', { HEALTH_CMD: 'true', MAX_CHECKS: '5' });
    expect(r.code).toBe(3);
    expect(r.steps).toEqual([]);
  });

  test('a single blip resets the counter', () => {
    // fail, fail, ok, fail, fail → never 3 in a row
    const seq = join(root, 'seq');
    writeFileSync(seq, '');
    const health = `n=$(($(wc -l < ${seq}))); echo x >> ${seq}; case $n in 2) exit 0 ;; *) exit 1 ;; esac`;
    const r = run('blip', { HEALTH_CMD: health, MAX_CHECKS: '5' });
    expect(r.code).toBe(3);
    expect(r.out).toContain('healthy again');
    expect(r.steps).toEqual([]);
  });

  test('promotes after N failures: restore → start → hook → marker; then never again', () => {
    const hookLog = join(root, 'hook.log');
    const hook = join(root, 'hook.sh');
    writeFileSync(hook, `#!/bin/sh\necho moved >> ${hookLog}\n`);
    chmodSync(hook, 0o755);
    const r = run('down', { HEALTH_CMD: 'false', FAIL_THRESHOLD: '3', PROMOTE_HOOK: hook });
    expect(r.code).toBe(0);
    expect(r.out).toContain('check failed (3/3)');
    expect(r.steps).toEqual(['restore', 'start']);
    expect(readFileSync(hookLog, 'utf8')).toBe('moved\n');
    expect(existsSync(join(r.dir, 'state/promoted'))).toBe(true);

    const again = run('down', { HEALTH_CMD: 'false' });
    expect(again.code).toBe(0);
    expect(again.out).toContain('already promoted');
    expect(again.steps).toEqual(['restore', 'start']); // unchanged
  });

  test('a failed restore does not start anything', () => {
    const r = run('norestore', { HEALTH_CMD: 'false', FAIL_THRESHOLD: '1', RESTORE_CMD: 'false' });
    expect(r.code).toBe(1);
    expect(r.out).toContain('restore FAILED');
    expect(r.steps).toEqual([]);
    expect(existsSync(join(r.dir, 'state/promoted'))).toBe(false);
  });

  test('a failing hook is reported (exit 2) but promotion stands', () => {
    const r = run('badhook', { HEALTH_CMD: 'false', FAIL_THRESHOLD: '1', PROMOTE_HOOK: 'false' });
    expect(r.code).toBe(2);
    expect(r.out).toContain('hook failed');
    expect(r.steps).toEqual(['restore', 'start']);
  });

  test('dry run only logs', () => {
    const r = run('dry', {
      HEALTH_CMD: 'false',
      FAIL_THRESHOLD: '1',
      DRY_RUN: '1',
      MODE: 'compose',
      RESTORE_CMD: '',
      START_CMD: '',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('(dry run) docker compose');
    expect(r.out).toContain('--profile primary up -d');
  });

  test('needs PRIMARY_URL without HEALTH_CMD', () => {
    const r = run('nourl', {});
    expect(r.code).toBe(64);
  });
});
