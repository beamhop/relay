// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * `beamhop login <url>`: sign in with Nostr (NIP-98 signed by a NIP-46 bunker
 * or an nsec from stdin/env), then create a scoped, expiring API token and
 * save it (0600). The session used for sign-in is closed right after.
 */
import { hostname } from 'node:os';
import { type FlagSpec, type FlagValues, bool, flagHelp, parseFlags, str } from '../args.ts';
import {
  type AdminClient,
  NODE,
  apiError,
  expectOk,
  normalizeServerUrl,
  remoteClient,
} from '../client.ts';
import type { CliContext } from '../context.ts';
import { credentialsPath, forgetServer, readCredentials, saveServer } from '../credentials.ts';
import { json, when } from '../format.ts';
import { CliError, EXIT, UsageError, line, paint } from '../io.ts';
import { type Signer, bunkerSigner, nip98Header, nsecSigner } from '../nostr.ts';

const FLAGS: FlagSpec[] = [
  {
    name: 'bunker',
    type: 'string',
    placeholder: '<bunker://…>',
    description: 'Sign with a NIP-46 bunker (or $BEAMHOP_BUNKER)',
  },
  {
    name: 'nsec-stdin',
    type: 'boolean',
    description: 'Read the secret key from stdin (or set $BEAMHOP_NSEC)',
  },
  {
    name: 'claim-code',
    type: 'string',
    placeholder: '<code>',
    description: 'Become the owner of a new server',
  },
  {
    name: 'invite-code',
    type: 'string',
    placeholder: '<code>',
    description: 'Join the team with an invite',
  },
  {
    name: 'name',
    type: 'string',
    placeholder: '<text>',
    description: 'Name for the saved API token',
  },
  {
    name: 'days',
    type: 'string',
    placeholder: '<n>',
    description: 'Token lifetime in days (default 90)',
  },
  {
    name: 'print-token',
    type: 'boolean',
    description: 'Print the token instead of saving it (automation)',
  },
];

export interface LoginDeps {
  /** Unauthenticated client for the server (tests inject an in-process one). */
  client?: AdminClient;
  signer?: Signer;
}

async function chooseSigner(ctx: CliContext, flags: FlagValues): Promise<Signer> {
  const { io, env } = ctx;
  const onAuth = (url: string) => io.err(`Approve the sign-in in your signer: ${url}\n`);
  const bunker = str(flags.bunker) ?? env.BEAMHOP_BUNKER;
  if (bunker) return bunkerSigner(bunker, onAuth);
  if (bool(flags['nsec-stdin'])) return nsecSigner((await io.readStdin()).trim());
  if (env.BEAMHOP_NSEC) return nsecSigner(env.BEAMHOP_NSEC);
  if (!io.interactive)
    throw new UsageError(
      'No signer given. Use --bunker <bunker://…>, --nsec-stdin, or set BEAMHOP_NSEC.',
    );
  const secret = (await io.promptSecret('Paste a bunker:// address or your nsec (hidden)')).trim();
  if (!secret) throw new UsageError('Nothing was entered.');
  return secret.startsWith('bunker://') ? bunkerSigner(secret, onAuth) : nsecSigner(secret);
}

