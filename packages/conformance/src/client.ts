// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal relay client used by the conformance checks. It deliberately does
 * nothing clever (no reconnects, no dedupe, no verification) so the checks see
 * exactly what the relay sends.
 *
 * Transport is pluggable (`Dialer`): the default uses the Web-standard global
 * `WebSocket`; `inprocess.ts` provides one that talks to a kernel directly.
 */
import type { NostrEvent } from '@beamhop/core';

export type Frame = [string, ...unknown[]];

/** The smallest socket surface the client needs. */
export interface RawSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onmessage: ((data: string) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
}

export type Dialer = (url: string, timeoutMs: number) => Promise<RawSocket>;

/** Dial with the global WebSocket (Bun, Deno, browsers, Node ≥ 22). */
export const webSocketDialer: Dialer = (url, timeoutMs) =>
  new Promise<RawSocket>((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    const sock: RawSocket = {
      send: (d) => ws.send(d),
      close: (code, reason) => {
        try {
          ws.close(code ?? 1000, reason);
        } catch {
          // already closed
        }
      },
      onmessage: null,
      onclose: null,
    };
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error(`could not connect within ${timeoutMs} ms`));
    }, timeoutMs);
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(sock);
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('connection failed'));
    };
    // Frames can arrive before the caller attaches a handler (e.g. an AUTH
    // challenge sent right on open); queue them instead of dropping them.
    const early: string[] = [];
    let handler: ((data: string) => void) | null = null;
    Object.defineProperty(sock, 'onmessage', {
      get: () => handler,
      set: (h: ((data: string) => void) | null) => {
        handler = h;
        if (h) for (const d of early.splice(0)) h(d);
      },
    });
    ws.onmessage = (e) => {
      const data = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data);
      if (handler) handler(data);
      else early.push(data);
    };
    ws.onclose = (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`connection closed (${e.code})`));
        return;
      }
      sock.onclose?.(e.code, e.reason);
    };
  });

export interface OkResult {
  accepted: boolean;
  message: string;
}

export interface ReqResult {
  events: NostrEvent[];
  /** True when EOSE arrived. */
  eose: boolean;
  /** Reason when the relay answered CLOSED instead of EOSE. */
  closed?: string;
  /** True when neither arrived in time. */
  timedOut: boolean;
}

export interface CountResult {
  count?: number;
  approximate?: boolean;
  closed?: string;
  timedOut: boolean;
}

type Waiter = { pred: (f: Frame) => boolean; from: number; resolve: (f: Frame | null) => void };

export class RelayClient {
  /** Every parsed frame received, in order. */
  readonly frames: Frame[] = [];
  /** Raw frames that were not valid JSON arrays (protocol violations by the relay). */
  readonly garbage: string[] = [];
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  private waiters = new Set<Waiter>();
  private seq = 0;

  constructor(
    private sock: RawSocket,
    readonly url: string,
    readonly timeoutMs: number,
  ) {
    sock.onmessage = (data) => this.receive(data);
    sock.onclose = (code, reason) => {
      this.closed = true;
      this.closeCode = code;
      this.closeReason = reason;
      for (const w of this.waiters) w.resolve(null);
      this.waiters.clear();
    };
  }

  static async connect(dial: Dialer, url: string, timeoutMs: number): Promise<RelayClient> {
    return new RelayClient(await dial(url, timeoutMs), url, timeoutMs);
  }

  private receive(data: string): void {
    let f: unknown;
    try {
      f = JSON.parse(data);
    } catch {
      this.garbage.push(data);
      return;
    }
    if (!Array.isArray(f) || typeof f[0] !== 'string') {
      this.garbage.push(data);
      return;
    }
    const frame = f as Frame;
    const index = this.frames.length;
    this.frames.push(frame);
    for (const w of [...this.waiters]) {
      if (index >= w.from && w.pred(frame)) {
        this.waiters.delete(w);
        w.resolve(frame);
      }
    }
  }

  /** Position marker: frames received after this index are "new". */
  mark(): number {
    return this.frames.length;
  }

  /** Unique subscription id. */
  subId(prefix = 'c'): string {
    return `${prefix}${++this.seq}-${Math.random().toString(36).slice(2, 8)}`;
  }

  sendRaw(data: string): void {
    if (this.closed) return;
    try {
      this.sock.send(data);
    } catch {
      // socket died; the close handler records it
    }
  }

  send(msg: unknown[]): void {
    this.sendRaw(JSON.stringify(msg));
  }

