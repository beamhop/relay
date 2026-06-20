# ADR-0003 — Broadcaster seam for HA; Postgres is enough, Redis deferred

- **Status:** Accepted
- **Date:** 2026-06-20
- **Context source:** Grill session 2026-06-20

## Context

Live subscription fan-out is currently in-process: `broadcastEvent` (`src/server.ts`) walks a
local `connections` Map and a module-level `activeSockets` Map. With one process this is fine.
With multiple instances, a client subscribed on pod B must receive an event published to pod A,
which requires a cross-instance announcement bus.

That live channel is **best-effort and ephemeral**: a missed announcement only means a missed
*live push*; the event is already durable in Postgres (ADR-0002) and the client gets it on its
next `REQ`. So we need at-most-once, fire-and-forget delivery, not persistence or replay.

Options for the bus:

- **Postgres `LISTEN`/`NOTIFY`** — no new infra; reuses the DB. Payload cap is 8000 bytes, so
  we notify the event id and each pod re-fetches. One serialized notify queue is the throughput
  ceiling. Breaks under a transaction-mode connection pooler (needs a direct connection).
- **Redis/Valkey pub/sub** — full-payload fan-out, higher throughput, keeps traffic off the DB,
  and can double as a read cache. Costs one more stateful service.

The relay's weak delivery requirement means **Postgres alone is sufficient** for fan-out; Redis
only earns its place at higher write rates, when full-payload fan-out without DB re-reads is
wanted, behind a transaction pooler, or if we adopt a read cache.

## Decision

Introduce a thin `Broadcaster` seam (one method: announce an accepted event; pods subscribe to
announcements). The current in-process fan-out becomes the default `Broadcaster` implementation.

- **Now (Phase 1, single pod):** in-process broadcaster. No bus, no Redis.
- **HA (later phase, multi-pod):** swap to a Postgres `NOTIFY` broadcaster first (no new infra).
  Move to Redis pub/sub only if/when we hit the `NOTIFY` ceiling.

The previously deployed in-namespace Redis (nostream's cache) is **dropped** for Phase 1 and
reintroduced as the pub/sub bus if the HA phase chooses Redis.

This is the only HA-shaped change made now. Multi-pod operation, shared moderation/IP-block
state, and shared admin stats are explicitly out of scope until the HA phase.

## Consequences

- ✅ HA fan-out is a single-class swap, decided later, not an architecture rewrite.
- ✅ No new infrastructure required to reach HA (Postgres `NOTIFY` path).
- ✅ Fewer moving parts in Phase 1 (Redis removed).
- ⚠️ Phase 1 remains single-pod with a `Recreate` rollout strategy: two concurrent in-process
  broadcasters would split-brain live subscriptions.
- ⚠️ Moderation state, rate limits, and admin live-peer counts are per-pod until the HA phase
  gives them a shared home.
