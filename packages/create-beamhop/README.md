# create-beamhop

Set up Beamhop with one command.

```bash
npm create beamhop@latest -- --cf     # Cloudflare: no server, nothing to maintain
bun create beamhop --cf               # same, with Bun
npx create-beamhop                    # without --cf: prints the one-line install for a server or Docker
```

## What `--cf` does

It asks three questions (relay name, your own domain or a free `workers.dev` address, and your
npub as the relay owner, which is optional) and then:

1. checks that `wrangler` works (a global install, otherwise `npx wrangler`) and that you are
   signed in to Cloudflare (runs `wrangler login` if not);
2. writes a small project folder (`package.json`, `beamhop.config.json`, `.gitignore`) and runs
   `npm install` to fetch the Worker bundle;
3. creates the D1 database and the R2 bucket, or reuses them if they already exist;
4. writes `wrangler.toml` with the real database id and bucket name;
5. sets up the database tables (`wrangler d1 migrations apply --remote`);
6. deploys (`wrangler deploy`) and saves the `IP_HASH_SALT` secret if it is missing;
7. prepares the one-time claim code and prints the admin link.

Open the admin link, sign in with your Nostr app or a passkey, and enter the claim code to become
the owner. Running the command again is safe: everything that exists is reused, your edits to
`beamhop.config.json` are kept, and the same claim code is shown until someone uses it.

| Option | Meaning |
|---|---|
| `--dry-run` | Print every command and file, run and write nothing |
| `-y, --yes` | Do not ask; use the flags below or defaults |
| `--name`, `--domain`, `--owner` | Answers to the three questions (`--domain workers.dev` for the free address) |
| `--dir` | Project folder (default: the relay name) |
| `--runtime` | Worker bundle to install (see below) |

Example for scripts: `npm create beamhop@latest -- --cf -y --name "Club Relay" --domain relay.example.com --owner npub1…`

## Where the Worker bundle comes from

The generated project depends on **`@beamhop/runtime-cf`** from npm (default
`@beamhop/runtime-cf@latest`). This assumes the release process publishes it (and its
`@beamhop/*` dependencies) with:

- the `beamhop-cf-build` command compiled to JavaScript, so `wrangler deploy` can run the build
  step with plain Node (today the command is a TypeScript file run by Bun);
- `@beamhop/storage-sql` shipping `migrations/sqlite/`, which `wrangler.toml` points to as
  `migrations_dir`.

Until that package is published, point `--runtime` at a release tarball or a local checkout:

```bash
npm create beamhop@latest -- --cf --runtime https://github.com/beamhop/beamhop/releases/download/v0.1.0/beamhop-runtime-cf.tgz
npm create beamhop@latest -- --cf --runtime file:../beamhop/packages/runtime-cf
```

## Notes

- The claim code is written straight into D1 because a Worker has no console to print it.
- Nothing is sent anywhere except to Cloudflare through `wrangler`. No telemetry.
- Development: `bun test packages/create-beamhop`. `bun run build` writes `dist/cli.js`
  (Node 18+), which is what the published `create-beamhop` command runs.
