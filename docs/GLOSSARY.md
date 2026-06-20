# Glossary

Terms used across the relay's design docs and ADRs.

### Operating mode
One of the two postures the relay runs in (ADR-0001). **Standalone** = zero-dependency,
in-memory or SQLite, single process. **Production** = Postgres-backed, durable, HA-capable.

### Standalone mode
Default operating mode. No external dependencies; storage is `memory` or `bun:sqlite`. The
`just run it` experience. See ADR-0001.

### Production mode
Operating mode backed by Postgres as the source of truth (ADR-0002), with a path to
multi-instance HA (ADR-0003). Pulls in a production-only Postgres driver dependency.

### EventStore
The storage interface every backend implements (`src/storage/types.ts`): save, query, count,
delete, tombstones, vanish requests, etc. Keeps server logic backend-agnostic.

### Memory-first / memory-mirror
The current `memory` and `sqlite` design: all events live in RAM; the store serves queries
from RAM and (for SQLite) writes a full snapshot to disk on every change. Simple, but O(n) per
write and incompatible with multi-instance. See ADR-0002.

### SQL-native
The Postgres backend's design (ADR-0002): reads are indexed SQL queries and writes are
incremental upserts, with Postgres as the single source of truth. No RAM mirror, no snapshot
dumps. The opposite of memory-mirror.

### Broadcaster
The seam that announces an accepted event to all instances so each can fan it out to its own
subscribers (ADR-0003). In-process today; swappable to Postgres `NOTIFY` or Redis pub/sub for
HA.

### Fan-out (live fan-out)
Pushing a newly accepted event to currently-subscribed clients whose filters match. In-process
today (`broadcastEvent`); cross-instance fan-out needs a Broadcaster bus.

### LISTEN / NOTIFY
Postgres's built-in pub/sub. A candidate HA Broadcaster that needs no new infrastructure;
8000-byte payload cap means we notify the event id and re-fetch. See ADR-0003.

### HA (high availability)
Running multiple relay instances behind one endpoint. Requires a shared store (ADR-0002) and a
cross-instance Broadcaster (ADR-0003), plus shared moderation/admin state. A later phase, not
Phase 1.

### Phase 1
The first production cutover: SQL-native Postgres, single pod, `Recreate`, no Redis, deployed
via the tenant pattern, replacing nostream at `relay.beamhop.com`. See ADR-0006.

### Tenant pattern
Platform deployment model where an app owns its k8s manifests in its own repo under
`gitops/apps/`, and platform-gitops carries only a thin AppProject + root Application pointing
at it (platform-gitops ADR-0001, the "thin waist"). See ADR-0006.

### Slim platform (split)
This relay's tenant variant: app workload lives in `beamhop/relay`, but the cross-namespace
shared bits (CNPG `Database` CR, secrets) stay platform-managed in platform-gitops. See ADR-0006.

### Shared CNPG / db-per-prototype
One platform-owned CloudNativePG Postgres cluster (`shared-pg`) with one database + role per
app (platform-gitops ADR-0002). The relay uses database `relay` in `cnpg-system`.

### nostream
The previous relay implementation running at `relay.beamhop.com`, being replaced by this repo.
Node-based; Redis was cache-only and fan-out was in-process Node cluster IPC (no cross-pod bus).
