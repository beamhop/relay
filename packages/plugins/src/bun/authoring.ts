// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Source-code plugins on Bun (used by the AI assistant's `ai.generate-plugin`):
 * tests run in a separate `bun test` process with an empty environment; the
 * plugin itself is stored under `<plugins dir>/local/<id>/plugin.ts` and later
 * runs in the Worker sandbox like any untrusted plugin.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuthoringBackend } from '../host/types.ts';

const SDK_PATH = new URL('../sdk/index.ts', import.meta.url).pathname;
const TESTBED_PATH = new URL('../testing/index.ts', import.meta.url).pathname;

/** Point SDK/testbed imports at this installation (no node_modules needed in the data dir). */
export function rewriteImports(code: string): string {
  return code
    .replace(/(['"])@beamhop\/plugins\/sdk\1/g, JSON.stringify(SDK_PATH))
    .replace(/(['"])@beamhop\/plugins\/(?:testbed|testing)\1/g, JSON.stringify(TESTBED_PATH));
}

export type RunCommand = (
  cmd: string[],
  opts: { cwd: string; env: Record<string, string>; timeoutMs: number },
) => Promise<{ code: number; output: string }>;

export const bunRun: RunCommand = async (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs);
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, output: `${out}${err}` };
};

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export function createBunAuthoring(opts: {
  dir: () => string;
  run?: RunCommand;
  timeoutMs?: number;
}): AuthoringBackend {
  const run = opts.run ?? bunRun;
  const localDir = (id: string) => {
    if (!SAFE_ID.test(id)) throw new Error('That plugin id is not valid');
    return join(opts.dir(), 'local', id);
  };
  return {
    async test(p) {
      if (!SAFE_ID.test(p.id)) throw new Error('That plugin id is not valid');
      const dir = join(opts.dir(), '.tests', `${p.id}-${crypto.randomUUID().slice(0, 8)}`);
      await mkdir(dir, { recursive: true });
      try {
        await writeFile(join(dir, 'plugin.ts'), rewriteImports(p.code));
        await writeFile(join(dir, 'plugin.test.ts'), rewriteImports(p.tests ?? ''));
        const r = await run([process.execPath, 'test'], {
          cwd: dir,
          env: { BUN_BE_BUN: '1', NO_COLOR: '1', PATH: '/usr/bin:/bin' },
          timeoutMs: opts.timeoutMs ?? 60_000,
        });
        const passed = Number(/(\d+)\s+pass/.exec(r.output)?.[1] ?? 0);
        const failed = Number(/(\d+)\s+fail/.exec(r.output)?.[1] ?? 0);
        const output = r.output.split(dir).join('.').slice(-8000);
        return { ok: r.code === 0 && failed === 0 && passed > 0, passed, failed, output };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    async writeLocal(id, code) {
      const dir = localDir(id);
      await mkdir(dir, { recursive: true });
      const file = join(dir, 'plugin.ts');
      await writeFile(file, rewriteImports(code));
      return file;
    },
    async removeLocal(id) {
      await rm(localDir(id), { recursive: true, force: true });
    },
  };
}
