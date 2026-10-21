// SPDX-License-Identifier: AGPL-3.0-or-later
/** `beamhop init`: three questions (domain, persona, storage) → beamhop.yaml. */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type FlagSpec, type FlagValues, bool, flagHelp, parseFlags, str } from '../args.ts';
import type { CliContext } from '../context.ts';
import { EXIT, UsageError, line, paint } from '../io.ts';

export const PERSONAS = [
  ['public-social', 'Public social — anyone can join and post'],
  ['private-team', 'Private team — only invited people'],
  ['wot-community', 'Community — people trusted by people you follow'],
  ['media-host', 'Media host — mostly photos, video and files'],
  ['organization', 'Company / organization — adds sign-in with your company accounts'],
] as const;
export type PersonaId = (typeof PERSONAS)[number][0];

export const STORAGES = [
  ['sqlite', 'A file on this server (simplest, recommended)'],
  ['postgres', 'A PostgreSQL database'],
  ['memory', 'Nothing saved — for trying things out only'],
] as const;
export type StorageId = (typeof STORAGES)[number][0];

export interface InitAnswers {
  domain: string | null;
  persona: PersonaId;
  storage: StorageId;
  postgresUrl?: string;
  email?: string;
  listen?: string;
  dataDir?: string;
}

const FLAGS: FlagSpec[] = [
  {
    name: 'domain',
    type: 'string',
    placeholder: '<host>',
    description: 'Domain name, e.g. relay.example.com',
  },
  {
    name: 'persona',
    type: 'string',
    placeholder: '<persona>',
    description: `What kind of relay: ${PERSONAS.map((p) => p[0]).join(', ')}`,
  },
  {
    name: 'storage',
    type: 'string',
    placeholder: '<kind>',
    description: 'Where data lives: sqlite, postgres or memory',
  },
  {
    name: 'postgres-url',
    type: 'string',
    placeholder: '<url>',
    description: 'Connection URL when storage is postgres',
  },
  {
    name: 'email',
    type: 'string',
    placeholder: '<email>',
    description: 'Email for certificate expiry notices (optional)',
  },
  {
    name: 'listen',
    type: 'string',
    placeholder: '<addr>',
    description: 'Address to listen on (default 0.0.0.0:3334)',
  },
  {
    name: 'output',
    type: 'string',
    short: 'o',
    placeholder: '<file>',
    description: 'Where to write (default ./beamhop.yaml)',
  },
  { name: 'force', type: 'boolean', description: 'Overwrite an existing file' },
];

const HOST_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

