// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Single-binary self-update primitives shared by `beamhop update` /
 * `beamhop rollback` and the in-app update (`runtime.updater` service,
 * see system.ts): release manifest → download next to the binary → SHA-256 +
 * minisign → `--version` smoke test → atomic swap keeping `<bin>.previous`.
 *
 * Signatures: with no release public key (the built-in key is still a
 * placeholder) a download cannot be checked, so it is refused unless the
 * developer override is set (`--allow-unsigned` / BEAMHOP_UPDATE_ALLOW_UNSIGNED=1).
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { ReleaseCheck, StagedRelease, UpdateProgress } from '@beamhop/lifecycle';
import type { FetchLike } from './client.ts';
import { CliError } from './io.ts';
import { verifyMinisign } from './minisign.ts';

export const DEFAULT_MANIFEST_URL = 'https://get.beamhop.dev/releases/latest.json';

/**
 * Built-in release signing key (minisign public key line, `RW…`). Placeholder:
 * empty until the project publishes its release key; set `modules.updates.publicKey`
 * (or $BEAMHOP_UPDATE_PUBLIC_KEY) to install updates today.
 */
export const RELEASE_PUBLIC_KEY = '';

export const NO_KEY_MESSAGE =
  'Beamhop cannot check that this download is genuine yet (no release signing key is set up), so it was not installed. Developers can use --allow-unsigned (or BEAMHOP_UPDATE_ALLOW_UNSIGNED=1).';
export const UNSIGNED_MESSAGE =
  'This release is not signed, so it was not installed. Use --allow-unsigned to install it anyway.';

export interface ReleaseAsset {
  url: string;
  sha256: string;
  signature?: string;
  /** Download size in bytes (optional, for progress and previews). */
  size?: number;
}

export interface ReleaseManifest {
  version: string;
  notes?: string;
  assets: Record<string, ReleaseAsset>;
}

export interface UpdatesSettings {
  manifestUrl?: string;
  publicKey?: string;
}

export type RunBinary = (
  bin: string,
  args: string[],
  env: Record<string, string | undefined>,
) => Promise<{ code: number; stdout: string }>;

export type SignatureCheck = (
  asset: ReleaseAsset,
  sha256: string,
  data: Uint8Array,
) => Promise<'ok' | 'unsigned' | 'bad'>;

