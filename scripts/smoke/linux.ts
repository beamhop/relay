#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Smoke-test the Linux binaries in microsandbox microVMs (https://microsandbox.dev):
 * a clean Debian VM runs `beamhop-linux-<arch>` from a read-only mount, with nothing
 * else installed, and the host checks it over a published port.
 *
 *   bun run build -- --target linux-arm64          # or --all
 *   bun run smoke:linux                            # targets this host can run
 *   bun run smoke:linux -- --dist dist --target linux-arm64 --keep
 *
 * Checks: relay info (NIP-11), admin app, team app, public page, `--build-info`
 * (both apps embedded), the CLI against the server's data (`claim-code`), and the
 * image pipeline: an EXIF JPEG through `/media` comes back stripped and rotated, a
 * PNG through `/upload` gets its thumbnail and copies.
 *
 * microVMs run the host's architecture: Apple Silicon (and arm64 Linux) runs
 * linux-arm64, x86-64 Linux with KVM runs linux-x64. Other targets are skipped.
 * Needs `msb` on PATH or in ~/.microsandbox/bin.
 */
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { imageInfo } from '../../packages/media/src/image-meta.ts';
import { syntheticImage, withExif } from '../../packages/media/test/helpers.ts';
import { makeEvent, makeKey } from '../../packages/testkit/src/index.ts';

const ROOT = resolve(import.meta.dir, '../..');

export interface SmokeArgs {
  dist: string;
  targets: string[];
  keep: boolean;
  port: number;
}

/** The Linux target microVMs on this host run natively. */
export function nativeTarget(arch = process.arch): string {
  return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}

export function parseSmokeArgs(argv: string[]): SmokeArgs {
  const a: SmokeArgs = {
    dist: join(ROOT, 'packages/runtime-bun/dist'),
    targets: [nativeTarget()],
    keep: false,
    port: 38750,
  };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--dist') a.dist = resolve(argv[++i] ?? a.dist);
    else if (x === '--target') a.targets = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (x === '--keep') a.keep = true;
    else if (x === '--port') a.port = Number(argv[++i]);
    else throw new Error(`unknown option: ${x}`);
  }
  return a;
}

function msbPath(): string {
  const local = join(homedir(), '.microsandbox/bin/msb');
  const onPath = Bun.which('msb');
  if (onPath) return onPath;
  if (existsSync(local)) return local;
  throw new Error('msb not found: install microsandbox (https://microsandbox.dev)');
}

function msb(args: string[], timeoutMs = 120_000): { code: number; out: string } {
  const r = Bun.spawnSync([msbPath(), ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
  });
  return { code: r.exitCode ?? 1, out: `${r.stdout.toString()}${r.stderr.toString()}` };
}

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

async function waitFor(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return true;
    } catch {
      await Bun.sleep(500);
    }
  }
  return false;
}

/** Blossom (BUD-01/05) auth header for one upload of `sha`. */
function blossomAuth(verb: 'upload' | 'media', sha: string): string {
  const now = Math.floor(Date.now() / 1000);
  const ev = makeEvent(makeKey(), {
    kind: 24242,
    created_at: now,
    content: verb,
    tags: [
      ['t', verb],
      ['x', sha],
      ['expiration', String(now + 300)],
    ],
  });
  return `Nostr ${btoa(JSON.stringify(ev))}`;
}

const sha256 = (b: Uint8Array) => new Bun.CryptoHasher('sha256').update(b).digest('hex');

