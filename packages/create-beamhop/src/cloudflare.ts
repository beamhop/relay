// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `create-beamhop --cf`: one-command Cloudflare setup.
 *
 *   wrangler check → sign-in check → 3 questions → project files → npm install →
 *   D1 database → R2 bucket → wrangler.toml → D1 migrations → deploy →
 *   IP_HASH_SALT secret → first-run claim code → print admin link.
 *
 * Every step looks before it creates, so re-running is safe. `--dry-run` prints the
 * commands and files instead of running/writing them.
 */
import { join } from 'node:path';
import type { Files, Io, RunOptions, RunResult, Runner } from './io.ts';
import {
  DEFAULT_RUNTIME_SPEC,
  GITIGNORE,
  RUNTIME_PACKAGE,
  beamhopConfig,
  packageJson,
  wranglerToml,
} from './templates.ts';
import {
  type Options,
  humanCode,
  normalizeDomain,
  parsePubkey,
  randomSecret,
  slugify,
} from './util.ts';

export interface SetupDeps {
  runner: Runner;
  files: Files;
  io: Io;
  /** Defaults: random claim code / salt and Date.now (injectable for tests). */
  claimCode?: () => string;
  secret?: () => string;
  now?: () => number;
}

export interface SetupResult {
  projectDir: string;
  /** Public https URL of the Worker (undefined when unknown, e.g. dry run). */
  url?: string;
  adminUrl?: string;
  /** One-time claim code, or null when the relay already has an owner. */
  claimCode: string | null;
  created: { d1: boolean; r2: boolean; secret: boolean };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const DEFAULT_NAME = 'My Beamhop Relay';

export class SetupError extends Error {}

/** Shell-style rendering for printing commands. */
export function showCommand(cmd: string[]): string {
  return cmd
    .map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))
    .join(' ');
}

