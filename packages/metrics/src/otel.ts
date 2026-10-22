import type { Attributes, Meter } from "@opentelemetry/api";
import type { BeamhopConfig, LiveSnapshot, Logger } from "@beamhop/sdk";
import type { Totals } from "./collector";

export interface OtelHandle {
  meter: Meter;
  shutdown(): Promise<void>;
}

const SNAPSHOT_GAUGES: [keyof LiveSnapshot, string, string][] = [
  ["connections", "beamhop.connections", "{connection}"],
  ["authedConnections", "beamhop.connections.authed", "{connection}"],
  ["subscriptions", "beamhop.subscriptions", "{subscription}"],
  ["eventsInPerSec", "beamhop.events.in.rate", "{event}/s"],
  ["eventsOutPerSec", "beamhop.events.out.rate", "{event}/s"],
  ["reqPerSec", "beamhop.req.rate", "{req}/s"],
  ["rejectedPerSec", "beamhop.rejected.rate", "{event}/s"],
  ["totalEvents", "beamhop.events.stored", "{event}"],
  ["dbBytes", "beamhop.db.size", "By"],
  ["mediaBytes", "beamhop.media.size", "By"],
  ["mediaCount", "beamhop.media.count", "{blob}"],
  ["cpuPercent", "beamhop.process.cpu", "%"],
  ["memoryRss", "beamhop.process.memory.rss", "By"],
  ["heapUsed", "beamhop.process.memory.heap", "By"],
  ["loopLagMs", "beamhop.eventloop.lag", "ms"],
  ["reqLatencyP50", "beamhop.req.latency.p50", "ms"],
  ["reqLatencyP95", "beamhop.req.latency.p95", "ms"],
  ["reqLatencyP99", "beamhop.req.latency.p99", "ms"],
  ["uptimeSec", "beamhop.uptime", "s"],
];

/**
 * OTLP/HTTP metrics export. Uses observable instruments read from the live collector, so the relay
 * hot path pays nothing for OTel. Export failures (collector unreachable) are swallowed by the SDK.
 */
export async function setupOtel(
  cfg: BeamhopConfig["metrics"]["otel"],
  getSnapshot: () => LiveSnapshot,
  totals: () => Totals,
  logger: Logger,
  version = "0.1.0",
): Promise<OtelHandle | undefined> {
  try {
    const [{ MeterProvider, PeriodicExportingMetricReader }, { OTLPMetricExporter }, { resourceFromAttributes }] = await Promise.all([
      import("@opentelemetry/sdk-metrics"),
      import("@opentelemetry/exporter-metrics-otlp-http"),
      import("@opentelemetry/resources"),
    ]);
    const exporter = new OTLPMetricExporter({ url: cfg.endpoint, headers: cfg.headers });
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: cfg.intervalMs,
      exportTimeoutMillis: Math.min(cfg.intervalMs, 10_000),
    });
    const provider = new MeterProvider({
      resource: resourceFromAttributes({ "service.name": "beamhop", "service.version": version }),
      readers: [reader],
    });
    const meter = provider.getMeter("beamhop", version);

    for (const [key, name, unit] of SNAPSHOT_GAUGES) {
      meter.createObservableGauge(name, { unit }).addCallback((r) => r.observe(getSnapshot()[key] as number));
    }
    const counter = (name: string, unit: string, read: (t: Totals) => number) =>
      meter.createObservableCounter(name, { unit }).addCallback((r) => r.observe(read(totals())));
    counter("beamhop.events.in", "{event}", (t) => t.eventsIn);
    counter("beamhop.events.out", "{event}", (t) => t.eventsOut);
    counter("beamhop.req", "{req}", (t) => t.req);
    counter("beamhop.connections.opened", "{connection}", (t) => t.connectionsOpened);
    counter("beamhop.blob.bytes.served", "By", (t) => t.blobBytesServed);
    counter("beamhop.blob.bytes.uploaded", "By", (t) => t.blobBytesUploaded);
    counter("beamhop.blobs.uploaded", "{blob}", (t) => t.blobsUploaded);
    meter.createObservableCounter("beamhop.rejected", { unit: "{event}" }).addCallback((r) => {
      for (const [code, n] of totals().rejectedByCode) r.observe(n, { code } as Attributes);
    });

    logger.info("opentelemetry metrics export enabled", { endpoint: cfg.endpoint, intervalMs: cfg.intervalMs });
    return {
      meter,
      shutdown: async () => {
        try {
          await Promise.race([
            provider.shutdown(),
            new Promise((r) => (setTimeout(r, 2000) as { unref?: () => void }).unref?.()),
          ]);
        } catch {
          // collector unreachable on shutdown — ignore
        }
      },
    };
  } catch (err) {
    logger.warn("opentelemetry setup failed; continuing without export", { error: String(err) });
    return undefined;
  }
}
