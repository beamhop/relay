// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Bun-only syslog transport (RFC 5425 TLS / RFC 6587 TCP / RFC 5426 UDP).
 * Imported lazily by the syslog sink; uses the `Bun` global (no module import),
 * so bundling this file for Workers is harmless — it is simply never called there.
 */
import type { SyslogTransport, SyslogTransportFactory } from './sinks.ts';

interface BunSocketLike {
  write(data: Uint8Array): number;
  end(): void;
}

export const bunSyslogTransport: SyslogTransportFactory = async (opts) => {
  if (typeof Bun === 'undefined') throw new Error('syslog transport requires Bun');
  if (opts.transport === 'udp') {
    const sock = await Bun.udpSocket({});
    return {
      async send(frames) {
        for (const f of frames) sock.send(f, opts.port, opts.host);
      },
      async close() {
        sock.close();
      },
    };
  }

  let pending: Uint8Array | null = null;
  let drainWaiters: Array<() => void> = [];
  let closed = false;
  let failure: Error | null = null;
  const flush = (s: BunSocketLike) => {
    if (!pending) return;
    const n = s.write(pending);
    pending = n >= pending.length ? null : pending.subarray(n);
    if (!pending) {
      const w = drainWaiters;
      drainWaiters = [];
      for (const fn of w) fn();
    }
  };
  const socket = (await Bun.connect({
    hostname: opts.host,
    port: opts.port,
    ...(opts.transport === 'tls'
      ? { tls: opts.caPem ? { ca: opts.caPem, serverName: opts.host } : { serverName: opts.host } }
      : {}),
    socket: {
      data() {},
      drain(s) {
        flush(s as unknown as BunSocketLike);
      },
      close() {
        closed = true;
        const w = drainWaiters;
        drainWaiters = [];
        for (const fn of w) fn();
      },
      error(_s, err) {
        failure = err;
        closed = true;
      },
    },
  })) as unknown as BunSocketLike;

  const t: SyslogTransport = {
    async send(frames) {
      if (closed) throw failure ?? new Error('syslog connection closed');
      let total = 0;
      for (const f of frames) total += f.length;
      const all = new Uint8Array(total);
      let o = 0;
      for (const f of frames) {
        all.set(f, o);
        o += f.length;
      }
      pending = all;
      const done = new Promise<void>((resolve) => drainWaiters.push(resolve));
      flush(socket);
      if (pending) await done;
      if (closed && pending) throw failure ?? new Error('syslog connection closed while sending');
    },
    async close() {
      closed = true;
      socket.end();
    },
  };
  return t;
};
