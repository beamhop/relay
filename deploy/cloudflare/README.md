# Beamhop on Cloudflare

Runs Beamhop as one Worker plus Durable Objects (WebSockets), D1 (data) and R2 (files).
No server, no certificates to manage (Cloudflare serves HTTPS), and high availability comes
with the platform. Quickest route: the **Deploy to Cloudflare** button in the main
[README](../../README.md), which creates the D1 database and R2 bucket for you.

## One command

```bash
npm create beamhop@latest -- --cf
```

It asks three things (relay name, your own domain or a free `workers.dev` address, your npub as
owner, which is optional), signs you in to Cloudflare if needed, creates the D1 database and R2
bucket, writes `wrangler.toml` with the real ids, sets up the database tables, deploys, sets the
`IP_HASH_SALT` secret and prints the admin link with a one-time claim code. Open the link, sign
in, enter the code: you are the owner.

Running it again is safe (existing database, bucket and secrets are reused). `--dry-run` shows
every command without running it; `-y --name … --domain … --owner …` runs it without questions.
Details and the Worker bundle assumption: [packages/create-beamhop](../../packages/create-beamhop/README.md).

## Deploy by hand

```bash
bun install                                   # at the repo root
cd deploy/cloudflare
wrangler d1 create beamhop                    # copy the id into wrangler.toml → database_id
wrangler r2 bucket create beamhop-blobs
wrangler secret put IP_HASH_SALT              # any long random string
# edit beamhop.config.json: your relay id + hostnames
wrangler deploy                               # runs the build step, then uploads
```

Check the bundle locally without an account: `wrangler deploy --dry-run --outdir dist`.

The `[build]` step (`packages/runtime-cf/src/bundle/cli.ts`) writes `build/entry.ts`: a static
import map of the built-in packages and every plugin enabled in `beamhop.config.json`.
Workers cannot load code at runtime, so enabling a new plugin means `bun add beamhop-plugin-<id>`
(or a scoped id such as `@acme/spam-pack`) and redeploying. A plugin disabled via `BEAMHOP_CONFIG`
is skipped when isolates start; it leaves the bundle on the next deploy.

## Secrets

Never put secrets in `wrangler.toml` or `beamhop.config.json` (that file is inlined into the bundle).

| Secret | Purpose |
|---|---|
| `IP_HASH_SALT` | Key for privacy-preserving IP hashes. Without it each isolate uses a random salt. |
| `BEAMHOP_CONFIG` | Optional full config as JSON. Wins over the bundled file; use it when your config holds tokens (alert webhooks, AI keys). |

Set with `wrangler secret put <NAME>`; for local `wrangler dev` put them in `.dev.vars` (git-ignored).

## How it is wired

- **Routing:** the Worker picks the virtual relay from the `Host` header (+ optional path prefix).
  WebSocket upgrades go to a Durable Object; all other HTTP is served by the shared Hono app.
- **Sharding:** each relay is served by `RELAY_SHARDS` Durable Objects named `<relay>#0…N-1`;
  a new connection lands on a random shard. Messages published on one shard are forwarded once
  to the relay's other shards (channels that name no relay go to every shard). One shard handles
  thousands of sockets; raise `RELAY_SHARDS` only for very busy relays, and change it during a
  quiet period (existing sockets stay on their shard; fan-out uses the new count immediately).
- **Hibernation:** idle sockets do not keep the object in memory. Subscriptions and sign-in state
  are saved with each socket and restored on wake-up.
- **Jobs:** a one-minute Cron Trigger runs maintenance jobs; sub-minute housekeeping runs on
  Durable Object alarms only while a room has open sockets.
- **Storage fallback:** if `DB`/`BLOBS` are missing the server still starts on temporary memory
  storage and logs a warning (handy for `wrangler dev`, never for production).
- **CPU limits:** event queries run in chunks with a time budget (`QUERY_BUDGET_MS`) and stop
  early with partial results instead of being killed.
- **Media:** uncomment `[images]` to resize and make thumbnails with Cloudflare Images. Other
  media processing (metadata stripping, video) is not available on Workers.