export async function loginCommand(
  ctx: CliContext,
  argv: string[],
  globals: FlagValues,
  deps: LoginDeps = {},
): Promise<number> {
  const { io } = ctx;
  const p = paint(io);
  const { flags, positionals } = parseFlags(argv, FLAGS);
  if (bool(globals.help)) {
    io.out(
      `Sign in to a Beamhop server and save an API token for this computer.\n\nUsage: beamhop login <url> [options]\n\n${flagHelp(FLAGS)}\n\nSecrets are never shown or saved; only the API token is stored (mode 0600).\n`,
    );
    return EXIT.ok;
  }
  const rawUrl = positionals[0] ?? str(globals.url) ?? ctx.env.BEAMHOP_URL;
  if (!rawUrl) throw new UsageError('Usage: beamhop login <url>');
  const url = normalizeServerUrl(rawUrl);
  const days = Number(str(flags.days) ?? 90);
  if (!Number.isInteger(days) || days < 1)
    throw new UsageError('--days must be a whole number of days');

  const client = deps.client ?? remoteClient(url, undefined, ctx.fetch);
  const signer = deps.signer ?? (await chooseSigner(ctx, flags));
  try {
    const codes: Record<string, string> = {};
    const claim = str(flags['claim-code']);
    const invite = str(flags['invite-code']);
    if (claim) codes.claimCode = claim;
    if (invite) codes.inviteCode = invite;
    const body = Object.keys(codes).length ? codes : undefined;
    const path = `${NODE}/auth/nostr`;
    const auth = await nip98Header(
      signer,
      client.urlFor(path),
      'POST',
      body ? JSON.stringify(body) : undefined,
      Math.floor(ctx.now() / 1000),
    );
    const signIn = await client.request('POST', path, body, {
      headers: {
        authorization: auth,
        'x-nostr-signer': signer.kind === 'nip46' ? 'nip46' : 'nip07',
      },
    });
    if (signIn.status !== 200) throw apiError(signIn, 'Sign-in failed');
    const session = signIn.json.token as string;
    const asSession = { headers: { authorization: `Bearer ${session}` } };
    const name = str(flags.name) ?? `beamhop CLI on ${hostname()}`;
    let created: { token: string; id: string; expiresAt: number };
    try {
      const res = await expectOk(
        client.request(
          'POST',
          `${NODE}/actions/tokens.create`,
          { input: { name, expiresInDays: days } },
          asSession,
        ),
      );
      created = res.json.output;
    } finally {
      await client.request('POST', `${NODE}/auth/logout`, undefined, asSession).catch(() => {});
    }
    const pubkey = await signer.getPublicKey();
    const recovery = signIn.json.recoveryCodes as string[] | undefined;

    if (bool(flags['print-token'])) {
      // Explicitly requested: the token goes to stdout only, nothing is saved.
      io.out(`${created.token}\n`);
    } else {
      const path = credentialsPath(ctx.env, ctx.home);
      saveServer(path, url, {
        token: created.token,
        tokenId: created.id,
        pubkey,
        savedAt: new Date(ctx.now()).toISOString(),
        expiresAt: created.expiresAt,
      });
      if (bool(globals.json))
        json(io, {
          url,
          saved: path,
          tokenId: created.id,
          expiresAt: created.expiresAt,
          recoveryCodes: recovery,
        });
      else {
        line(
          io,
          `${p.green('✓')} Signed in to ${url} as ${signIn.json.principal?.displayName ?? pubkey.slice(0, 12)}`,
        );
        line(io, `  API token “${name}” saved to ${path} (expires ${when(created.expiresAt)}).`);
      }
    }
    if (recovery?.length && !bool(globals.json)) {
      io.err(
        `\n${p.bold('You are now the owner.')} Save these recovery codes somewhere safe — each works once if you lose your key:\n`,
      );
      for (const c of recovery) io.err(`  ${c}\n`);
    }
    return EXIT.ok;
  } finally {
    await signer.close?.().catch(() => {});
  }
}

export async function logoutCommand(
  ctx: CliContext,
  argv: string[],
  globals: FlagValues,
): Promise<number> {
  const { positionals } = parseFlags(argv, []);
  const path = credentialsPath(ctx.env, ctx.home);
  const creds = readCredentials(path);
  const url = positionals[0]
    ? normalizeServerUrl(positionals[0])
    : str(globals.url)
      ? normalizeServerUrl(str(globals.url)!)
      : creds.default;
  if (!url || !creds.servers[url]) throw new CliError('You are not logged in to that server.');
  const saved = creds.servers[url]!;
  // Revoke the token on the server (best effort), then forget it locally.
  if (saved.tokenId) {
    try {
      const client = remoteClient(url, saved.token, ctx.fetch);
      await client.request('POST', `${NODE}/actions/tokens.revoke`, {
        input: { id: saved.tokenId },
      });
    } catch {
      // offline: still forget locally
    }
  }
  forgetServer(path, url);
  line(ctx.io, `${paint(ctx.io).green('✓')} Logged out of ${url}`);
  return EXIT.ok;
}
