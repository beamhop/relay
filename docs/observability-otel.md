# Tracing with OpenTelemetry

Beamhop can send **traces** (how long each request took and where the time went) to an
OpenTelemetry collector you run, such as Grafana Tempo or Jaeger. It is **off by default**:
nothing is recorded and nothing is sent anywhere until you enter your collector's address.
There is no telemetry to us or to anyone else.

For numbers and graphs (connections, posts per minute, storage) you usually want the
monitoring page (`/metrics`, Prometheus) instead; see `modules.insights` in the
[settings reference](reference/config.md). Tracing helps when you need to see *one slow
request* rather than averages.

## Turn it on

```yaml
# beamhop.yaml
modules:
  otel:
    endpoint: http://tempo.internal:4318      # your collector (OTLP over HTTP)
    sampleRatio: 0.1                           # trace one in ten requests
    serviceName: beamhop                       # how this server is named in your tool
    secretHeaders:                             # optional: login for a hosted collector
      authorization: Bearer <token>
```

Restart once after setting `endpoint` for the first time (on the Bun binary the feature is
loaded at start-up; on Cloudflare redeploy with `@beamhop/otel` installed). After that,
changes to the sample ratio, headers or address apply immediately. Remove `endpoint` (or the
whole `otel` section) to turn tracing off.

| Setting | What it does |
|---|---|
| `endpoint` | Collector base address. Traces go to `{endpoint}/v1/traces`. Empty = off. |
| `sampleRatio` | Share of activity traced, 0 to 1 (default 0.1). A request that arrives with a W3C `traceparent` header follows the caller's decision instead. |
| `serviceName` | `service.name` of the traces (default `beamhop`). `service.instance.id` is the node id. |
| `headers` | Extra non-secret headers, e.g. `x-scope-orgid` for a multi-tenant Tempo. |
| `secretHeaders` | Headers with tokens. Hidden in the admin app, audit log and config history. |
| `metrics.enabled` | Also send the `/metrics` numbers to `{endpoint}/v1/metrics` every `metrics.intervalSeconds` (default 60). Needs the insights module. Do not also set `modules.insights.otlp` to the same collector, or you get every number twice. |

The admin action **Tracing export status** (`beamhop otel status`) shows how many traces
were sent, how many were dropped and the last problem talking to the collector.

## What is traced

| Span | When | Attributes |
|---|---|---|
| `GET /route/:pattern` (server) | every HTTP request through the server (admin API, portal, Blossom, NIP-11, …) | `http.request.method`, `http.route` (the route **pattern**, never the URL or query), `http.response.status_code`, `url.scheme`, `beamhop.relay.id`, `beamhop.blossom.op` (`get`, `upload`, `mirror`, `delete`), `error.type` |
| `relay.event` | a post or other event was accepted, refused, hidden or held | `nostr.event.kind`, `beamhop.event.outcome` (`accepted`, `rejected`, `hidden`, `held`), `beamhop.event.reason` (the reason prefix only, e.g. `blocked`, `rate-limited`), `beamhop.policy.by` (which rule decided), `beamhop.relay.id` |
| `relay.req` | a subscription (REQ) was answered | `beamhop.req.filters`, `beamhop.req.results`, `beamhop.relay.id` |
| `blossom.upload` | a file was stored | `beamhop.blob.size`, `beamhop.blob.type`, `beamhop.relay.id` |
| `admin.action` | an admin action ran | `beamhop.admin.action` (action id), `beamhop.admin.ok`, `beamhop.admin.principal_hash` |

Incoming `traceparent` headers (W3C Trace Context) are honoured, so a request from your own
app or proxy shows up inside that app's trace. Relay spans (`relay.event`, `relay.req`) start
their own traces because WebSocket messages carry no trace headers; their duration is the
handling time the relay measured.

**Never in a trace:** IP addresses (raw or hashed), public keys of people using the relay,
post content, file hashes, full URLs or query strings, tokens or request headers. Free-text
refusal messages are cut down to their reason prefix. The admin who ran an action appears
only as a short one-way hash. Only the attributes listed above are allowed; anything else is
dropped before export.

## How it sends

Spans are sent as OTLP/HTTP **JSON** with plain `fetch` (no OpenTelemetry SDK), so it works the
same on the Bun binary and on Cloudflare Workers.

- **Batching:** up to 512 spans per request, every 5 seconds or as soon as a batch is full.
  On Workers each traced request sends its spans in the background after the response
  (`waitUntil`), because an idle Worker may be frozen.
- **Retries:** network errors, `408`, `429` and `5xx` are retried up to 4 times with
  exponential backoff and jitter (respecting `Retry-After`); other answers drop the batch.
- **Bounded memory:** at most 2048 spans wait in memory. When the collector is slow or down,
  new spans are dropped and counted (see the status action) instead of piling up.
- On Workers, `Date.now()` does not advance during a request, so HTTP span durations there are
  often 0 ms; relay spans use the relay's own measurement.

## Example: Grafana Tempo

```yaml
# docker-compose.yml (next to Beamhop)
services:
  tempo:
    image: grafana/tempo:2.6.1
    command: ['-config.file=/etc/tempo.yaml']
    volumes: ['./tempo.yaml:/etc/tempo.yaml']
    ports: ['3200:3200', '4318:4318']
  grafana:
    image: grafana/grafana:11.3.0
    ports: ['3000:3000']
```

```yaml
# tempo.yaml
server:
  http_listen_port: 3200
distributor:
  receivers:
    otlp:
      protocols:
        http:
          endpoint: 0.0.0.0:4318
storage:
  trace:
    backend: local
    local:
      path: /var/tempo/traces
```

```yaml
# beamhop.yaml
modules:
  otel:
    endpoint: http://tempo:4318
    sampleRatio: 0.2
```

In Grafana add a Tempo data source pointing at `http://tempo:3200`, then open **Explore** and
search for `{ resource.service.name = "beamhop" }`, or for slow uploads:
`{ span.beamhop.blossom.op = "upload" && duration > 500ms }`.

## Example: Jaeger

Jaeger accepts OTLP over HTTP directly:

```bash
docker run -d --name jaeger -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:1.62.0
```

```yaml
modules:
  otel:
    endpoint: http://localhost:4318
    sampleRatio: 1          # trace everything while you investigate, then lower it again
```

Open `http://localhost:16686` and pick the `beamhop` service.

## Hosted collectors

Most hosted tracing services accept OTLP/HTTP with a token header. Put the token in
`secretHeaders` so it is never shown again:

```yaml
modules:
  otel:
    endpoint: https://otlp.example-observability.com
    secretHeaders:
      authorization: Basic <base64 of instance-id:token>
```

Remember that tracing data leaves your server for that service; the privacy rules above
still apply to what is sent.
