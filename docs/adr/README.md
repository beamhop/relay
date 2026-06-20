# Architecture Decision Records

Load-bearing decisions for the beamhop relay. Each ADR is immutable once Accepted;
supersede with a new one rather than editing.

These came out of the 2026-06-20 grill on adding persistence, packaging, and a path to HA
while keeping the zero-dependency standalone experience.

- [0001 — Two operating modes: standalone and production](0001-two-operating-modes-standalone-and-production.md)
- [0002 — Postgres backend is SQL-native, not a memory mirror](0002-postgres-sql-native-source-of-truth.md)
- [0003 — Broadcaster seam for HA; Postgres is enough, Redis deferred](0003-broadcaster-seam-for-ha.md)
- [0004 — YAML config, auto-discovery, and zero-config startup](0004-yaml-config-and-zero-config-startup.md)
- [0005 — Packaging: Nix flake, Dockerfile, docker-compose](0005-packaging-flake-docker-compose.md)
- [0006 — Deploy via the platform tenant pattern; slim platform split](0006-kubernetes-tenant-pattern-deployment.md)

See also [`../GLOSSARY.md`](../GLOSSARY.md) for terms, and [`../HUMAN-TODO.md`](../HUMAN-TODO.md)
for blockers only a human can clear.
