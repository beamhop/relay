// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `beamhop` entry: built-in commands (serve, init, login, status, config,
 * backup, update, rollback, claim-code, doctor, move, undo, completion) plus
 * one generated command per admin action (`beamhop <group> <name>`).
 *
 * `beamhop` with no arguments — or with only server flags such as
 * `--config`/`--healthcheck` — starts the server, so the single binary keeps
 * working as the server entry (Docker HEALTHCHECK, `curl … | sh && beamhop`).
 */
import { VERSION } from '@beamhop/runtime-bun';
import { type FlagValues, bool, flagHelp, parseFlags } from './args.ts';
import { GLOBAL_FLAGS, catalogSummary, groupHelp, groups, matchAction } from './catalog.ts';
import type { AdminClient } from './client.ts';
import { fetchCatalog, runActionCommand, undoCommand } from './commands/actions.ts';
import { BACKUP_HELP, backupCommand } from './commands/backup.ts';
import { claimCodeCommand } from './commands/claim.ts';
import { completionScript } from './commands/completion.ts';
import { CONFIG_HELP, configCommand } from './commands/config.ts';
import { doctorCommand } from './commands/doctor.ts';
import { initCommand } from './commands/init.ts';
import { loginCommand, logoutCommand } from './commands/login.ts';
import { MOVE_HELP, moveCommand } from './commands/move.ts';
import { statusCommand } from './commands/status.ts';
import { rollbackCommand, updateCommand } from './commands/update.ts';
import { type CliContext, connect, defaultContext } from './context.ts';
import { CliError, EXIT, UsageError, paint } from './io.ts';

/** Flags that mean "run the server" when given without a command. */
const SERVER_FLAGS = new Set([
  '--config',
  '-c',
  '--data-dir',
  '--listen',
  '--safe',
  '--healthcheck',
]);

export const BUILTIN_COMMANDS = [
  'serve',
  'init',
  'login',
  'logout',
  'status',
  'config',
  'backup',
  'update',
  'rollback',
  'claim-code',
  'doctor',
  'move',
  'undo',
  'actions',
  'completion',
  'help',
  'version',
] as const;

export function mainHelp(): string {
  return `Beamhop ${VERSION} — Nostr relay + media server

Usage: beamhop [command] [options]

Run the server
  beamhop                     Start the server (same as \`beamhop serve\`)
  serve [server options]      Start the server (--config, --data-dir, --listen, --safe)

Set up
  init                        Create beamhop.yaml (three questions)
  doctor [--fix]              Check DNS, certificate, ports, proxy, disk, storage…
  claim-code                  Show the one-time code to become the owner
  login <url>                 Sign in to a server and save an API token
  logout [url]                Forget a saved login

Run it
  status                      Health score and what needs attention
  config <export|import|diff|history|restore>
  backup <now|list|restore>
  update [--check]            Install the latest release (keeps the previous one)
  rollback                    Go back to the previous version
  move <export|import|verify> Move this relay to another server
  undo <token>                Undo a recent change

Everything the admin app can do
  actions                     List all commands for your server
  <group> <command> --help    e.g. \`beamhop admins invite --help\`
  completion <bash|zsh|fish>  Shell completion script

Options
${flagHelp(GLOBAL_FLAGS)}

Where commands go: --url (or a saved login) manages a remote server through its
API; otherwise the local data folder is used directly while the server is stopped.

Exit codes: 0 ok · 1 error · 2 wrong usage · 3 previewed but not applied · 4 doctor warnings
`;
}

function withoutTokens(rest: string[], tokens: string[]): string[] {
  const out = [...rest];
  for (const t of tokens) {
    const i = out.indexOf(t);
    if (i !== -1) out.splice(i, 1);
  }
  return out;
}

async function defaultServe(argv: string[]): Promise<unknown> {
  const { main } = await import('@beamhop/runtime-bun');
  return main(argv);
}

