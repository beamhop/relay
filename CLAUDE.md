# CLAUDE.md — beamhop relay

A Nostr relay in TypeScript for Bun, with pluggable NIP support. `relay.beamhop.com`.

## Start here

Before building, read in this order:

1. `docs/adr/README.md` — the load-bearing decisions (ADR-0001..0006). These are accepted; do
   not relitigate, supersede with a new ADR if something must change.
2. `docs/PLAN.md` — the Phase 1 build plan and task order.
3. `docs/HUMAN-TODO.md` — the (small) human-only items.
4. `docs/GLOSSARY.md` — terms.

Current state (2026-06-20): decisions locked via a grill; **nothing implemented yet**. The
next work is Phase 1 per `docs/PLAN.md`.

## The one invariant

There are two **operating modes** (ADR-0001). **Never break standalone**: with no config and
no dependencies, `bun run start` must bring the relay up in-memory. Postgres/production is
strictly additive and its dependency must never load on the standalone path.

## Architecture in one breath

- `src/storage/` holds the `EventStore` interface and its backends. `memory` + `sqlite` are
  **memory-first** (kept as-is). The new `postgres` backend is **SQL-native** (ADR-0002).
- Backend is chosen by config `storage.backend: memory | sqlite | postgres`.
- Live fan-out is in-process today; HA goes behind a `Broadcaster` seam later (ADR-0003).
- `src/server.ts` is the WebSocket + HTTP relay; `src/config.ts` is config loading;
  `src/plugins/` are the NIP plugins.

## Conventions

- **Bun + TypeScript.** Verify with `bun run typecheck` and `bun test`.
- **Commit straight to `main`, push directly. Never branch or open a PR** for this repo.
- Tooling via a Nix flake dev shell + `bin/` scripts prefixed `relay-*` (ADR-0005); simple
  commands stay `package.json` scripts. Ship `.envrc` (`use flake`) + committed `flake.lock`.
- One committed active config, no `.example` twin. Secret values never committed.
- No em dashes in prose.
- Deploy is tenant-pattern (ADR-0006): k8s manifests live in this repo under `gitops/apps/`;
  platform-gitops carries only thin `projects/` + `tenants/` entries. Do not run cluster
  deploys/SHA-pins unless asked.
