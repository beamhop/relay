// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Saved logins: `~/.config/beamhop/credentials.json` (or `$XDG_CONFIG_HOME`),
 * written atomically with mode 0600 inside a 0700 directory. Only API tokens
 * are stored — never nsecs or bunker secrets.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Env } from './io.ts';

export interface SavedServer {
  token: string;
  tokenId?: string;
  pubkey?: string;
  savedAt: string;
  expiresAt?: number;
}

export interface Credentials {
  version: 1;
  default?: string;
  servers: Record<string, SavedServer>;
}

export function configHome(env: Env, home: string): string {
  return env.XDG_CONFIG_HOME
    ? join(env.XDG_CONFIG_HOME, 'beamhop')
    : join(home, '.config', 'beamhop');
}

export function credentialsPath(env: Env, home: string): string {
  return env.BEAMHOP_CREDENTIALS ?? join(configHome(env, home), 'credentials.json');
}

export function readCredentials(path: string): Credentials {
  if (!existsSync(path)) return { version: 1, servers: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Credentials>;
    return {
      version: 1,
      servers: parsed.servers ?? {},
      ...(parsed.default ? { default: parsed.default } : {}),
    };
  } catch {
    return { version: 1, servers: {} };
  }
}

export function writeCredentials(path: string, creds: Credentials): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

export function saveServer(
  path: string,
  url: string,
  entry: SavedServer,
  makeDefault = true,
): void {
  const creds = readCredentials(path);
  creds.servers[url] = entry;
  if (makeDefault || !creds.default) creds.default = url;
  writeCredentials(path, creds);
}

export function forgetServer(path: string, url: string): boolean {
  const creds = readCredentials(path);
  if (!creds.servers[url]) return false;
  delete creds.servers[url];
  if (creds.default === url) {
    const next = Object.keys(creds.servers)[0];
    if (next) creds.default = next;
    else creds.default = undefined;
  }
  writeCredentials(path, creds);
  return true;
}
