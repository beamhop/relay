---
title: Jobs, events and metrics
description: Run periodic jobs, react to relay events on the bus, and publish custom metrics from a beamhop plugin.
sidebar:
  order: 8
---

## Jobs

```ts
jobs: {
  every(name: string, intervalMs: number, fn: () => Promise<void> | void): () => void;
}
```

`ctx.jobs.every` runs `fn` every `intervalMs` milliseconds and returns a function that cancels it.

```ts
const stop = ctx.jobs.every("prune", 60_000, () => {
  scorer.prune();
});
```

How jobs behave:

- The first run happens after one interval, not immediately.
- Runs never overlap: if a run is still going when the next tick comes, that tick is skipped.
- A run that throws is logged (`job <name> failed`) and the job keeps its schedule.
- Intervals below 100 ms are raised to 100 ms.
- On disable and at shutdown, scheduling stops and a run in progress is awaited (bounded) before `teardown()` runs.

To change an interval, cancel the job and start a new one. `hello` does this when its settings change:

```ts
const startJob = (s: HelloSettings) =>
  ctx.jobs.every("heartbeat", s.tickSeconds * 1000, () => ctx.logger.debug("heartbeat"));
let stopJob = startJob(ctx.settings.get());
ctx.settings.onChange((s) => {
  stopJob();
  stopJob = startJob(s);
});
```

## Bus events

`ctx.on(name, handler)` subscribes to the server's event bus. It returns an unsubscribe function, and the
subscription is removed automatically on disable. (`ctx.bus.on` is the same thing.)

```ts
ctx.on("event.accepted", ({ event, status }) => {
  if (status === "saved" && event.kind === 1) notesToday++;
});

ctx.on("blob.uploaded", ({ sha256, size, pubkey }) => {
  ctx.logger.info("new blob", { sha256, size, pubkey });
});
```

Handlers run synchronously when the event is emitted and must be cheap. Async handlers aren't awaited, but their
errors are caught and logged (at most once a minute per handler and event).

### Events you can subscribe to

| Event | Payload |
| --- | --- |
| `connection.open` | `{ connId, ip, userAgent?, at }` |
| `connection.close` | `{ connId, ip, durationMs, at }` |
| `connection.auth` | `{ connId, pubkey, ip }` — a NIP-42 authentication |
| `event.accepted` | `{ event, status: "saved" \| "replaced" \| "ephemeral", connId?, ip?, source }` |
| `event.rejected` | `{ event?, code, reason, connId?, ip?, pubkey?, source }` |
| `event.broadcast` | `{ event, recipients }` |
| `event.deleted` | `{ ids, actor, reason? }` |
| `req.executed` | `{ connId, subId, filters, results, durationMs, ip }` |
| `message.in` / `message.out` | `{ connId, type, bytes }` |
| `blob.uploaded` | `{ sha256, size, type, pubkey }` |
| `blob.deleted` | `{ sha256, actor }` |
| `blob.served` | `{ sha256, size, ip }` |
| `report.created` | `{ event }` — a NIP-56 report |
| `user.updated` | `{ pubkey, user, actor }` |
| `user.deleted` | `{ pubkey, actor }` |
| `settings.changed` | `{ settings, actor }` — runtime settings saved |
| `ip.rules.changed` | `{ actor }` |
| `admin.action` | `{ entry }` — an audit log entry |
| `alert` | `{ level, title, message, url? }` |

`code` on `event.rejected` is one of `invalid`, `blocked`, `rate-limited`, `pow`, `auth-required`, `restricted`,
`duplicate`, `error`, `policy`, `too-large`. `source` is where an event came from: `ws`, `api`, `import`, `sync`,
`relay` or `plugin`.

`message.in`, `message.out` and `event.broadcast` fire very often on a busy relay. Subscribe to them only if you
need them, and keep the handler tiny.

### Raising alerts

A plugin can't emit core events, but it can raise an admin alert:

```ts
ctx.bus.emit("alert", { level: "warning", title: "Feed import stalled", message: "No new items for 30 minutes" });
```

Alerts appear in the admin panel's live stream and can reach admins as push notifications.

## Metrics

```ts
counter(name: string, help?: string): { add(v?: number, attrs?: Record<string, string>): void };
gauge(name: string, help?: string): { set(v: number, attrs?: Record<string, string>): void };
```

```ts
const blocked = ctx.metrics.counter("spam_filter_blocked_total", "events blocked by the spam filter");
blocked.add(1, { action: "reject" });

const queue = ctx.metrics.gauge("myplugin_queue_length", "items waiting to be processed");
queue.set(pending.length);
```

Custom metrics show up in three places:

- **`/metrics`** (Prometheus). Characters outside `[a-zA-Z0-9_:]` become `_`. Counters get a `_total` suffix if they
  don't already have one. Plugin metrics are written after the built-in ones, so a name that collides with a
  built-in series is skipped.
- **The admin dashboard's time series**, rolled up in the database like the built-in metrics.
- **OpenTelemetry**, when OTLP export is enabled.

Details:

- `attrs` are only passed on to OpenTelemetry. The Prometheus endpoint exposes one unlabelled value per metric.
- Counters ignore negative and non-finite values; gauges ignore non-finite ones.
- Calling `counter` or `gauge` again with the same name returns a handle to the same metric. Metrics outlive a
  disable/enable cycle, so a counter keeps its value.
- Pick names that start with your plugin's name, so they can't clash with another plugin's.

The `MetricsService` also gives you read access to what the relay measures: `ctx.metrics.snapshot()` returns live
numbers (connections, events per second, stored events, latency percentiles, memory, loop lag, …), and
`series`, `kinds`, `topPubkeys`, `rejections` and `geo` query the stored rollups for a time range.