export function normalizeDomain(input: string): string | null {
  const t = input
    .trim()
    .toLowerCase()
    .replace(/^wss?:\/\//, '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!t || t === '*') return null;
  if (!HOST_RE.test(t))
    throw new UsageError(`“${input}” does not look like a domain name (e.g. relay.example.com)`);
  return t;
}

function pick<T extends readonly (readonly [string, string])[]>(
  list: T,
  input: string,
  what: string,
): T[number][0] {
  const t = input.trim().toLowerCase();
  const n = Number(t);
  if (Number.isInteger(n) && n >= 1 && n <= list.length) return list[n - 1]![0];
  const hit = list.find(([id]) => id === t || id.startsWith(t));
  if (!t || !hit)
    throw new UsageError(
      `Unknown ${what} “${input}”. Choose one of: ${list.map((l) => l[0]).join(', ')}`,
    );
  return hit[0];
}

const isPublicDomain = (d: string | null) =>
  !!d && d.includes('.') && !d.endsWith('.localhost') && !d.endsWith('.local');

const yamlStr = (s: string) =>
  /^[A-Za-z0-9_./:@-]+$/.test(s) && !/^(true|false|null|yes|no|~)$/i.test(s)
    ? s
    : JSON.stringify(s);

/** Render the commented beamhop.yaml for the answers (pure; snapshot-tested). */
export function renderInitYaml(a: InitAnswers, today: string): string {
  const tlsMode = isPublicDomain(a.domain) ? 'auto' : 'off';
  const lines = [
    `# Beamhop settings — created by \`beamhop init\` on ${today}.`,
    '# The admin app keeps this file and its own settings in sync; edit either.',
    '# Every option: https://beamhop.dev/docs/config (or `beamhop config export`).',
    'version: 1',
    'node:',
    `  listen: ${yamlStr(a.listen ?? '0.0.0.0:3334')}`,
    `  dataDir: ${yamlStr(a.dataDir ?? './data')}`,
    '  tls:',
    '    # auto: get a free certificate when reachable on :443, otherwise expect a proxy',
    `    mode: ${tlsMode}`,
  ];
  if (a.email) lines.push(`    email: ${yamlStr(a.email)}`);
  lines.push('storage:', `  driver: ${a.storage}`);
  if (a.storage === 'postgres') {
    if (a.postgresUrl) lines.push(`  url: ${yamlStr(a.postgresUrl)}`);
    else
      lines.push(
        '  # Set the connection URL here or in the BEAMHOP_STORAGE__URL environment variable.',
      );
  }
  if (a.storage === 'memory')
    lines.push('  # WARNING: nothing is saved; everything is lost on restart.');
  lines.push(
    'blobStorage:',
    `  driver: ${a.storage === 'memory' ? 'memory' : 'fs'}`,
    'relays:',
    '  - id: main',
    '    hosts:',
    a.domain
      ? `      - ${yamlStr(a.domain)}`
      : `      - "*"   # answers on every address; set your domain later`,
    `    persona: ${a.persona}`,
    '    info:',
    `      name: ${yamlStr(a.domain ?? 'My Beamhop relay')}`,
  );
  return `${lines.join('\n')}\n`;
}

export async function initCommand(
  ctx: CliContext,
  argv: string[],
  globals: FlagValues,
): Promise<number> {
  const { io } = ctx;
  const p = paint(io);
  const { flags } = parseFlags(argv, FLAGS);
  if (bool(globals.help)) {
    io.out(
      `Create beamhop.yaml by answering three questions.\n\nUsage: beamhop init [options]\n\n${flagHelp(FLAGS)}\n\nWithout a terminal, missing answers use defaults (no domain, public-social, sqlite).\n`,
    );
    return EXIT.ok;
  }
  const out = resolve(ctx.cwd, str(flags.output) ?? str(globals.config) ?? 'beamhop.yaml');
  if (existsSync(out) && !bool(flags.force))
    throw new UsageError(`${out} already exists. Use --force to replace it.`);
  const ask = io.interactive && !bool(globals.yes);

  let domain: string | null;
  const dFlag = str(flags.domain);
  if (dFlag !== undefined) domain = normalizeDomain(dFlag);
  else if (ask) {
    line(io, p.bold('1/3  Domain'));
    line(
      io,
      '     The address people will use, e.g. relay.example.com. Leave empty to decide later.',
    );
    domain = normalizeDomain(await io.prompt('     Domain'));
  } else domain = null;

  let persona: PersonaId;
  const pFlag = str(flags.persona);
  if (pFlag !== undefined) persona = pick(PERSONAS, pFlag, 'persona');
  else if (ask) {
    line(io, p.bold('2/3  What kind of relay is this?'));
    for (const [i, [, label]] of PERSONAS.entries()) line(io, `     ${i + 1}. ${label}`);
    persona = pick(PERSONAS, await io.prompt('     Choose', '1'), 'persona');
  } else persona = 'public-social';

  let storage: StorageId;
  const sFlag = str(flags.storage);
  if (sFlag !== undefined) storage = pick(STORAGES, sFlag, 'storage');
  else if (ask) {
    line(io, p.bold('3/3  Where should data be kept?'));
    for (const [i, [, label]] of STORAGES.entries()) line(io, `     ${i + 1}. ${label}`);
    storage = pick(STORAGES, await io.prompt('     Choose', '1'), 'storage');
  } else storage = 'sqlite';

  const answers: InitAnswers = { domain, persona, storage };
  const pg =
    str(flags['postgres-url']) ??
    (storage === 'postgres' && ask
      ? (await io.promptSecret('     PostgreSQL URL (hidden; empty = set it later)')).trim()
      : undefined);
  if (pg) answers.postgresUrl = pg;
  const email = str(flags.email);
  if (email) answers.email = email;
  const listen = str(flags.listen);
  if (listen) answers.listen = listen;
  const dataDir = str(globals['data-dir']);
  if (dataDir) answers.dataDir = dataDir;

  const yaml = renderInitYaml(answers, new Date(ctx.now()).toISOString().slice(0, 10));
  // A connection URL may contain a password: keep the file private then.
  writeFileSync(out, yaml, { mode: answers.postgresUrl ? 0o600 : 0o644 });
  line(io, `${p.green('✓')} Wrote ${out}`);
  line(
    io,
    `  Next: ${p.bold('beamhop doctor')} to check the setup, then ${p.bold('beamhop serve')}.`,
  );
  return EXIT.ok;
}