/** Parse the first JSON value in mixed wrangler output (banners may precede it). */
function parseJson<T>(text: string): T | undefined {
  const start = text.search(/[[{]/);
  if (start < 0) return undefined;
  try {
    return JSON.parse(text.slice(start)) as T;
  } catch {
    return undefined;
  }
}

export async function setupCloudflare(opts: Options, deps: SetupDeps): Promise<SetupResult> {
  const { files, io } = deps;
  const dry = opts.dryRun;
  const now = deps.now ?? Date.now;

  const exec = async (cmd: string[], o: RunOptions & { what?: string } = {}) => {
    const where = o.cwd ? `  (in ${o.cwd})` : '';
    const secret = o.input !== undefined ? '  (value hidden)' : '';
    io.log(`${dry ? '[dry run] ' : ''}$ ${showCommand(cmd)}${where}${secret}`);
    if (dry) return { code: 0, stdout: '', stderr: '' } as RunResult;
    return deps.runner.run(cmd, o);
  };
  const must = async (cmd: string[], what: string, o: RunOptions = {}) => {
    const r = await exec(cmd, o);
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout).trim().split('\n').slice(-5).join('\n');
      throw new SetupError(`Could not ${what}.\n${detail}`);
    }
    return r;
  };
  const write = (path: string, content: string) => {
    if (dry) io.log(`[dry run] would write ${path}`);
    else files.write(path, content);
  };

  io.log('Setting up Beamhop on Cloudflare (Workers + Durable Objects + D1 + R2).');
  io.log();

  // 1. wrangler available? Prefer a global install, else run it through npx.
  let wr = ['wrangler'];
  const version = await exec(['wrangler', '--version']);
  if (version.code !== 0) {
    io.log('wrangler is not installed globally; using it through npx.');
    wr = ['npx', '--yes', 'wrangler'];
  }

  // 2. Signed in to Cloudflare?
  const who = await exec([...wr, 'whoami']);
  if (!dry && (who.code !== 0 || /not authenticated|wrangler login/i.test(who.stdout))) {
    io.log('Sign in to Cloudflare in the browser window that opens…');
    await must([...wr, 'login'], 'sign in to Cloudflare', { interactive: true });
  }

  // 3. Three questions (skipped when given as flags or with --yes).
  const ask = async (q: string, flag: string | undefined, fallback: string) => {
    if (flag !== undefined) return flag;
    if (opts.yes) return fallback;
    return io.ask(q, fallback);
  };
  const relayName =
    (await ask('Name of your relay?', opts.name, DEFAULT_NAME)).trim() || DEFAULT_NAME;
  const worker = slugify(relayName);
  const dir = opts.dir ?? worker;
  const configPath = join(dir, 'beamhop.config.json');
  const existing = files.exists(configPath)
    ? parseJson<ReturnType<typeof beamhopConfig>>(files.read(configPath))
    : undefined;
  const prevHost = existing?.relays?.[0]?.hosts?.[0];
  const domainAnswer = await ask(
    'Your own domain (or press Enter for a free workers.dev address)?',
    opts.domain,
    prevHost && prevHost !== '*' ? prevHost : 'workers.dev',
  );
  const domain = normalizeDomain(domainAnswer);
  const prevOwner = existing?.relays?.[0]?.info?.pubkey;
  const ownerAnswer = await ask(
    'Your Nostr public key (npub…), shown as the relay owner? Optional, press Enter to skip.',
    opts.owner,
    '',
  );
  let ownerHex = prevOwner;
  if (ownerAnswer.trim()) {
    const hex = parsePubkey(ownerAnswer);
    if (!hex) throw new SetupError('That is not a valid npub (it should start with "npub1").');
    ownerHex = hex;
  }
  io.log();

  // 4. Project files (beamhop.config.json is merged so your other edits survive).
  const runtimeSpec = opts.runtime ?? DEFAULT_RUNTIME_SPEC;
  const fresh = beamhopConfig({ relayName, domain, ownerHex });
  let config: Record<string, unknown> = fresh;
  if (existing) {
    const relays = [...(existing.relays ?? [])];
    const first = relays[0] ?? fresh.relays[0]!;
    const info: Record<string, unknown> = { ...first.info, name: relayName };
    if (ownerHex) info.pubkey = ownerHex;
    relays[0] = { ...first, hosts: domain ? [domain] : ['*'], info: info as typeof first.info };
    config = { ...existing, relays };
  }
  write(configPath, `${JSON.stringify(config, null, 2)}\n`);
  if (!files.exists(join(dir, 'package.json')))
    write(join(dir, 'package.json'), packageJson({ worker }, runtimeSpec));
  if (!files.exists(join(dir, '.gitignore'))) write(join(dir, '.gitignore'), GITIGNORE);

  if (files.exists(join(dir, 'node_modules', RUNTIME_PACKAGE, 'package.json'))) {
    io.log('Beamhop Worker bundle already installed.');
  } else {
    await must(['npm', 'install', '--no-fund', '--no-audit'], 'install the Beamhop Worker bundle', {
      cwd: dir,
      echo: true,
    });
  }

  // 5. D1 database (data).
  const d1Name = worker;
  let d1Id: string | undefined;
  let createdD1 = false;
  const list = await exec([...wr, 'd1', 'list', '--json']);
  const found = parseJson<{ uuid?: string; name?: string }[]>(list.stdout)?.find(
    (d) => d.name === d1Name,
  );
  if (found?.uuid) {
    d1Id = found.uuid;
    io.log(`Database "${d1Name}" already exists, reusing it.`);
  } else {
    const created = await must([...wr, 'd1', 'create', d1Name], 'create the D1 database');
    createdD1 = true;
    d1Id = created.stdout.match(UUID)?.[0];
    if (!d1Id && !dry) {
      const again = await exec([...wr, 'd1', 'list', '--json']);
      d1Id = parseJson<{ uuid?: string; name?: string }[]>(again.stdout)?.find(
        (d) => d.name === d1Name,
      )?.uuid;
    }
    if (!d1Id && !dry) throw new SetupError('Created the database but could not read its id.');
  }
  d1Id ??= '<new-d1-database-id>';

  // 6. R2 bucket (photos, video, files).
  const bucket = `${worker}-blobs`;
  const buckets = await exec([...wr, 'r2', 'bucket', 'list']);
  const names = [...buckets.stdout.matchAll(/^name:\s+(\S+)/gm)].map((m) => m[1]);
  let createdR2 = false;
  if (names.includes(bucket)) {
    io.log(`Storage bucket "${bucket}" already exists, reusing it.`);
  } else {
    await must([...wr, 'r2', 'bucket', 'create', bucket], 'create the R2 storage bucket');
    createdR2 = true;
  }

  // 7. wrangler.toml with the real ids.
  const toml = wranglerToml({ worker, relayName, domain, ownerHex, d1Name, d1Id, bucket });
  write(join(dir, 'wrangler.toml'), toml);
  if (dry) io.log(toml.replace(/^/gm, '    '));

  // 8. Database tables (already-applied migrations are skipped by wrangler).
  await must([...wr, 'd1', 'migrations', 'apply', d1Name, '--remote'], 'set up the database', {
    cwd: dir,
    echo: true,
  });

  // 9. Deploy.
  const deployed = await must([...wr, 'deploy'], 'deploy the Worker', { cwd: dir, echo: true });
  const url = domain
    ? `https://${domain}`
    : deployed.stdout.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];

  // 10. Secrets (only ones that are missing).
  const secrets = await exec([...wr, 'secret', 'list'], { cwd: dir });
  const have = (parseJson<{ name?: string }[]>(secrets.stdout) ?? []).map((s) => s.name);
  let createdSecret = false;
  if (have.includes('IP_HASH_SALT')) {
    io.log('Privacy salt (IP_HASH_SALT) already set.');
  } else {
    await must([...wr, 'secret', 'put', 'IP_HASH_SALT'], 'save the privacy salt', {
      cwd: dir,
      input: (deps.secret ?? randomSecret)(),
    });
    createdSecret = true;
  }

  // 11. First-run claim code: seed one unless the relay already has an owner.
  //     (Workers have no console to print the server-generated code, so we create it.)
  const code = dry ? '<claim code>' : (deps.claimCode ?? (() => humanCode(4)))();
  const t = now();
  const value = JSON.stringify({ code, createdAt: t }).replace(/'/g, "''");
  const sql = [
    'INSERT OR IGNORE INTO docs (collection, key, value, updated_at)',
    `SELECT 'admin.claim', 'code', '${value}', ${t}`,
    "WHERE NOT EXISTS (SELECT 1 FROM docs WHERE collection = 'admin.admins');",
    "SELECT (SELECT COUNT(*) FROM docs WHERE collection = 'admin.admins') AS owners,",
    "(SELECT value FROM docs WHERE collection = 'admin.claim' AND key = 'code') AS claim;",
  ].join(' ');
  const claimRes = await must(
    [...wr, 'd1', 'execute', d1Name, '--remote', '--json', '--command', sql],
    'prepare the first sign-in',
    { cwd: dir },
  );
  let claimCode: string | null = code;
  if (!dry) {
    const rows = (
      parseJson<{ results?: { owners?: number; claim?: string | null }[] }[]>(claimRes.stdout) ?? []
    )
      .flatMap((r) => r.results ?? [])
      .filter((r) => 'owners' in r);
    const row = rows[rows.length - 1];
    if (row && Number(row.owners) > 0) claimCode = null;
    else if (row?.claim) claimCode = (JSON.parse(row.claim) as { code?: string }).code ?? code;
  }

  // 12. Done.
  const shownUrl = url ?? `https://${worker}.<your-subdomain>.workers.dev`;
  const adminUrl = `${shownUrl}/admin/`;
  io.log();
  io.log(dry ? 'Dry run finished. Nothing was changed.' : 'Your relay is live.');
  io.log(`  Relay:       ${shownUrl.replace(/^https:/, 'wss:')}`);
  io.log(`  Admin:       ${adminUrl}`);
  if (claimCode) {
    io.log(`  Claim code:  ${claimCode}   (one-time, makes you the owner)`);
    io.log();
    io.log('First sign-in: open the Admin link, sign in with your Nostr app or a passkey,');
    io.log('and enter the claim code. Keep the recovery codes it shows you somewhere safe.');
  } else {
    io.log();
    io.log('This relay already has an owner. Open the Admin link and sign in.');
  }
  if (domain && !dry)
    io.log(
      `It can take a few minutes before ${domain} answers (Cloudflare sets up DNS and HTTPS).`,
    );
  io.log(`To change settings later, edit ${configPath} and run \`npm run deploy\` in ${dir}.`);

  return {
    projectDir: dir,
    url,
    adminUrl: url ? `${url}/admin/` : undefined,
    claimCode,
    created: { d1: createdD1, r2: createdR2, secret: createdSecret },
  };
}