export function hostPlatform(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  return `${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
}

/** -1 / 0 / 1; pre-release suffixes sort before the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = '', pre] = v.replace(/^v/, '').split('-', 2);
    return { nums: main.split('.').map((x) => Number(x) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export async function defaultRun(
  bin: string,
  args: string[],
  env: Record<string, string | undefined>,
) {
  const proc = Bun.spawn([bin, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), 15_000);
  const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout };
}

const truthy = (v: string | undefined) => !!v && /^(1|true|yes)$/i.test(v.trim());

/** Developer override for unsigned downloads. */
export function allowUnsignedFromEnv(env: Record<string, string | undefined>): boolean {
  return truthy(env.BEAMHOP_UPDATE_ALLOW_UNSIGNED);
}

/** Release public key: env, then `modules.updates.publicKey`, then the built-in one. */
export function resolvePublicKey(
  env: Record<string, string | undefined>,
  settings: UpdatesSettings,
): string | null {
  const k =
    env.BEAMHOP_UPDATE_PUBLIC_KEY?.trim() || settings.publicKey?.trim() || RELEASE_PUBLIC_KEY;
  return k || null;
}

export function resolveManifestUrl(
  env: Record<string, string | undefined>,
  settings: UpdatesSettings,
  flag?: string,
): string {
  return flag ?? env.BEAMHOP_UPDATE_MANIFEST ?? (settings.manifestUrl || DEFAULT_MANIFEST_URL);
}

/** Resolve an asset/signature URL that may be relative to the manifest URL. */
export function resolveAgainst(url: string, base: string): string {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

const looksLikeLocation = (s: string) =>
  !s.includes('\n') &&
  (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /\.minisig(\?.*)?$/.test(s) || /^\.{0,2}\//.test(s));

/** The `.minisig` text for an asset (inline, or fetched from a URL relative to the manifest). */
export async function signatureText(
  fetchFn: FetchLike,
  asset: ReleaseAsset,
  manifest: string,
): Promise<string | null> {
  const s = asset.signature?.trim();
  if (!s) return null;
  if (!looksLikeLocation(s)) return s;
  const url = resolveAgainst(s, manifest);
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (err) {
    throw new CliError('Could not download the release signature.', 1, `${url}: ${String(err)}`);
  }
  if (!res.ok)
    throw new CliError(
      'Could not download the release signature.',
      1,
      `${url}: HTTP ${res.status}`,
    );
  return res.text();
}

export async function fetchManifest(fetchFn: FetchLike, url: string): Promise<ReleaseManifest> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { accept: 'application/json' } });
  } catch (err) {
    throw new CliError('Could not reach the release server.', 1, `${url}: ${String(err)}`);
  }
  if (!res.ok)
    throw new CliError(
      'The release server did not answer properly.',
      1,
      `${url}: HTTP ${res.status}`,
    );
  const m = (await res.json().catch(() => null)) as ReleaseManifest | null;
  if (!m?.version || !m.assets) throw new CliError('The release information is not valid.', 1, url);
  return m;
}

export interface ReleaseSource {
  manifestUrl: string;
  publicKey: string | null;
  allowUnsigned: boolean;
  platform: string;
  fetch: FetchLike;
}

/** The asset for this system, with its URL made absolute. */
export function assetFor(src: ReleaseSource, manifest: ReleaseManifest): ReleaseAsset {
  const listed = manifest.assets[src.platform];
  if (!listed)
    throw new CliError(
      `There is no ${manifest.version} download for this system (${src.platform}).`,
    );
  return { ...listed, url: resolveAgainst(listed.url, src.manifestUrl) };
}

/** Compare the manifest with the running version (never throws: errors land in `error`). */
export async function checkRelease(src: ReleaseSource, current: string): Promise<ReleaseCheck> {
  const base = {
    current,
    allowUnsigned: src.allowUnsigned,
    source: src.manifestUrl,
  };
  let manifest: ReleaseManifest;
  try {
    manifest = await fetchManifest(src.fetch, src.manifestUrl);
  } catch (err) {
    const e = err as CliError;
    return {
      ...base,
      latest: null,
      updateAvailable: false,
      signature: src.publicKey ? 'unsigned-release' : 'no-key',
      error: e.message,
      ...(e.technical ? { technical: e.technical } : {}),
    };
  }
  const listed = manifest.assets[src.platform];
  const signature: ReleaseCheck['signature'] = !src.publicKey
    ? 'no-key'
    : listed?.signature?.trim()
      ? 'verifiable'
      : 'unsigned-release';
  const newer = compareVersions(manifest.version, current) > 0;
  const out: ReleaseCheck = {
    ...base,
    latest: manifest.version,
    updateAvailable: newer && !!listed,
    signature,
    ...(manifest.notes ? { notes: manifest.notes } : {}),
    ...(listed?.size ? { downloadBytes: listed.size } : {}),
  };
  if (newer && !listed) {
    out.error = `There is no ${manifest.version} download for this system (${src.platform}).`;
    out.technical = `manifest has no assets.${src.platform}`;
  }
  return out;
}

export interface StageOptions {
  bin: string;
  run?: RunBinary;
  env?: Record<string, string | undefined>;
  /** Tests: replace the minisign check. */
  verifySignature?: SignatureCheck;
  /** When a server is running, the new binary's `--healthcheck` must pass against it. */
  healthcheckUrl?: string | null;
  onProgress?: (p: UpdateProgress) => void;
  /** Plain status lines ("Checksum and signature verified."). */
  note?: (line: string) => void;
}

/**
 * Download → checksum → signature → smoke test. The verified binary is left
 * at `.<bin>.download-<pid>` next to the current one; nothing is replaced.
 */
export async function stageRelease(
  src: ReleaseSource,
  manifest: ReleaseManifest,
  opts: StageOptions,
): Promise<StagedRelease> {
  const asset = assetFor(src, manifest);
  const sigText = opts.verifySignature
    ? null
    : await signatureText(src.fetch, asset, src.manifestUrl);
  if (!opts.verifySignature && !src.allowUnsigned) {
    if (!src.publicKey)
      throw new CliError(NO_KEY_MESSAGE, 1, 'no release public key (RELEASE_PUBLIC_KEY is empty)');
    if (!sigText)
      throw new CliError(
        UNSIGNED_MESSAGE,
        1,
        `manifest ${src.manifestUrl}: assets.${src.platform}.signature is missing`,
      );
  }
  const bin = opts.bin;
  if (!existsSync(bin)) throw new CliError(`${bin} does not exist`);
  const tmp = join(dirname(bin), `.${basename(bin)}.download-${process.pid}`);
  let keep = false;
  try {
    const res = await src.fetch(asset.url).catch((err) => {
      throw new CliError('The download failed.', 1, String(err));
    });
    if (!res.ok || !res.body) throw new CliError('The download failed.', 1, `HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || asset.size || undefined;
    const chunks: Uint8Array[] = [];
    let done = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done: end, value } = await reader.read();
      if (end) break;
      chunks.push(value);
      done += value.length;
      opts.onProgress?.({ done, ...(total ? { total: Math.max(total, done) } : {}) });
    }
    opts.onProgress?.({ done, total: done });
    const data = new Uint8Array(done);
    let off = 0;
    for (const c of chunks) {
      data.set(c, off);
      off += c.length;
    }
    writeFileSync(tmp, data, { mode: 0o755 });
    const sha = new Bun.CryptoHasher('sha256').update(data).digest('hex');
    if (sha !== asset.sha256.toLowerCase())
      throw new CliError(
        'The download is damaged (checksum mismatch); nothing was changed.',
        1,
        `sha256 ${sha} ≠ ${asset.sha256}`,
      );
    let why = '';
    const verify =
      opts.verifySignature ??
      (async (): Promise<'ok' | 'unsigned' | 'bad'> => {
        if (!src.publicKey || !sigText) return 'unsigned';
        const r = verifyMinisign(data, sigText, src.publicKey);
        if (!r.ok) why = r.reason;
        return r.ok ? 'ok' : 'bad';
      });
    const sig = await verify(asset, sha, data);
    if (sig === 'bad')
      throw new CliError(
        'The download is not signed by Beamhop; nothing was changed.',
        1,
        why || 'signature check failed',
      );
    opts.note?.(
      sig === 'ok'
        ? 'Checksum and signature verified.'
        : src.publicKey
          ? 'Checksum verified; the release is NOT signed (--allow-unsigned).'
          : 'Checksum verified; signatures were NOT checked (no release key, --allow-unsigned).',
    );
    chmodSync(tmp, 0o755);
    const run = opts.run ?? defaultRun;
    const env = opts.env ?? {};
    const v = await run(tmp, ['--version'], { ...env });
    if (v.code !== 0 || !v.stdout.includes(manifest.version.replace(/^v/, '')))
      throw new CliError(
        'The new version did not start correctly; nothing was changed.',
        1,
        `--version → exit ${v.code}: ${v.stdout.trim()}`,
      );
    if (opts.healthcheckUrl) {
      const hc = await run(tmp, ['--healthcheck'], {
        ...env,
        BEAMHOP_LISTEN: new URL(opts.healthcheckUrl).host,
      });
      if (hc.code !== 0)
        throw new CliError(
          'The new version failed its health check; nothing was changed.',
          1,
          `--healthcheck → exit ${hc.code}`,
        );
    }
    keep = true;
    return { version: manifest.version, path: tmp, sha256: sha, signed: sig === 'ok', bytes: done };
  } finally {
    if (!keep) rmSync(tmp, { force: true });
  }
}

