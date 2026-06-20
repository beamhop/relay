# Build plan

Decisions are locked in `docs/adr/`. This is the execution order. Phase 1 is the production
cutover; HA is a later phase.

## Phase 1 — production-ready, replace nostream at relay.beamhop.com

Ordered by dependency. #1 is the critical path and highest risk.

1. **`PostgresEventStore` (SQL-native)** — ADR-0002.
   - Implement the full `EventStore` interface (`src/storage/types.ts`) against Postgres:
     save/upsert, has, get, query, count, deletes, tombstones, vanish requests, reject reasons.
   - Schema + indexes for NIP-01 filters (id, pubkey, kind, created_at, tags). Replaceable /
     addressable / ephemeral handling per the memory store's semantics.
   - NIP-50 search via Postgres full-text (`tsvector` / `pg_trgm`), replacing the SQLite FTS5
     path. NIP-45 COUNT must work.
   - Driver: Bun native SQL, so the production path can compile into the standalone binary.
   - **Reuse `tests/storage.test.ts`**: parametrize it so the same suite runs against memory,
     sqlite, and postgres (skip postgres when no DB env). This is the correctness backstop.

2. **Config** — ADR-0004.
   - YAML support + auto-discover `relay.yaml`; JSON keeps working; precedence CLI > env > file
     > defaults; zero-config boots in-memory.
   - Add `storage.backend` (`memory | sqlite | postgres`) + Postgres connection settings.
   - Wire `src/main.ts` to construct the store from config.

3. **`Broadcaster` seam** — ADR-0003 (interface only this phase).
   - Extract the in-process fan-out behind a one-method interface so HA is a later swap. No bus,
     no Redis in Phase 1.

4. **Flake + tooling** — ADR-0005: `flake.nix`, `.envrc` (`use flake`), committed `flake.lock`,
   `bin/relay-*` scripts.

5. **Dockerfile + docker-compose** — ADR-0005: Bun compile multi-stage, scratch runtime image,
   and compose with a `postgres` service + profiles so the relay also runs standalone in-memory.

6. **In-repo gitops** — ADR-0006: `gitops/apps/` (namespace, Deployment, Service, Ingress,
   Certificate, settings ConfigMap, kustomization) mirroring music-manager, plus
   `.github/workflows/image.yml` (build → push GHCR → promote short-SHA → Argo).
   - Single pod, `Recreate`. Postgres at `shared-pg-rw.cnpg-system.svc.cluster.local`, db `relay`.
   - No Redis.

7. **platform-gitops cutover** — ADR-0006 (other repo): add thin
   `projects/beamhop-relay.yaml` + `tenants/beamhop-relay.yaml`; remove `platform/relay/` +
   `apps/children/application-relay.yaml`. Keep the CNPG Database CR + secrets platform-side.
   Set `ghcr.io/beamhop/relay` package public on first publish (see `docs/HUMAN-TODO.md`).

## Already on the cluster (reused, not rebuilt)

CNPG `relay` database, `relay` namespace, ingress at `relay.beamhop.com` with WebSocket
timeouts, TLS cert. Phase 1 swaps the workload onto existing infra.

## Later — HA (out of scope for Phase 1)

Multi-pod operation; swap `Broadcaster` to Postgres `NOTIFY` first (no new infra), Redis pub/sub
only if it hits the ceiling; shared moderation/IP-block + admin state. See ADR-0003.
