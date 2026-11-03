/**
 * Load-test websocket client: callback dispatch instead of the e2e client's recorded inbox (which is O(n) per frame
 * and keeps every frame), latency timing per EVENT → OK and per REQ → EOSE.
 */
import { finalizeEvent, type Event } from "nostr-tools";

type Frame = unknown[];

export class LoadConn {
  private oks = new Map<string, { t0: number; resolve: (r: { ok: boolean; msg: string; ms: number }) => void }>();
  private subs = new Map<string, (f: Frame) => void>();
  closed = false;
  closeCode?: number;
  received = 0;
  /** the relay's NIP-42 challenge, once received */
  challenge?: string;
  onFrame?: (f: Frame) => void;

  private constructor(readonly ws: WebSocket) {
    ws.onmessage = (m) => {
      this.received++;
      const f = JSON.parse(String(m.data)) as Frame;
      if (f[0] === "AUTH") this.challenge = f[1] as string;
      if (f[0] === "OK") {
        const p = this.oks.get(f[1] as string);
        if (p) {
          this.oks.delete(f[1] as string);
          p.resolve({ ok: f[2] as boolean, msg: f[3] as string, ms: performance.now() - p.t0 });
        }
      } else if (typeof f[1] === "string" && this.subs.has(f[1])) this.subs.get(f[1])!(f);
      this.onFrame?.(f);
    };
    ws.onclose = (e) => {
      this.closed = true;
      this.closeCode = e.code;
      for (const p of this.oks.values()) p.resolve({ ok: false, msg: `closed ${e.code}`, ms: performance.now() - p.t0 });
      this.oks.clear();
      for (const cb of this.subs.values()) cb(["CLOSED", "", `socket closed ${e.code}`]);
    };
  }

  static connect(url: string, timeoutMs = 30_000): Promise<LoadConn> {
    const ws = new WebSocket(url);
    const c = new LoadConn(ws);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        ws.close();
        reject(new Error("connect timeout"));
      }, timeoutMs);
      ws.onopen = () => {
        clearTimeout(t);
        resolve(c);
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error(`websocket to ${url} failed`));
      };
    });
  }

  /**
   * NIP-42 as `sk` (the relay sends its challenge on connect). Benchmarks of the store authenticate as the relay
   * owner: staff are exempt from the per-address read budgets, which would otherwise measure the rate limiter.
   */
  async auth(sk: Uint8Array, relayUrl: string): Promise<boolean> {
    const challenge = await new Promise<string>((resolve) => {
      const prev = this.onFrame;
      this.onFrame = (f) => {
        if (f[0] === "AUTH") {
          this.onFrame = prev;
          resolve(f[1] as string);
        }
      };
      if (this.challenge) {
        this.onFrame = prev;
        resolve(this.challenge);
      }
    });
    const ev = finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000), tags: [["relay", relayUrl], ["challenge", challenge]], content: "" }, sk);
    return (await this.publishAuth(ev)).ok;
  }

  private publishAuth(ev: Event): Promise<{ ok: boolean; msg: string; ms: number }> {
    return new Promise((resolve) => {
      this.oks.set(ev.id, { t0: performance.now(), resolve });
      this.ws.send(JSON.stringify(["AUTH", ev]));
    });
  }

  get pendingOks() {
    return this.oks.size;
  }

  publish(ev: Event): Promise<{ ok: boolean; msg: string; ms: number }> {
    return new Promise((resolve) => {
      if (this.closed) return resolve({ ok: false, msg: "closed", ms: 0 });
      this.oks.set(ev.id, { t0: performance.now(), resolve });
      this.ws.send(JSON.stringify(["EVENT", ev]));
    });
  }

  /** REQ until EOSE/CLOSED; resolves with the number of events and the time to EOSE. Keeps the sub open if `live`. */
  req(subId: string, filters: object[], opts: { live?: (ev: Event) => void } = {}): Promise<{ n: number; ms: number; closed?: string }> {
    const t0 = performance.now();
    let n = 0;
    return new Promise((resolve) => {
      let eose = false;
      this.subs.set(subId, (f) => {
        if (f[0] === "EVENT") {
          if (eose) opts.live?.(f[2] as Event);
          else n++;
        } else if (f[0] === "EOSE") {
          eose = true;
          if (!opts.live) {
            this.subs.delete(subId);
            this.ws.send(JSON.stringify(["CLOSE", subId]));
          }
          resolve({ n, ms: performance.now() - t0 });
        } else if (f[0] === "CLOSED") {
          this.subs.delete(subId);
          if (!eose) resolve({ n, ms: performance.now() - t0, closed: String(f[2]) });
        }
      });
      this.ws.send(JSON.stringify(["REQ", subId, ...filters]));
    });
  }

  /** A request answered by one frame of `types` for `subId` (COUNT, NEG-MSG/NEG-ERR), or CLOSED. */
  request(msg: Frame, subId: string, types: string[]): Promise<{ f: Frame; ms: number }> {
    const t0 = performance.now();
    return new Promise((resolve) => {
      this.subs.set(subId, (f) => {
        if (types.includes(f[0] as string) || f[0] === "CLOSED") {
          this.subs.delete(subId);
          resolve({ f, ms: performance.now() - t0 });
        }
      });
      this.ws.send(JSON.stringify(msg));
    });
  }

  send(msg: Frame) {
    this.ws.send(JSON.stringify(msg));
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/** Connects `n` clients, `parallel` handshakes at a time. Failures are counted, not thrown. */
export async function connectMany(url: string, n: number, parallel = 200): Promise<{ conns: LoadConn[]; failed: number; errors: string[] }> {
  const conns: LoadConn[] = [];
  let failed = 0;
  const errors: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(parallel, n) }, async () => {
      while (next < n) {
        next++;
        try {
          conns.push(await LoadConn.connect(url));
        } catch (e) {
          failed++;
          if (errors.length < 5) errors.push((e as Error).message);
        }
      }
    }),
  );
  return { conns, failed, errors };
}
