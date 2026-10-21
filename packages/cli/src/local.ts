// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Local mode: manage the node on this machine without a login by booting
 * the same kernel + modules the server uses, against the same data dir, and
 * calling the admin API in-process (`kernel.http`). No port is opened.
 *
 * Safety (decided):
 * - Refuses to run while the server answers on its listen address: two
 *   processes would each keep their own in-memory state (settings, caches)
 *   and silently overwrite each other. Use `--url` (or `beamhop login`) then.
 * - Refuses when the data dir does not exist (never creates an empty node by
 *   accident) or when storage would fall back to memory.
 * - Whoever can read the data dir can read the database anyway, so local
 *   mode acts as an owner (`via: cli`); every action is still audited.
 */
import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import {
  type BeamhopConfig,
  type Kernel,
  type Principal,
  createKernel,
  topoSort,
} from '@beamhop/core';
import {
  JsonLogger,
  type LoadedConfig,
  createDefaultPorts,
  dataLayout,
  loadConfig,
  loadModules,
  parseListen,
  withDataDirDefaults,
} from '@beamhop/runtime-bun';
import { type AdminClient, type FetchLike, kernelClient } from './client.ts';
import { CliError, type Env } from './io.ts';

export interface LocalOptions {
  env: Env;
  cwd: string;
  dataDir?: string;
  configPath?: string;
  fetch: FetchLike;
  /** Skip the "server is running" guard (read-only commands like claim-code). */
  allowRunning?: boolean;
}

export function cliLogger(env: Env) {
  const level =
    (['debug', 'info', 'warn', 'error'] as const).find((l) => l === env.BEAMHOP_LOG_LEVEL) ??
    'error';
  return new JsonLogger({ level, write: (l) => process.stderr.write(`${l}\n`) });
}

/** Resolve settings the same way the server does (file > env > defaults). */
export function resolveLocalConfig(
  opts: Pick<LocalOptions, 'env' | 'cwd' | 'dataDir' | 'configPath'>,
): LoadedConfig {
  const args: { dataDir?: string; configPath?: string } = {};
  if (opts.dataDir) args.dataDir = opts.dataDir;
  if (opts.configPath) args.configPath = opts.configPath;
  try {
    return loadConfig({ env: opts.env, args, cwd: opts.cwd });
  } catch (err) {
    throw new CliError('The settings file could not be read', 1, String(err));
  }
}

/** Probe `/healthz` on the configured listen address. */
export async function serverRunning(
  config: BeamhopConfig,
  fetchFn: FetchLike,
): Promise<string | null> {
  const { hostname, port } = parseListen(config.node.listen);
  const host = hostname === '0.0.0.0' || hostname === '::' ? '127.0.0.1' : hostname;
  for (const scheme of ['http', 'https']) {
    const url = `${scheme}://${host.includes(':') ? `[${host}]` : host}:${port}`;
    try {
      const res = await fetchFn(`${url}/healthz`, {
        signal: AbortSignal.timeout(800),
        tls: { rejectUnauthorized: false },
      } as RequestInit);
      if (res.ok || res.status === 503) return url;
    } catch {
      // not listening
    }
  }
  return null;
}

export const LOCAL_PRINCIPAL_ID = 'cli:local';

export interface LocalNode {
  kernel: Kernel;
  config: BeamhopConfig;
  dataDir: string;
  client: AdminClient;
  close(): Promise<void>;
}

export async function bootLocal(opts: LocalOptions): Promise<LocalNode> {
  const loaded = resolveLocalConfig(opts);
  const layout = dataLayout(loaded.config.node.dataDir);
  if (!existsSync(layout.root))
    throw new CliError(
      `No Beamhop data found at ${layout.root}.\nStart the server once with \`beamhop serve\`, or pass --data-dir <dir> or --url <server>.`,
    );
  if (!opts.allowRunning) {
    const running = await serverRunning(loaded.config, opts.fetch);
    if (running)
      throw new CliError(
        `The server is running (${running}), so the command line will not open its data directly.\nUse the server instead: \`beamhop login ${running}\`, then run the command again (or pass --url).`,
        1,
        'local mode refuses to share the data dir with a running server',
      );
  }
  const logger = cliLogger(opts.env);
  const config = withDataDirDefaults(loaded.config, layout);
  const modules = await loadModules(config, logger);
  const defaults = await createDefaultPorts(config, layout, logger);
  if (defaults.memoryFallbacks.length && config.storage.driver !== 'memory') {
    await defaults.close();
    throw new CliError(
      'The database could not be opened, so nothing was changed.',
      1,
      `memory fallback for: ${defaults.memoryFallbacks.join(', ')}`,
    );
  }
  const kernel = await createKernel({ runtime: 'bun', ports: defaults.ports, config, modules });
  const secret = defaults.ports.crypto.randomHex(24);
  let who = 'unknown';
  try {
    who = userInfo().username;
  } catch {
    // ignore
  }
  const principal: Principal = {
    id: LOCAL_PRINCIPAL_ID,
    roles: { '*': 'owner' },
    via: 'cli',
    displayName: `Command line on the server (${who})`,
  };
  kernel.authProviders.unshift({
    id: 'cli-local',
    label: 'Local command line',
    async authenticate(req) {
      return req.headers.get('authorization') === `Local ${secret}` ? { ...principal } : null;
    },
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const m of [...topoSort(modules)].reverse()) {
      try {
        await m.stop?.(kernel);
      } catch {
        // best effort
      }
    }
    await defaults.close();
  };
  return {
    kernel,
    config: kernel.config(),
    dataDir: layout.root,
    client: kernelClient(kernel, `Local ${secret}`, { target: layout.root, onClose: close }),
    close,
  };
}