  /** Wait for the first frame at/after `from` matching `pred`; null on timeout or close. */
  waitFor(
    pred: (f: Frame) => boolean,
    from = 0,
    timeoutMs = this.timeoutMs,
  ): Promise<Frame | null> {
    for (let i = from; i < this.frames.length; i++) {
      const f = this.frames[i]!;
      if (pred(f)) return Promise.resolve(f);
    }
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const w: Waiter = {
        pred,
        from,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(w);
        resolve(null);
      }, timeoutMs);
      this.waiters.add(w);
    });
  }

  /** Frames received since `from`. */
  since(from: number): Frame[] {
    return this.frames.slice(from);
  }

  /** Publish an event; null when no OK arrived in time. */
  async publish(event: NostrEvent | Record<string, unknown>, timeoutMs?: number) {
    const id = typeof event.id === 'string' ? event.id : undefined;
    const from = this.mark();
    this.send(['EVENT', event]);
    const ok = await this.waitFor(
      (f) => f[0] === 'OK' && (id === undefined || f[1] === id),
      from,
      timeoutMs,
    );
    if (!ok) return null;
    return { accepted: ok[2] === true, message: typeof ok[3] === 'string' ? ok[3] : '' };
  }

  /** Run a REQ until EOSE/CLOSED; the subscription is closed afterwards unless `keepOpen`. */
  async req(
    filters: unknown[],
    opts: { subId?: string; keepOpen?: boolean; timeoutMs?: number } = {},
  ): Promise<ReqResult & { subId: string }> {
    const subId = opts.subId ?? this.subId('q');
    const from = this.mark();
    this.send(['REQ', subId, ...filters]);
    const end = await this.waitFor(
      (f) => (f[0] === 'EOSE' || f[0] === 'CLOSED') && f[1] === subId,
      from,
      opts.timeoutMs,
    );
    const events = this.since(from)
      .filter((f) => f[0] === 'EVENT' && f[1] === subId)
      .map((f) => f[2] as NostrEvent);
    if (!opts.keepOpen && end?.[0] === 'EOSE') this.send(['CLOSE', subId]);
    const out: ReqResult & { subId: string } = {
      subId,
      events,
      eose: end?.[0] === 'EOSE',
      timedOut: end === null,
    };
    if (end?.[0] === 'CLOSED') out.closed = String(end[2] ?? '');
    return out;
  }

  async count(filters: unknown[], timeoutMs?: number): Promise<CountResult> {
    const subId = this.subId('n');
    const from = this.mark();
    this.send(['COUNT', subId, ...filters]);
    const f = await this.waitFor(
      (x) => (x[0] === 'COUNT' || x[0] === 'CLOSED') && x[1] === subId,
      from,
      timeoutMs,
    );
    if (!f) return { timedOut: true };
    if (f[0] === 'CLOSED') return { closed: String(f[2] ?? ''), timedOut: false };
    const body = f[2] as { count?: unknown; approximate?: unknown } | undefined;
    const out: CountResult = { timedOut: false };
    if (typeof body?.count === 'number') out.count = body.count;
    if (typeof body?.approximate === 'boolean') out.approximate = body.approximate;
    return out;
  }

  /** The most recent NIP-42 challenge, waiting briefly for one if none arrived yet. */
  async challenge(timeoutMs = Math.min(this.timeoutMs, 3000)): Promise<string | null> {
    for (let i = this.frames.length - 1; i >= 0; i--) {
      const f = this.frames[i]!;
      if (f[0] === 'AUTH' && typeof f[1] === 'string') return f[1];
    }
    const f = await this.waitFor((x) => x[0] === 'AUTH' && typeof x[1] === 'string', 0, timeoutMs);
    return f ? (f[1] as string) : null;
  }

  /** Send an AUTH event and wait for the OK. */
  async auth(event: NostrEvent | Record<string, unknown>): Promise<OkResult | null> {
    const id = typeof event.id === 'string' ? event.id : undefined;
    const from = this.mark();
    this.send(['AUTH', event]);
    const ok = await this.waitFor((f) => f[0] === 'OK' && (!id || f[1] === id), from);
    if (!ok) return null;
    return { accepted: ok[2] === true, message: typeof ok[3] === 'string' ? ok[3] : '' };
  }

  /** Liveness probe: a trivial REQ must get EOSE or CLOSED. */
  async ping(timeoutMs?: number): Promise<boolean> {
    if (this.closed) return false;
    const r = await this.req([{ ids: ['0'.repeat(64)], limit: 1 }], { timeoutMs });
    return !r.timedOut;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters) w.resolve(null);
    this.waiters.clear();
    this.sock.close(1000, 'done');
  }
}

/** Standard machine-readable prefixes for OK/CLOSED messages (NIP-01). */
export const REASON_PREFIXES = [
  'duplicate',
  'pow',
  'blocked',
  'rate-limited',
  'invalid',
  'restricted',
  'auth-required',
  'mute',
  'error',
  'unsupported',
] as const;

export function reasonPrefix(message: string): string | undefined {
  const m = /^([a-z-]+):/.exec(message);
  return m && (REASON_PREFIXES as readonly string[]).includes(m[1]!) ? m[1] : undefined;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
