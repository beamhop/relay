// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Cloudflare Worker bundle check (GAPS D3): bundle the default and the `--enterprise`
 * Worker with `wrangler deploy --dry-run` (no account needed) from deploy/cloudflare,
 * and fail when the default bundle's gzip size exceeds its budget. The enterprise
 * bundle is reported and has its own, looser budget.
 *
 *   bun scripts/ci/cf-bundle.ts
 *   CF_BUDGET_KB=760 bun scripts/ci/cf-bundle.ts
 *
 * Budgets are ~10% above the sizes measured when this check was added
 * (default 672 KiB, enterprise 804 KiB gzip with wrangler 4.151).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const ROOT = join(import.meta.dir, '..', '..');
const CF_DIR = join(ROOT, 'deploy/cloudflare');
const BUILD_CLI = join(ROOT, 'packages/runtime-cf/src/bundle/cli.ts');

const BUDGETS_KB = {
  default: Number(process.env.CF_BUDGET_KB ?? 740),
  enterprise: Number(process.env.CF_ENTERPRISE_BUDGET_KB ?? 885),
};

function wranglerBin(): string {
  for (const dir of ['packages/runtime-cf/node_modules/.bin', 'node_modules/.bin']) {
    const bin = join(ROOT, dir, 'wrangler');
    if (existsSync(bin)) return bin;
  }
  throw new Error('wrangler not installed (bun install at the repo root)');
}

function run(cmd: string[]): string {
  const p = Bun.spawnSync(cmd, { cwd: CF_DIR, stdout: 'pipe', stderr: 'pipe' });
  const out = `${p.stdout.toString()}${p.stderr.toString()}`;
  if (p.exitCode !== 0) {
    console.error(out);
    throw new Error(`${cmd.join(' ')} exited with ${p.exitCode}`);
  }
  return out;
}

/** Bundle one variant; returns raw and gzip sizes of the Worker script. */
function bundle(variant: 'default' | 'enterprise'): { raw: number; gzip: number } {
  const outdir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), `beamhop-cf-${variant}-`));
  try {
    const args = [wranglerBin(), 'deploy', '--dry-run', '--outdir', outdir];
    if (variant === 'enterprise') {
      // A separate entry with every enterprise package; wrangler's [build] step still
      // regenerates the default build/entry.ts, which this entry does not use.
      run([
        'bun',
        BUILD_CLI,
        '--config',
        'beamhop.config.json',
        '--out',
        'build/entry-enterprise.ts',
        '--enterprise',
      ]);
      args.push('build/entry-enterprise.ts');
    }
    const log = run(args);
    const upload = log.match(/Total Upload:.*$/m)?.[0];
    if (upload) console.log(`  wrangler (${variant}): ${upload}`);
    const script = readdirSync(outdir).find((f) => /\.(m?js)$/.test(f));
    if (!script) throw new Error(`no bundle in ${outdir}`);
    const buf = readFileSync(join(outdir, script));
    return { raw: buf.length, gzip: gzipSync(buf, { level: 9 }).length };
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  let failed = false;
  for (const variant of ['default', 'enterprise'] as const) {
    const { raw, gzip } = bundle(variant);
    const kib = gzip / 1024;
    const budget = BUDGETS_KB[variant];
    console.log(
      `cf bundle ${variant}: ${(raw / 1024).toFixed(1)} KiB raw, ${kib.toFixed(1)} KiB gzip (budget ${budget} KiB)`,
    );
    if (kib > budget) {
      failed = true;
      console.error(`  over budget: ${kib.toFixed(1)} KiB > ${budget} KiB`);
    }
  }
  process.exit(failed ? 1 : 0);
}
