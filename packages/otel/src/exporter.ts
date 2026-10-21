// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Batching OTLP/HTTP JSON span exporter over `fetch`.
 *
 * - Bounded memory: at most `maxQueue` spans wait in the queue (plus one batch in
 *   flight). When full, new spans are dropped and counted, never buffered.
 * - Retries transient failures (network errors, 408, 429, 5xx) with exponential
 *   backoff and jitter, honouring `Retry-After`; other 4xx answers drop the batch.
 * - One export at a time; `flush()` drains the queue in batches of `maxBatch`.
 */
import { type ResourceInfo, type SpanData, encodeTraces, tracesUrl } from './otlp.ts';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ExporterOptions {
  /** Current collector base URL (undefined = off: spans are not accepted). */
  endpoint: () => string | undefined;
  headers: () => Record<string, string>;
  resource: () => ResourceInfo;
  fetch: FetchLike;
  /** Spans waiting to be sent before new ones are dropped (default 2048). */
  maxQueue?: number;
  /** Spans per export request (default 512). */
  maxBatch?: number;
  /** Attempts per batch, including the first (default 4). */
  maxAttempts?: number;
  /** First retry delay in ms; doubles each attempt, capped at 30 s (default 500). */
  retryBaseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/** Exporter counters (shown by the `otel.status` action). */
export interface ExporterStats {
  queued: number;
  exported: number;
  dropped: number;
  failedBatches: number;
  retries: number;
  lastSuccessAt?: number;
  lastError?: string;
}

const MAX_BACKOFF_MS = 30_000;

export class OtlpTraceExporter {
  private queue: SpanData[] = [];
  private running: Promise<void> | null = null;
  private readonly maxQueue: number;
  private readonly maxBatch: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly now: () => number;
  private counters = { exported: 0, dropped: 0, failedBatches: 0, retries: 0 };
  private lastSuccessAt?: number;
  private lastError?: string;

  constructor(private readonly opts: ExporterOptions) {
    this.maxQueue = Math.max(1, opts.maxQueue ?? 2048);
    this.maxBatch = Math.max(1, opts.maxBatch ?? 512);
    this.maxAttempts = Math.max(1, opts.maxAttempts ?? 4);
    this.retryBaseMs = Math.max(0, opts.retryBaseMs ?? 500);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.now = opts.now ?? Date.now;
  }

  /** Queue a finished span. Returns false when it was dropped (off or queue full). */
  enqueue(span: SpanData): boolean {
    if (!this.opts.endpoint()) return false;
    if (this.queue.length >= this.maxQueue) {
      this.counters.dropped++;
      return false;
    }
    this.queue.push(span);
    return true;
  }

  /** True when a full batch is waiting (callers may flush early). */
  batchReady(): boolean {
    return this.queue.length >= this.maxBatch;
  }

  stats(): ExporterStats {
    return {
      queued: this.queue.length,
      ...this.counters,
      ...(this.lastSuccessAt !== undefined ? { lastSuccessAt: this.lastSuccessAt } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  /** Send everything queued. Concurrent calls share the running drain. */
  flush(): Promise<void> {
    if (this.running) return this.running;
    if (this.queue.length === 0) return Promise.resolve();
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      const endpoint = this.opts.endpoint();
      if (!endpoint) {
        // Turned off while spans were waiting: discard them.
        this.counters.dropped += this.queue.length;
        this.queue = [];
        return;
      }
      const batch = this.queue.splice(0, this.maxBatch);
      const ok = await this.send(endpoint, batch);
      if (!ok) {
        this.counters.failedBatches++;
        this.counters.dropped += batch.length;
        // Do not hammer a collector that is down: leave the rest for the next flush.
        return;
      }
      this.counters.exported += batch.length;
      this.lastSuccessAt = this.now();
    }
  }

  private async send(endpoint: string, batch: SpanData[]): Promise<boolean> {
    const body = JSON.stringify(encodeTraces(batch, this.opts.resource()));
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let retryAfterMs: number | undefined;
      try {
        const res = await this.opts.fetch(tracesUrl(endpoint), {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...this.opts.headers() },
          body,
        });
        // Drain the body so the connection can be reused.
        await res.arrayBuffer().catch(() => undefined);
        if (res.ok) {
          this.lastError = undefined;
          return true;
        }
        this.lastError = `collector answered HTTP ${res.status}`;
        const transient = res.status === 408 || res.status === 429 || res.status >= 500;
        if (!transient) return false;
        retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      } catch (err) {
        this.lastError = `collector not reachable: ${err instanceof Error ? err.message : String(err)}`;
      }
      if (attempt === this.maxAttempts) break;
      this.counters.retries++;
      const backoff = Math.min(MAX_BACKOFF_MS, this.retryBaseMs * 2 ** (attempt - 1));
      const jittered = backoff * (0.5 + this.random() * 0.5);
      await this.sleep(Math.min(MAX_BACKOFF_MS, retryAfterMs ?? jittered));
    }
    return false;
  }
}

function parseRetryAfter(v: string | null): number | undefined {
  if (!v) return undefined;
  const s = Number(v);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : undefined;
}
