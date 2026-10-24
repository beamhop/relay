import type { LiveSnapshot, MetricsService } from "@beamhop/sdk";
import type { MetricsServiceImpl } from "./service";

const GAUGES: [keyof LiveSnapshot, string, string][] = [
  ["uptimeSec", "uptime_seconds", "Seconds since the metrics service started"],
  ["connections", "connections", "Open websocket connections"],
  ["authedConnections", "connections_authed", "NIP-42 authenticated connections"],
  ["subscriptions", "subscriptions", "Active subscriptions"],
  ["eventsInPerSec", "events_in_per_second", "Accepted events per second (10s window)"],
  ["eventsOutPerSec", "events_out_per_second", "Events sent to clients per second (10s window)"],
  ["reqPerSec", "req_per_second", "REQs per second (10s window)"],
  ["rejectedPerSec", "rejected_per_second", "Rejected events per second (10s window)"],
  ["totalEvents", "events_stored", "Stored events"],
  ["dbBytes", "db_bytes", "Event store size in bytes"],
  ["mediaBytes", "media_bytes", "Blossom storage in bytes"],
  ["mediaCount", "media_blobs", "Blossom blob count"],
  ["cpuPercent", "cpu_percent", "Process CPU usage percent"],
  ["memoryRss", "memory_rss_bytes", "Resident set size in bytes"],
  ["heapUsed", "heap_used_bytes", "JS heap used in bytes"],
  ["loopLagMs", "event_loop_lag_ms", "Event loop lag in ms"],
  ["reqLatencyP50", "req_latency_p50_ms", "REQ latency p50 (last minute)"],
  ["reqLatencyP95", "req_latency_p95_ms", "REQ latency p95 (last minute)"],
  ["reqLatencyP99", "req_latency_p99_ms", "REQ latency p99 (last minute)"],
];

const sanitize = (name: string) => {
  const s = name.replace(/[^a-zA-Z0-9_:]/g, "_");
  return /^[0-9]/.test(s) ? `_${s}` : s;
};
const escapeLabel = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
const escapeHelp = (v: string) => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
const fmt = (n: number) => (Number.isFinite(n) ? String(n) : n > 0 ? "+Inf" : n < 0 ? "-Inf" : "NaN");

/** Prometheus text exposition (format 0.0.4) of the live snapshot, cumulative counters and plugin metrics. */
export function renderPrometheus(service: MetricsService): string {
  const out: string[] = [];
  /** a name may appear once (a duplicate `# TYPE` makes Prometheus reject the whole scrape) */
  const emitted = new Set<string>();
  const metric = (name: string, type: "gauge" | "counter", help: string, samples: [string, number][]) => {
    if (emitted.has(name)) return;
    emitted.add(name);
    out.push(`# HELP ${name} ${escapeHelp(help)}`, `# TYPE ${name} ${type}`);
    for (const [labels, v] of samples) out.push(`${name}${labels} ${fmt(v)}`);
  };
  const snap = service.snapshot();
  for (const [key, name, help] of GAUGES) metric(`beamhop_${name}`, "gauge", help, [["", snap[key] as number]]);

  const impl = service as Partial<MetricsServiceImpl>;
  if (typeof impl.totals === "function") {
    const t = impl.totals();
    const c = (name: string, help: string, v: number) => metric(`beamhop_${name}_total`, "counter", help, [["", v]]);
    c("events_in", "Accepted events", t.eventsIn);
    c("events_out", "Events sent to clients", t.eventsOut);
    c("req", "REQs executed", t.req);
    metric(
      "beamhop_rejected_total", "counter", "Rejected events by code",
      [...t.rejectedByCode].map(([code, n]) => [`{code="${escapeLabel(code)}"}`, n]),
    );
    c("connections_opened", "Websocket connections opened", t.connectionsOpened);
    c("connections_closed", "Websocket connections closed", t.connectionsClosed);
    c("bytes_in", "Websocket bytes received", t.bytesIn);
    c("bytes_out", "Websocket bytes sent", t.bytesOut);
    c("blobs_uploaded", "Blobs uploaded", t.blobsUploaded);
    c("blob_bytes_uploaded", "Blob bytes uploaded", t.blobBytesUploaded);
    c("blobs_served", "Blobs served", t.blobsServed);
    c("blob_bytes_served", "Blob bytes served", t.blobBytesServed);
  }
  // plugin metrics come last, so a plugin can't shadow a built-in series (collisions are skipped)
  if (typeof impl.customMetrics === "function") {
    const { counters, gauges } = impl.customMetrics();
    for (const [name, m] of counters) {
      const n = sanitize(name);
      metric(n.endsWith("_total") ? n : `${n}_total`, "counter", m.help ?? name, [["", m.value]]);
    }
    for (const [name, m] of gauges) metric(sanitize(name), "gauge", m.help ?? name, [["", m.value]]);
  }
  return out.join("\n") + "\n";
}

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
