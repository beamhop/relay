// SPDX-License-Identifier: AGPL-3.0-or-later
/** Ring buffer of recent bus `error` events (IP-free, no stacks) for `get_recent_errors`. */
import type { EventBus, RelayId } from '@beamhop/core';
import { scrubText, truncate } from './safety.ts';

export interface RecentError {
  at: number;
  relayId?: RelayId;
  source: string;
  message: string;
  /** Number of identical errors folded into this entry. */
  count: number;
}

export class ErrorRing {
  private items: RecentError[] = [];

  constructor(
    private readonly size = 100,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  attach(bus: EventBus): () => void {
    return bus.on('error', (e) => this.add(e));
  }

  add(e: { relayId?: RelayId; source: string; message: string }): void {
    const message = truncate(scrubText(String(e.message ?? '')), 500);
    const source = truncate(scrubText(String(e.source ?? 'unknown')), 100);
    const last = this.items[this.items.length - 1];
    if (last && last.message === message && last.source === source && last.relayId === e.relayId) {
      last.count++;
      last.at = this.now();
      return;
    }
    const item: RecentError = { at: this.now(), source, message, count: 1 };
    if (e.relayId) item.relayId = e.relayId;
    this.items.push(item);
    if (this.items.length > this.size) this.items.splice(0, this.items.length - this.size);
  }

  /** Newest first. */
  list(opts: { relayId?: RelayId | null; limit?: number; since?: number } = {}): RecentError[] {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), this.size);
    return this.items
      .filter(
        (e) =>
          (!opts.relayId || !e.relayId || e.relayId === opts.relayId) &&
          (!opts.since || e.at >= opts.since),
      )
      .slice(-limit)
      .reverse();
  }
}
