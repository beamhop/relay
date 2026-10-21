// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-process transport: runs the suite against a kernel without sockets, so
 * CI can exercise the whole relay + Blossom stack even where binding a local
 * port is not permitted. Frames are delivered asynchronously (microtasks) to
 * mimic a real socket.
 */
import { type Connection, type Kernel, type RelayId, dispatchHttp } from '@beamhop/core';
import type { Dialer, RawSocket } from './client.ts';
import type { SuiteContext } from './types.ts';

let seq = 0;

class LoopConnection implements Connection {
  readonly id = `conf-${++seq}`;
  readonly ipHash: string;
  readonly userAgent = 'beamhop-conformance';
  readonly openedAt = Date.now();
  readonly authed = new Set<string>();
  readonly state = new Map<string, unknown>();
  challenge = '';
  closed = false;

  constructor(
    readonly relayId: RelayId,
    private kernel: Kernel,
    private sock: RawSocket,
  ) {
    this.ipHash = `conformance-${seq % 16}`;
  }

  send(frame: string): void {
    if (this.closed) return;
    queueMicrotask(() => this.sock.onmessage?.(frame));
  }

  bufferedAmount(): number {
    return 0;
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    queueMicrotask(() => {
      this.sock.onclose?.(code, reason);
      this.kernel.ws?.onClose(this);
    });
  }
}

export interface InProcessTarget {
  relayUrl: string;
  httpUrl: string;
  blossomUrl: string;
  dial: Dialer;
  fetch: SuiteContext['fetch'];
}

export function inProcessTarget(
  kernel: Kernel,
  opts: { relayId: RelayId; origin?: string; maxFrameBytes?: number },
): InProcessTarget {
  const origin = (opts.origin ?? 'http://relay.test').replace(/\/+$/, '');
  const relayUrl = origin.replace(/^http/, 'ws');
  const maxFrame = opts.maxFrameBytes ?? 4 * 1024 * 1024;

  const dial: Dialer = async () => {
    const ws = kernel.ws;
    if (!ws) throw new Error('no WebSocket handler is registered');
    const ref: { conn?: LoopConnection } = {};
    const sock: RawSocket = {
      onmessage: null,
      onclose: null,
      send(data) {
        const conn = ref.conn;
        if (!conn || conn.closed) return;
        // Same guard as the Bun runtime's maxPayloadLength: oversize frames close the socket.
        if (data.length > maxFrame) {
          conn.close(1009, 'message too big');
          return;
        }
        ws.onMessage(conn, data);
      },
      close() {
        const conn = ref.conn;
        if (!conn || conn.closed) return;
        conn.closed = true;
        ws.onClose(conn);
      },
    };
    ref.conn = new LoopConnection(opts.relayId, kernel, sock);
    ws.onOpen(ref.conn);
    return sock;
  };

  const doFetch: SuiteContext['fetch'] = async (input, init) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    return dispatchHttp(kernel, req, {
      relayId: opts.relayId,
      publicUrl: origin,
      ipHash: 'conformance',
    });
  };

  return { relayUrl, httpUrl: origin, blossomUrl: origin, dial, fetch: doFetch };
}
