// SPDX-License-Identifier: AGPL-3.0-or-later
/** Everything a command needs from the outside world, injectable for tests. */
import { homedir } from 'node:os';
import { type FlagValues, str } from './args.ts';
import { type AdminClient, type FetchLike, normalizeServerUrl, remoteClient } from './client.ts';
import { credentialsPath, readCredentials } from './credentials.ts';
import { type Env, type Io, processIo } from './io.ts';
import { type LocalNode, type LocalOptions, bootLocal } from './local.ts';

export interface CliContext {
  io: Io;
  env: Env;
  cwd: string;
  home: string;
  fetch: FetchLike;
  /** Unix milliseconds. */
  now(): number;
  /** Tests: a ready client instead of resolving remote/local. */
  client?: () => Promise<AdminClient>;
  /** Tests: replace the local boot. */
  bootLocal?: (opts: LocalOptions) => Promise<LocalNode>;
  /** `beamhop serve` implementation (runtime-bun main). */
  serve?: (argv: string[]) => Promise<unknown>;
  /** Path of the running binary (for update/rollback). */
  execPath?: string;
}

export function defaultContext(overrides: Partial<CliContext> = {}): CliContext {
  const env = overrides.env ?? (process.env as Env);
  return {
    io: processIo(env),
    env,
    cwd: process.cwd(),
    home: env.HOME ?? homedir(),
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    execPath: process.execPath,
    ...overrides,
  };
}

export interface Target {
  kind: 'remote' | 'local';
  url?: string;
  token?: string;
}

/**
 * Where commands go (decided order):
 *   1. --url / $BEAMHOP_URL                → remote (token: --token, $BEAMHOP_TOKEN, saved login)
 *   2. --local, --data-dir, --config       → local data dir
 *   3. saved default login                 → remote
 *   4. otherwise                           → local data dir (./beamhop.yaml or ./data)
 */
export function resolveTarget(ctx: CliContext, flags: FlagValues): Target {
  const credsPath = credentialsPath(ctx.env, ctx.home);
  const explicitUrl = str(flags.url) ?? ctx.env.BEAMHOP_URL;
  const tokenFor = (url: string) =>
    str(flags.token) ?? ctx.env.BEAMHOP_TOKEN ?? readCredentials(credsPath).servers[url]?.token;
  if (explicitUrl) {
    const url = normalizeServerUrl(explicitUrl);
    const t: Target = { kind: 'remote', url };
    const token = tokenFor(url);
    if (token) t.token = token;
    return t;
  }
  if (flags.local === true || str(flags['data-dir']) || str(flags.config)) return { kind: 'local' };
  const creds = readCredentials(credsPath);
  if (creds.default && creds.servers[creds.default]) {
    const t: Target = { kind: 'remote', url: creds.default };
    const token = tokenFor(creds.default);
    if (token) t.token = token;
    return t;
  }
  return { kind: 'local' };
}

export function localOptions(
  ctx: CliContext,
  flags: FlagValues,
  extra: Partial<LocalOptions> = {},
): LocalOptions {
  const o: LocalOptions = { env: ctx.env, cwd: ctx.cwd, fetch: ctx.fetch, ...extra };
  const dataDir = str(flags['data-dir']);
  const configPath = str(flags.config);
  if (dataDir) o.dataDir = dataDir;
  if (configPath) o.configPath = configPath;
  return o;
}

export async function connect(ctx: CliContext, flags: FlagValues): Promise<AdminClient> {
  if (ctx.client) return ctx.client();
  const t = resolveTarget(ctx, flags);
  if (t.kind === 'remote') return remoteClient(t.url!, t.token, ctx.fetch);
  const node = await (ctx.bootLocal ?? bootLocal)(localOptions(ctx, flags));
  return node.client;
}