async function smokeTarget(target: string, a: SmokeArgs): Promise<Check[]> {
  const bin = `beamhop-${target}`;
  const name = `beamhop-smoke-${target}`;
  const base = `http://127.0.0.1:${a.port}`;
  const checks: Check[] = [];
  const check = (n: string, ok: boolean, detail?: string) => checks.push({ name: n, ok, detail });
  // msb refuses bind mounts through symlinks (/tmp → /private/tmp on macOS).
  const dist = realpathSync(a.dist);
  msb(['rm', '-f', name]);
  const run = msb([
    'run',
    '-d',
    '--name',
    name,
    '-m',
    '1G',
    '-c',
    '2',
    '-v',
    `${dist}:/opt/beamhop:ro`,
    '-p',
    `127.0.0.1:${a.port}:3334`,
    '-e',
    'BEAMHOP_MODULES__TEAM__ENABLED=true',
    'debian',
    '--',
    `/opt/beamhop/${bin}`,
    '--data-dir',
    '/var/lib/beamhop',
    '--listen',
    '0.0.0.0:3334',
  ]);
  check('VM starts the binary', run.code === 0, run.code ? run.out.trim() : undefined);
  if (run.code !== 0) return checks;
  try {
    check('server answers', await waitFor(`${base}/`, 60_000));

    const info = await fetch(`${base}/`, { headers: { accept: 'application/nostr+json' } });
    const nip11 = (await info.json().catch(() => ({}))) as { name?: string; software?: string };
    check('relay info (NIP-11)', info.ok && !!nip11.software, nip11.name);
    for (const [label, path] of [
      ['public page', '/'],
      ['admin app', '/admin/'],
      ['team app', '/app/'],
    ] as const) {
      const r = await fetch(`${base}${path}`, { headers: { accept: 'text/html' } });
      check(
        label,
        r.ok && (r.headers.get('content-type') ?? '').includes('text/html'),
        `${r.status}`,
      );
    }

    const bi = msb(['exec', name, '--', `/opt/beamhop/${bin}`, '--build-info']);
    let assets = { admin: 0, team: 0 };
    try {
      assets = (JSON.parse(bi.out.trim().split('\n').pop() ?? '{}') as { assets: typeof assets })
        .assets;
    } catch {}
    check('both apps embedded', assets.admin > 0 && assets.team > 0, JSON.stringify(assets));
    const cc = msb([
      'exec',
      name,
      '--',
      `/opt/beamhop/${bin}`,
      'claim-code',
      '--data-dir',
      '/var/lib/beamhop',
    ]);
    check('CLI reads the server data', cc.code === 0 && cc.out.includes('Claim code'));

    // EXIF (camera make + GPS, orientation 6) through /media → stripped and rotated.
    const jpeg = withExif(
      await syntheticImage(7, { width: 1600, height: 900, format: 'jpeg', quality: 90 }),
      6,
    );
    const media = await fetch(`${base}/media`, {
      method: 'PUT',
      body: jpeg as BodyInit,
      headers: { 'content-type': 'image/jpeg', authorization: blossomAuth('media', sha256(jpeg)) },
    });
    const md = (await media.json().catch(() => ({}))) as { sha256?: string };
    const stored = md.sha256
      ? new Uint8Array(await (await fetch(`${base}/${md.sha256}`)).arrayBuffer())
      : new Uint8Array();
    const meta = imageInfo(stored);
    check(
      'photo metadata removed and rotation applied',
      media.ok &&
        !new TextDecoder('latin1').decode(stored).includes('SecretCam') &&
        meta?.width === 900 &&
        meta.height === 1600,
      `${media.status} ${meta ? `${meta.width}x${meta.height}` : 'not an image'}`,
    );

    // PNG through /upload → thumbnail and responsive copies (image worker in the binary).
    const png = await syntheticImage(5, { width: 1000, height: 500 });
    const sha = sha256(png);
    const up = await fetch(`${base}/upload`, {
      method: 'PUT',
      body: png as BodyInit,
      headers: { 'content-type': 'image/png', authorization: blossomAuth('upload', sha) },
    });
    let variants: Array<{ role: string; dim: string; type: string }> = [];
    for (let i = 0; i < 40 && up.ok; i++) {
      const v = await fetch(`${base}/${sha}/variants`);
      if (v.ok) {
        const body = (await v.json()) as { status?: string; variants?: typeof variants };
        if (body.status === 'ready') {
          variants = body.variants ?? [];
          break;
        }
      }
      await Bun.sleep(500);
    }
    check(
      'thumbnail and copies made',
      variants.some(
        (v) => v.role === 'thumbnail' && v.dim === '320x320' && v.type === 'image/webp',
      ),
      variants.map((v) => `${v.role}:${v.dim}`).join(' ') || `upload ${up.status}`,
    );
  } finally {
    const logs = msb(['logs', name]);
    const errors = logs.out.split('\n').filter((l) => l.includes('"level":"error"'));
    check('no errors in the server log', errors.length === 0, errors[0]?.slice(0, 200));
    if (!a.keep) msb(['rm', '-f', name]);
  }
  return checks;
}

async function main(): Promise<void> {
  const a = parseSmokeArgs(process.argv.slice(2));
  const native = nativeTarget();
  let failed = 0;
  for (const t of a.targets) {
    if (t !== native) {
      console.log(`\n${t}: skipped (microVMs on this host run ${native} only)`);
      continue;
    }
    if (!existsSync(join(a.dist, `beamhop-${t}`))) {
      console.log(
        `\n${t}: missing ${join(a.dist, `beamhop-${t}`)} (bun run build -- --target ${t})`,
      );
      failed++;
      continue;
    }
    console.log(`\n${t} in a microsandbox Debian VM`);
    for (const c of await smokeTarget(t, a)) {
      console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `  (${c.detail})` : ''}`);
      if (!c.ok) failed++;
    }
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
