// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Connection, RelayId } from '@beamhop/core';
import type { ServerWebSocket } from 'bun';

export interface WsData {
  conn?: BunConnection;
  /** Set for the proxy self-check WebSocket. */
  selfCheck?: { nonce?: string; nodeId: string };
}

/** `Connection` backed by a Bun `ServerWebSocket`. */
export class BunConnection implements Connection {
  readonly authed = new Set<string>();
  readonly state = new Map<string, unknown>();
  challenge: string;
  ws?: ServerWebSocket<WsData>;
  closed = false;
  /** Frames dropped because the socket was closed or the kernel refused them. */
  dropped = 0;

  constructor(
    readonly id: string,
    readonly relayId: RelayId,
    readonly ipHash: string,
    readonly openedAt: number,
    challenge: string,
    readonly userAgent?: string,
    /** ISO country from the trusted proxy header (see `node.countryHeader`). */
    readonly country?: string,
    /** Host the client connected to; lets the relay check NIP-42/62 relay tags on catch-all relays. */
    readonly host?: string,
  ) {
    this.challenge = challenge;
  }

  attach(ws: ServerWebSocket<WsData>): void {
    this.ws = ws;
  }

  send(frame: string): void {
    if (this.closed || !this.ws) {
      this.dropped++;
      return;
    }
    // -1 = queued under backpressure (still delivered), 0 = dropped.
    if (this.ws.send(frame) === 0) this.dropped++;
  }

  bufferedAmount(): number {
    if (!this.ws || this.closed) return 0;
    return this.ws.getBufferedAmount();
  }

  close(code = 1000, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close(code, reason);
    } catch {
      // already closing
    }
  }
}
