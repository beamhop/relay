# ADR-0005 — Packaging: Nix flake, Dockerfile, docker-compose

- **Status:** Accepted
- **Date:** 2026-06-20
- **Context source:** Grill session 2026-06-20

## Context

The relay needs a reproducible dev environment, a container image for the cluster, and an easy
local way to exercise the production (Postgres) path. It must keep the zero-dependency
standalone story (ADR-0001) for anyone who just wants to run it.

## Decision

**Nix flake dev shell** (project convention, reference impl: inner-compass):

- `flake.nix` + `.envrc` (`use flake`) + committed `flake.lock`, all shipped together.
- Tooling exposed via a dev shell and `bin/` scripts on PATH, prefixed with the project name
  (e.g. `relay-dev`, `relay-test`). Simple commands stay as `package.json` scripts; `bin/` is
  only for genuinely complex shell.
- Flake shell hooks use srid/flake-root's `$FLAKE_ROOT`, never `$PWD`; no side effects on shell
  entry.

**Dockerfile** — `oven/bun` multi-stage, mirroring the music-manager tenant:

- Copy manifests first (`package.json`, `bun.lock`), `bun install --frozen-lockfile`, then
  source; run the entrypoint directly.
- `linux/amd64` only (matches the Hetzner amd64 node).
- Keep `BUN_VERSION` synced with the local `bun.lock`.
- A `bun build --compile` single-binary image was considered and **deferred**: the bun image
  is simpler and consistent with the other tenants; revisit if a standalone binary is wanted.

**docker-compose** — local testing of the production path:

- A `postgres` service plus the relay wired to it, so the SQL-native backend can be exercised
  locally.
- Compose profiles so the relay can also run standalone (in-memory, no Postgres) with one
  command. Default invocation stays dependency-free.

## Consequences

- ✅ Reproducible dev shell; consistent tooling ergonomics with other repos.
- ✅ Image build matches the existing tenant pipeline (ADR-0006), so CI/CD is a known quantity.
- ✅ Contributors can spin up Postgres mode locally without touching the cluster.
- ⚠️ Two run paths to keep working (standalone vs compose-with-Postgres); both must be covered
  in the README and smoke-tested.
- ➡️ Single-binary distribution remains an open option, not a commitment.
