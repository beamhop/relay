---
title: Health and metrics endpoints
description: The /health readiness probe, the /health/live liveness probe and the Prometheus /metrics endpoint — responses, access rules and every built-in series.
sidebar:
  order: 15
---

beamhop exposes three unauthenticated-by-design HTTP endpoints for infrastructure. They stay reachable while the
server is draining and are exempt from IP block rules, so monitoring keeps working.

## `GET /health/live` — liveness

Answers `200` as long as the process answers:

```json
{ "ok": true, "status": "ready", "version": "0.1.0" }
```

Use it for container health checks (the Docker image does). It never checks the database, so a slow database
doesn't get the process restarted, and it doesn't cut a graceful shutdown short.

## `GET /health` — readiness

Point load balancers here. It answers `200` only when the server is ready and the database responds within 2 s:

```json
{ "ok": true, "status": "ready", "version": "0.1.0" }
```

Otherwise it answers `503`:

| Body | When |
| --- | --- |
| `{ "ok": false, "status": "starting" }` | Still booting. |
| `{ "ok": false, "status": "draining" }` / `"stopping"` / `"stopped"` | Shutting down. Sent with `Retry-After: 5`. |
| `{ "ok": false, "status": "ready", "error": "unavailable" }` | The database didn't answer in time (for example a PostgreSQL restart). The cause is logged, not returned. |

Both probes send `Cache-Control: no-store`.

## `GET /metrics` — Prometheus

Prometheus text format (0.0.4). On by default; set `server.prometheus` / `BEAMHOP_PROMETHEUS=false` to turn it off.

### Access

| Setup | Who may scrape |
| --- | --- |
| `BEAMHOP_METRICS_TOKEN` set | Anyone sending `Authorization: Bearer <token>`. Others get `401`. |
| No token, `server.trustProxy` off | Only loopback clients (`127.0.0.0/8`, `::1`) talking to beamhop directly, without forwarding headers. |
| No token, `server.trustProxy` on | Nobody: `403`. Behind a proxy, every client can look local, so a token is required. |

A placeholder token such as `change-me` disables the endpoint and logs an error.

```yaml title="prometheus.yml"
scrape_configs:
  - job_name: beamhop
    authorization:
      credentials: <your BEAMHOP_METRICS_TOKEN>
    static_configs:
      - targets: ["relay.example.com:3334"]
```

### Gauges

| Series | |
| --- | --- |
| `beamhop_uptime_seconds` | Seconds since the metrics service started |
| `beamhop_connections` | Open WebSocket connections |
| `beamhop_connections_authed` | NIP-42 authenticated connections |
| `beamhop_subscriptions` | Active subscriptions |
| `beamhop_events_in_per_second` | Accepted events per second (10 s window) |
| `beamhop_events_out_per_second` | Events sent to clients per second (10 s window) |
| `beamhop_req_per_second` | REQs per second (10 s window) |
| `beamhop_rejected_per_second` | Rejected events per second (10 s window) |
| `beamhop_events_stored` | Stored events |
| `beamhop_db_bytes` | Event store size in bytes |
| `beamhop_media_bytes` | Blossom storage in bytes |
| `beamhop_media_blobs` | Blossom blob count |
| `beamhop_cpu_percent` | Process CPU usage |
| `beamhop_memory_rss_bytes` | Resident set size |
| `beamhop_heap_used_bytes` | JS heap used |
| `beamhop_event_loop_lag_ms` | Event loop lag |
| `beamhop_req_latency_p50_ms`, `_p95_ms`, `_p99_ms` | REQ latency percentiles over the last minute |

### Counters

| Series | |
| --- | --- |
| `beamhop_events_in_total` | Accepted events |
| `beamhop_events_out_total` | Events sent to clients |
| `beamhop_req_total` | REQs executed |
| `beamhop_rejected_total{code="…"}` | Rejected events by code (`invalid`, `blocked`, `rate-limited`, `pow`, `auth-required`, `restricted`, `duplicate`, `error`, `policy`, `too-large`) |
| `beamhop_connections_opened_total`, `beamhop_connections_closed_total` | WebSocket connections |
| `beamhop_bytes_in_total`, `beamhop_bytes_out_total` | WebSocket bytes |
| `beamhop_blobs_uploaded_total`, `beamhop_blob_bytes_uploaded_total` | Blossom uploads |
| `beamhop_blobs_served_total`, `beamhop_blob_bytes_served_total` | Blossom downloads |
| `hook_incidents_total` | Plugin hook timeouts and errors |

### Plugin metrics

Metrics registered by plugins with `ctx.metrics.counter` / `gauge` follow the built-in ones, without a `beamhop_`
prefix: for example `hello_rejected_total` and `spam_filter_blocked_total`. See
[Jobs, events and metrics](/relay/build/plugin-jobs-metrics/#metrics).

## Beyond Prometheus

- **OpenTelemetry**: with `metrics.otel.enabled`, beamhop pushes its metrics (plugin metrics included, with their
  attributes) over OTLP/HTTP to `metrics.otel.endpoint`. See the [configuration reference](/relay/config/reference/).
- **Admin API**: `GET /admin/api/dashboard/snapshot`, `/metrics/series` and the `GET /admin/api/stream` SSE feed
  give the panel's live view to scripts. See [Admin REST API](/relay/build/admin-api/#system-and-metrics).
