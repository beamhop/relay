# Command line (`beamhop`)

The `beamhop` binary starts the server and manages it. Run `beamhop help` for the short version.

```bash
beamhop                  # start the server (same as `beamhop serve`)
beamhop <command> --help
```

## Where commands go

- `--url <url>` (or a saved login from `beamhop login`) manages a **remote** server through its API.
- Otherwise the **local** data folder is used directly, only while the server is stopped. If the server is running you will be told to log in instead.
- `--local` forces the local data folder even when logged in.

## Built-in commands

| Command | What it does |
|---|---|
| `serve [--config f] [--data-dir d] [--listen addr] [--safe]` | Start the server. Running `beamhop` with no command, or with only these flags, does the same. |
| `init` | Create `beamhop.yaml` by answering three questions. |
| `doctor [--fix]` | Check settings, disk, database, storage, DNS, certificate, ports, proxy, WebSocket and clock. |
| `claim-code` | Show the one-time code that makes you the owner. |
| `login <url>` | Sign in and save an API token on this computer. |
| `logout [url]` | Forget a saved login. |
| `status` | Health score and what needs attention. |
| `config <export\|import\|diff\|history\|restore>` | Work with settings. |
| `backup <now\|list\|restore>` | Back up and restore. |
| `update [--check]` | Install the latest release, keeping the previous one. |
| `rollback` | Go back to the previous version. |
| `move <export\|import\|verify>` | Move this relay to another server. |
| `undo <token>` | Undo a recent change. |
| `actions` | List every command your server offers. |
| `completion <bash\|zsh\|fish>` | Print a shell completion script. |
| `version` | Print the version. |

### `init`

```bash
beamhop init --domain relay.example.com --persona private-team --storage sqlite
```

Options: `--domain`, `--persona` (`public-social`, `private-team`, `wot-community`, `media-host`, `organization`), `--storage` (`sqlite`, `postgres`, `memory`), `--postgres-url`, `--email`, `--listen` (default `0.0.0.0:3334`), `-o/--output` (default `./beamhop.yaml`), `--force`. Without a terminal, missing answers use defaults.

### `login`

```bash
beamhop login https://relay.example.com --claim-code ABCD-EFGH-JKLM-NPQR
beamhop login https://relay.example.com --invite-code <code>
beamhop login https://relay.example.com --bunker 'bunker://…'
```

Options: `--bunker` (or `$BEAMHOP_BUNKER`), `--nsec-stdin` (or `$BEAMHOP_NSEC`), `--claim-code`, `--invite-code`, `--name`, `--days` (default 90), `--print-token` (print instead of saving, for automation). Secrets are never saved; only the API token is (mode 0600). For scripts, set `$BEAMHOP_TOKEN` or pass `--token`.

### `config`

```bash
beamhop config export -o beamhop.yaml     # --revision N for an older one
beamhop config diff beamhop.yaml          # or a revision number
beamhop config import beamhop.yaml        # previews, then applies
beamhop config history --limit 20
beamhop config restore 12
```

### `backup`

```bash
beamhop backup now [--to file] [--no-keys]
beamhop backup list
beamhop backup restore <file>             # the server must be stopped
```

### `move`

```bash
# old server
beamhop move export --to relay.tar.gz     # or s3://bucket/key, --no-blobs to skip media
# new server
beamhop move import relay.tar.gz
beamhop move verify relay.tar.gz
```

The file holds settings, database, media and keys: keep it private. S3 uses `$AWS_ACCESS_KEY_ID`, `$AWS_SECRET_ACCESS_KEY` and `$AWS_REGION`.

## Everything the admin app can do

Every admin action is also a command: `beamhop <group> <command>`.

```bash
beamhop actions                           # list everything on your server
beamhop admins invite --help              # details for one command
beamhop access add-allowlist --pubkeys <hex> --yes
beamhop access add-allowlist --from-file members.jsonl
```

The full list of groups and commands is in the [Actions reference](actions.md); each entry shows its CLI form. Field names become flags (kebab-case).

Action flags:

- `--input <json>`: pass the whole input as JSON (individual flags override fields).
- `--from-file <file>`: run for many items, from a JSON array or one JSON object per line (`-` for stdin).

## Global options

| Option | Meaning |
|---|---|
| `-h, --help` | Show help. |
| `--json` | Machine-readable output. |
| `-y, --yes` | Apply without asking. |
| `--preview` | Only show what would change. |
| `--technical` | Show technical details too. |
| `--url <url>` | Manage a remote server. |
| `--token <token>` | API token (default `$BEAMHOP_TOKEN` or saved login). |
| `--data-dir <dir>` | Local data directory (default from `beamhop.yaml`, else `./data`). |
| `-c, --config <file>` | Settings file (default `./beamhop.yaml`). |
| `--local` | Use the local data dir even if logged in. |
| `--relay <id>` | Which relay, for relay actions (default: the only one). |
| `--audit-reason <text>` | Why you are doing this; kept in the audit log. |
| `--no-color` | Plain output. |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 1 | Error (for `doctor`: problems found) |
| 2 | Wrong usage |
| 3 | Previewed but not applied |
| 4 | `doctor` warnings |
