# bin/

Project scripts on PATH inside the flake dev shell, prefixed `relay-*` (ADR-0005). Simple
commands stay in `package.json` (`bun run dev`, `bun test`, `bun run typecheck`); this directory
holds only genuinely complex shell.

- `relay-pg [command...]` — run a command against an ephemeral local Postgres (defaults to
  `bun test`). Spins up a throwaway cluster, exports `DATABASE_URL` / `RELAY_TEST_POSTGRES_URL`,
  and tears it down on exit. Use it to exercise the SQL-native backend and the postgres test
  path without touching the cluster:
  - `relay-pg bun test`
  - `relay-pg bun run start --storage postgres`
