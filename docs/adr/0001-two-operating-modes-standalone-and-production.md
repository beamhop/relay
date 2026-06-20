# ADR-0001 — Two operating modes: standalone (zero-dependency) and production

- **Status:** Accepted
- **Date:** 2026-06-20
- **Context source:** Grill session 2026-06-20 (Yasin + Claude)

## Context

Beamhop relay today runs one way: a single Bun process, in-memory by default, with an
optional `--persistence` flag that writes a SQLite snapshot. That is ideal for "clone it and
run it" but it is not a production posture: state lives in RAM, the SQLite path re-dumps the
whole dataset on every write (see ADR-0002), and it cannot run as more than one instance.

We want to add real persistence and a path to reliability (eventually multi-instance HA on
the platform-gitops k8s cluster) **without** sacrificing the zero-dependency, just-run-it
experience that makes the relay easy to adopt and develop against.

The trap to avoid is a single configuration spectrum where every user pays for production
concerns. Instead we frame two distinct **operating modes**.

## Decision

The relay supports two operating modes, selected by configuration, behind one
`EventStore` interface (`src/storage/types.ts`):

- **Standalone (default).** Zero external dependencies. Storage is `memory` (default) or
  `sqlite` (built-in `bun:sqlite`). Single process, in-process event fan-out. This is exactly
  today's behavior and remains the default when no config is present (`just run it`).
- **Production.** Postgres as a SQL-native source of truth (ADR-0002). Durable, scalable past
  RAM, and the foundation for multi-instance HA (ADR-0003). Pulls in a production-only driver
  dependency; the standalone path never loads it.

Storage backend is chosen with a single config key:

```yaml
storage:
  backend: memory   # | sqlite | postgres
```

- `memory` and `sqlite` keep their current memory-first behavior. We are **not** reworking
  them ("Leave them; add PG alongside").
- `postgres` is a new, separate code path.

## Consequences

- ✅ The default experience is unchanged: no dependencies, runs in-memory, optionally SQLite.
- ✅ Production concerns (durability, scale, HA) are opt-in and isolated to the Postgres path.
- ✅ One `EventStore` interface keeps the server code backend-agnostic.
- ⚠️ Two persistence philosophies coexist (memory-first snapshot vs SQL-native). This is a
  deliberate, documented split, not an inconsistency to "fix".
- ➡️ HA (multi-instance) is only meaningful in production mode; see ADR-0003.