export async function runCli(argv: string[], overrides: Partial<CliContext> = {}): Promise<number> {
  const ctx = defaultContext(overrides);
  const { io } = ctx;
  let client: AdminClient | null = null;
  const getClient = async (flags: FlagValues) => {
    client ??= await connect(ctx, flags);
    return client;
  };
  let technical = false;
  try {
    const first = argv[0];
    if (first === undefined || SERVER_FLAGS.has(first.split('=')[0]!)) {
      await (ctx.serve ?? defaultServe)(argv);
      return EXIT.ok;
    }
    const g = parseFlags(argv, GLOBAL_FLAGS, { allowUnknown: true });
    const flags = g.flags;
    technical = bool(flags.technical);
    if (bool(flags['no-color']) || bool(flags.json)) io.color = false;
    const [cmd, ...more] = g.positionals;
    const rest = cmd ? withoutTokens(g.rest, [cmd]) : g.rest;

    if (!cmd) {
      if (argv.includes('--version') || argv.includes('-v')) {
        io.out(`${VERSION}\n`);
        return EXIT.ok;
      }
      io.out(mainHelp());
      return bool(flags.help) ? EXIT.ok : EXIT.usage;
    }

    switch (cmd) {
      case 'help':
        io.out(mainHelp());
        return EXIT.ok;
      case 'version':
        io.out(`${VERSION}\n`);
        return EXIT.ok;
      case 'serve':
        await (ctx.serve ?? defaultServe)(argv.slice(argv.indexOf('serve') + 1));
        return EXIT.ok;
      case 'init':
        return await initCommand(ctx, rest, flags);
      case 'login':
        return await loginCommand(ctx, rest, flags);
      case 'logout':
        return await logoutCommand(ctx, rest, flags);
      case 'doctor':
        return await doctorCommand(ctx, rest, flags);
      case 'claim-code':
        return await claimCodeCommand(ctx, flags);
      case 'update':
        return await updateCommand(ctx, rest, flags);
      case 'rollback':
        return await rollbackCommand(ctx, rest, flags);
      case 'backup':
        return await backupCommand(ctx, rest, flags);
      case 'move':
        return await moveCommand(ctx, rest, flags);
      case 'status':
        if (bool(flags.help)) {
          io.out(
            'Health score and the cards that need attention.\n\nUsage: beamhop status [--relay <id>] [--technical] [--json]\n',
          );
          return EXIT.ok;
        }
        return await statusCommand(ctx, await getClient(flags), flags);
      case 'undo':
        return await undoCommand(ctx, await getClient(flags), more[0], flags);
      case 'completion': {
        const shell = more[0] ?? '';
        let catalog = null;
        try {
          catalog = await fetchCatalog(await getClient(flags));
        } catch (err) {
          io.err(
            `Note: could not load your server's commands (${(err as Error).message.split('\n')[0]}); completing built-in commands only.\n`,
          );
        }
        const script = completionScript(shell, catalog);
        if (!script) throw new UsageError('Usage: beamhop completion <bash|zsh|fish>');
        io.out(script);
        return EXIT.ok;
      }
    }

    if (
      cmd === 'config' &&
      (!more[0] || ['export', 'import', 'diff', 'history', 'restore'].includes(more[0]))
    ) {
      if (bool(flags.help) || !more[0]) {
        io.out(CONFIG_HELP);
        return EXIT.ok;
      }
      return await configCommand(ctx, await getClient(flags), rest, flags);
    }

    // Generated action commands.
    const c = await getClient(flags);
    const catalog = await fetchCatalog(c);
    if (cmd === 'actions') {
      if (bool(flags.json)) io.out(`${JSON.stringify(catalog, null, 2)}\n`);
      else
        io.out(
          `Commands for ${c.mode === 'remote' ? c.target : 'this server'}:\n\n${catalogSummary(catalog)}\n\nRun \`beamhop <group> <command> --help\` for details.\n`,
        );
      return EXIT.ok;
    }
    const match = matchAction(catalog, g.positionals);
    if (match) {
      const path = g.positionals.slice(0, match.consumed);
      return await runActionCommand(ctx, c, match.entry, withoutTokens(g.rest, path), flags);
    }
    const group = groups(catalog).get(cmd);
    if (group) {
      io.out(groupHelp(cmd, group));
      return more.length ? EXIT.usage : EXIT.ok;
    }
    throw new UsageError(`Unknown command “${cmd}”. Run \`beamhop help\` or \`beamhop actions\`.`);
  } catch (err) {
    const p = paint(io);
    if (err instanceof CliError) {
      io.err(`${p.red('✗')} ${err.message}\n`);
      if (technical && err.technical) io.err(`${p.dim(`  ${err.technical}`)}\n`);
      return err.exitCode;
    }
    io.err(`${p.red('✗')} Something went wrong: ${(err as Error)?.message ?? String(err)}\n`);
    if (technical && (err as Error)?.stack) io.err(`${(err as Error).stack}\n`);
    return EXIT.error;
  } finally {
    // `client` is assigned inside the closure; TS cannot see it here.
    await (client as AdminClient | null)?.close().catch(() => {});
  }
}

export { BACKUP_HELP, MOVE_HELP };
