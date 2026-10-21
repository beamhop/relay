#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Beamhop server entry (also the compiled binary entry).
 *
 *   beamhop-server [--config beamhop.yaml] [--data-dir ./data] [--listen 0.0.0.0:3334] [--safe]
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { type Env, loadConfig, parseArgs, parseListen } from './config.ts';
import { loadModules } from './modules.ts';
import { JsonLogger } from './ports.ts';
import { type RunningServer, VERSION, startServer } from './server.ts';

const HELP = `Beamhop ${VERSION} — Nostr relay + media server

Usage: beamhop-server [options]

  -c, --config <file>   Settings file (default: ./beamhop.yaml or <data-dir>/beamhop.yaml)
      --data-dir <dir>  Where Beamhop keeps its data (default: ./data)
      --listen <addr>   Address to listen on, e.g. 0.0.0.0:3334
      --verify-workers <n>
                        Signature checking threads (default: CPU cores - 1;
                        0 checks signatures on the main thread)
      --safe            Start with plugins off and the last known good settings
      --no-config-writeback
                        Don't write changes made in the admin app back to the
                        settings file (also BEAMHOP_CONFIG_WRITEBACK=false)
  -h, --help            Show this help
  -v, --version         Show the version

Environment: BEAMHOP_* variables (e.g. BEAMHOP_NODE__TRUST_PROXY=true, BEAMHOP_DOMAIN=relay.example.com).
The settings file may use \${VAR} or \${VAR:-default}; these references are kept when
changes made in the admin app are written back to it.
`;

async function healthcheck(listen = '127.0.0.1:3334'): Promise<boolean> {
  const { hostname, port } = parseListen(listen);
  const host = hostname === '0.0.0.0' || hostname === '::' ? '127.0.0.1' : hostname;
  for (const scheme of ['http', 'https']) {
    try {
      const res = await fetch(`${scheme}://${host}:${port}/healthz`, {
        signal: AbortSignal.timeout(3000),
        tls: { rejectUnauthorized: false },
      } as RequestInit);
      if (res.ok) return true;
    } catch {
      // try next scheme
    }
  }
  return false;
}

export async function main(
  argv = process.argv.slice(2),
  env: Env = process.env,
): Promise<RunningServer | undefined> {
  const args = parseArgs(argv, env);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (args.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (args.healthcheck) {
    process.exitCode = (await healthcheck(args.listen ?? env.BEAMHOP_LISTEN)) ? 0 : 1;
    return;
  }
  const logger = new JsonLogger({
    level:
      (['debug', 'info', 'warn', 'error'] as const).find((l) => l === env.BEAMHOP_LOG_LEVEL) ??
      'info',
  });

  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig({ env, args });
  } catch (err) {
    logger.log('error', 'settings could not be loaded', { err });
    process.exitCode = 1;
    return;
  }
  if (loaded.file) logger.log('info', 'settings file applied', { file: loaded.file });
  if (loaded.defaultRelay)
    logger.log('info', 'no relays configured; answering on every hostname', {});

  const modules = await loadModules(loaded.config, logger);
  logger.log('info', 'modules loaded', { modules: modules.map((m) => m.id) });

  const devPwa = resolve(import.meta.dir, '../../pwa/build');
  const devTeam = resolve(import.meta.dir, '../../team-client/build');
  const running = await startServer({
    config: loaded.config,
    modules,
    logger,
    safe: args.safe,
    bootFile: loaded.file,
    configWriteBack: args.configWriteBack,
    overridePaths: loaded.overridePaths,
    pwaDir: env.BEAMHOP_PWA_DIR ?? (existsSync(devPwa) ? devPwa : undefined),
    teamDir: env.BEAMHOP_TEAM_DIR ?? (existsSync(devTeam) ? devTeam : undefined),
    tls: env.BEAMHOP_ACME_HTTP_PORT ? { httpPort: Number(env.BEAMHOP_ACME_HTTP_PORT) } : undefined,
  });

  let signals = 0;
  const onSignal = (sig: string) => {
    signals++;
    if (signals > 1) {
      logger.log('warn', 'forced exit', { signal: sig });
      process.exit(1);
    }
    running.stop(sig).then(
      () => process.exit(0),
      (err) => {
        logger.log('error', 'shutdown failed', { err });
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  return running;
}

if (import.meta.main) {
  await main();
}
