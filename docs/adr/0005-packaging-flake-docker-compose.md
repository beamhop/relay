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

**Dockerfile** — single-executable multi-stage image:

- Build with `oven/bun`: copy manifests first, `bun install --frozen-lockfile`, copy source,
  run `bun run typecheck`, then `bun build --compile` for a musl Linux target.
- Final runtime is `scratch`: copy only the compiled `/beamhop-relay` executable, the musl loader,
  `libgcc`, `libstdc++`, and the CA bundle from Alpine. No Bun runtime, no `node_modules`, no
  TypeScript source.
- CI builds `linux/amd64` only (matches the Hetzner amd64 node). The Dockerfile also maps
  `TARGETARCH=arm64` to Bun's arm64 musl target for local Docker builds.
- Keep `BUN_VERSION` synced with the local `bun.lock`.

**docker-compose** — local testing of the production path:

- A `postgres` service plus the relay wired to it, so the SQL-native backend can be exercised
  locally.
- Compose profiles so the relay can also run standalone (in-memory, no Postgres) with one
  command. Default invocation stays dependency-free.

## Consequences

- ✅ Reproducible dev shell; consistent tooling ergonomics with other repos.
- ✅ Image build still matches the existing tenant pipeline (ADR-0006), but ships a much smaller
  runtime image.
- ✅ Contributors can spin up Postgres mode locally without touching the cluster.
- ✅ The production image has one application executable and no package-manager runtime surface.
- ⚠️ Two run paths to keep working (standalone vs compose-with-Postgres); both must be covered
  in the README and smoke-tested.
