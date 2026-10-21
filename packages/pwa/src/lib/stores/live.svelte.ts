// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One shared live channel (`/live` SSE) for the whole app: a bounded ring of
 * recent events for the Activity stream and bucketed counters for the Home
 * sparklines. Degrades gracefully: without the stream the tiles show "—".
 */
import type { LiveMessage } from '../api/types.ts';
import { app } from './app.svelte.ts';

export interface LiveItem {
  seq: number;
  at: number;
  name: string;
  relayId: string | null;
  data: Record<string, unknown>;
}

export const LIVE_EVENTS = [
  'event.accepted',
  'event.rejected',
  'event.held',
  'event.deleted',
  'report.received',
  'blob.uploaded',
  'blob.deleted',
  'blob.quarantined',
  'admin.action',
  'config.changed',
  'auth.success',
  'conn.open',
  'conn.close',
  'error',
];

const RING = 500;
const BUCKET_MS = 5000;
const POINTS = 36;

export interface Series {
  points: number[];
  latest: number | null;
}

function emptySeries(): number[] {
  return Array.from({ length: POINTS }, () => 0);
}

class Live {
  connected = $state(false);
  items = $state<LiveItem[]>([]);
  paused = $state(false);
  connections = $state<number[]>([]);
  eventsPerSec = $state<number[]>(emptySeries());
  errors = $state<number[]>(emptySeries());
  storageBytes = $state<number[]>([]);
  /** Bumped when something changed that screens may want to reload (cards, queue). */
  tick = $state(0);
  private seq = 0;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private bucket = { events: 0, errors: 0, bytes: 0 };
  private totalBytes = 0;
  private buffered: LiveItem[] = [];
  private flushQueued = false;

  start(): void {
    if (this.abort) return;
    this.abort = new AbortController();
    void app.api.live((msg) => this.onMessage(msg), {
      events: LIVE_EVENTS,
      signal: this.abort.signal,
      onState: (up) => {
        this.connected = up;
      },
    });
    void this.pollConnections();
    this.timer = setInterval(() => this.roll(), BUCKET_MS);
  }

  stop(): void {
    this.abort?.abort();
    this.abort = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.connected = false;
  }

  private async pollConnections(): Promise<void> {
    try {
      const h = await app.api.healthz();
      if (typeof h.connections === 'number')
        this.connections = [...this.connections.slice(-(POINTS - 1)), h.connections];
    } catch {
      // runtime without /healthz: leave the tile empty
    }
  }

  private roll(): void {
    const secs = BUCKET_MS / 1000;
    this.eventsPerSec = [
      ...this.eventsPerSec.slice(1),
      Math.round((this.bucket.events / secs) * 10) / 10,
    ];
    this.errors = [...this.errors.slice(1), this.bucket.errors];
    this.totalBytes += this.bucket.bytes;
    if (this.storageBytes.length || this.totalBytes)
      this.storageBytes = [...this.storageBytes.slice(-(POINTS - 1)), this.totalBytes];
    this.bucket = { events: 0, errors: 0, bytes: 0 };
    void this.pollConnections();
  }

  onMessage(msg: LiveMessage): void {
    if (msg.event === 'ready' || msg.event === 'message') return;
    const data = (msg.data ?? {}) as Record<string, unknown>;
    if (msg.event === 'event.accepted') this.bucket.events++;
    if (msg.event === 'error' || msg.event === 'event.rejected') this.bucket.errors++;
    if (msg.event === 'blob.uploaded') this.bucket.bytes += Number(data.size ?? 0);
    if (
      msg.event === 'event.held' ||
      msg.event === 'report.received' ||
      msg.event === 'blob.quarantined' ||
      msg.event === 'admin.action' ||
      msg.event === 'config.changed'
    )
      this.tick++;
    if (this.paused) return;
    this.buffered.push({
      seq: ++this.seq,
      at: Date.now(),
      name: msg.event,
      relayId: (data.relayId as string | undefined) ?? null,
      data,
    });
    if (!this.flushQueued) {
      this.flushQueued = true;
      // Batch bursts into one render.
      setTimeout(() => this.flush(), 250);
    }
  }

  private flush(): void {
    this.flushQueued = false;
    if (!this.buffered.length) return;
    const next = [...this.buffered.reverse(), ...this.items];
    this.buffered = [];
    this.items = next.length > RING ? next.slice(0, RING) : next;
  }

  clear(): void {
    this.items = [];
  }
}

export const live = new Live();