// ── on-disk swap / rollback ──

export const previousPath = (bin: string) => `${bin}.previous`;
/** Crash-loop guard: written at swap, removed after a healthy boot or a rollback. */
export const pendingPath = (bin: string) => `${bin}.pending.json`;

export interface PendingUpdate {
  from: string;
  to: string;
  attempts: number;
}

/** Atomic swap: keep the current binary as `<bin>.previous`, rename the staged one over it. */
export function swapBinary(
  bin: string,
  staged: Pick<StagedRelease, 'path' | 'version'>,
  currentVersion: string,
  nowMs: number,
): { previousVersion: string } {
  const previous = previousPath(bin);
  try {
    copyFileSync(bin, `${previous}.tmp`);
    chmodSync(`${previous}.tmp`, 0o755);
    renameSync(`${previous}.tmp`, previous);
    writeFileSync(
      `${previous}.json`,
      JSON.stringify({ version: currentVersion, replacedAt: new Date(nowMs).toISOString() }),
    );
    renameSync(staged.path, bin);
    writeFileSync(
      pendingPath(bin),
      JSON.stringify({ from: currentVersion, to: staged.version, attempts: 0 } as PendingUpdate),
    );
  } finally {
    rmSync(`${previous}.tmp`, { force: true });
  }
  return { previousVersion: currentVersion };
}

export function previousVersion(bin: string): { version: string } | null {
  const previous = previousPath(bin);
  if (!existsSync(previous)) return null;
  try {
    return {
      version: (JSON.parse(readFileSync(`${previous}.json`, 'utf8')) as { version: string })
        .version,
    };
  } catch {
    return { version: 'the previous version' };
  }
}

/** Put `<bin>.previous` back; the replaced binary is kept as `<bin>.rolled-back`. */
export function rollbackBinary(bin: string): { version: string } {
  const prev = previousVersion(bin);
  if (!prev) throw new CliError('There is no previous version to go back to.');
  const previous = previousPath(bin);
  copyFileSync(bin, `${bin}.rolled-back.tmp`);
  renameSync(`${bin}.rolled-back.tmp`, `${bin}.rolled-back`);
  renameSync(previous, bin);
  rmSync(`${previous}.json`, { force: true });
  rmSync(pendingPath(bin), { force: true });
  return prev;
}

export function readPending(bin: string): PendingUpdate | null {
  try {
    return JSON.parse(readFileSync(pendingPath(bin), 'utf8')) as PendingUpdate;
  } catch {
    return null;
  }
}

/**
 * Crash-loop guard, run by the binary before the server starts: a new version
 * that keeps dying before it reports healthy is rolled back after `maxAttempts`
 * starts (a supervisor then starts the previous one). Returns what it did.
 */
export function bootGuard(
  bin: string,
  version: string,
  maxAttempts = 3,
): 'none' | 'counted' | 'rolled-back' {
  const p = readPending(bin);
  if (!p || p.to !== version) return 'none';
  const attempts = p.attempts + 1;
  if (attempts > maxAttempts && previousVersion(bin)) {
    rollbackBinary(bin);
    return 'rolled-back';
  }
  writeFileSync(pendingPath(bin), JSON.stringify({ ...p, attempts }));
  return 'counted';
}
