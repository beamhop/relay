/**
 * Helpers for the adv-*.test.ts adversarial suites: a raw TCP websocket client (lets a test send frames a normal
 * WebSocket can't — invalid UTF-8 in a text frame, unmasked frames — and stop reading entirely) plus small HTTP
 * utilities. Black-box only: everything goes over the wire.
 */
import { randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Encodes a client → server frame (masked unless `mask: false`). */
export function encodeFrame(opcode: number, payload: Uint8Array | string, opts: { mask?: boolean; fin?: boolean; rsv?: number } = {}): Buffer {
  const data = typeof payload === "string" ? Buffer.from(payload) : Buffer.from(payload);
  const mask = opts.mask ?? true;
  const head: number[] = [((opts.fin ?? true) ? 0x80 : 0) | ((opts.rsv ?? 0) << 4) | opcode];
  const m = mask ? 0x80 : 0;
  if (data.length < 126) head.push(m | data.length);
  else if (data.length < 65536) head.push(m | 126, data.length >> 8, data.length & 255);
  else {
    head.push(m | 127);
    const len = Buffer.alloc(8);
    len.writeBigUInt64BE(BigInt(data.length));
    head.push(...len);
  }
  if (!mask) return Buffer.concat([Buffer.from(head), data]);
  const key = randomBytes(4);
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key[i & 3];
  return Buffer.concat([Buffer.from(head), key, out]);
}

/**
 * A websocket spoken over a plain TCP socket. `paused` stops reading from the kernel (a client that never reads);
 * frames are parsed as they arrive while reading.
 */
export class RawWs {
  readonly frames: WsFrame[] = [];
  bytesIn = 0;
  ended = false;
  private buf: Buffer = Buffer.alloc(0);
  private constructor(readonly sock: Socket) {}

  static async open(port: number, opts: { headers?: Record<string, string>; path?: string; paused?: boolean } = {}): Promise<RawWs> {
    const sock = connect({ host: "127.0.0.1", port });
    const ws = new RawWs(sock);
    const key = randomBytes(16).toString("base64");
    const extra = Object.entries(opts.headers ?? {})
      .map(([k, v]) => `${k}: ${v}\r\n`)
      .join("");
    await new Promise<void>((resolve, reject) => {
      sock.once("error", reject);
      sock.once("connect", () => {
        sock.write(
          `GET ${opts.path ?? "/"} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`,
        );
      });
      let head = Buffer.alloc(0);
      const onData = (d: Buffer) => {
        head = Buffer.concat([head, d]);
        const i = head.indexOf("\r\n\r\n");
        if (i < 0) return;
        sock.off("data", onData);
        const status = head.subarray(0, i).toString().split("\r\n")[0];
        if (!status.includes(" 101 ")) return reject(new Error(`upgrade refused: ${status}`));
        if (opts.paused) sock.pause();
        sock.on("data", (chunk: Buffer) => ws.onData(chunk));
        sock.on("end", () => (ws.ended = true));
        sock.on("close", () => (ws.ended = true));
        ws.onData(head.subarray(i + 4));
        resolve();
      };
      sock.on("data", onData);
    });
    return ws;
  }

  private onData(chunk: Buffer) {
    this.bytesIn += chunk.length;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      if (this.buf.length < off + len) return;
      this.frames.push({ fin: !!(b0 & 0x80), opcode: b0 & 0x0f, payload: Buffer.from(this.buf.subarray(off, off + len)) });
      this.buf = this.buf.subarray(off + len);
    }
  }

  sendFrame(opcode: number, payload: Uint8Array | string, opts: { mask?: boolean; fin?: boolean; rsv?: number } = {}) {
    this.sock.write(encodeFrame(opcode, payload, opts));
  }
  text(s: string | Uint8Array) {
    this.sendFrame(1, s);
  }
  json(msg: unknown) {
    this.text(JSON.stringify(msg));
  }

  /** Parsed text messages received so far. */
  messages(): unknown[][] {
    return this.frames.filter((f) => f.opcode === 1).map((f) => JSON.parse(f.payload.toString()));
  }
  /** Close code of the server's close frame, if one arrived. */
  closeCode(): number | undefined {
    const f = this.frames.find((x) => x.opcode === 8);
    return f && f.payload.length >= 2 ? f.payload.readUInt16BE(0) : f ? 1005 : undefined;
  }

  async waitFor(pred: (m: unknown[]) => boolean, ms = 3000): Promise<unknown[]> {
    const deadline = Date.now() + ms;
    for (;;) {
      const m = this.messages().find(pred);
      if (m) return m;
      if (Date.now() > deadline) throw new Error(`raw ws: timeout; got ${JSON.stringify(this.messages()).slice(0, 500)}`);
      await Bun.sleep(5);
    }
  }
  /** Resolves when the server closed (close frame or TCP end), with the close code if there was a frame. */
  async waitClosed(ms = 3000): Promise<number | undefined> {
    const deadline = Date.now() + ms;
    while (this.closeCode() === undefined && !this.ended) {
      if (Date.now() > deadline) throw new Error("raw ws: server did not close");
      await Bun.sleep(5);
    }
    return this.closeCode();
  }
  destroy() {
    this.sock.destroy();
  }
}

/** Sends a raw HTTP/1.1 request over TCP and returns the status line + headers + (possibly partial) body. */
export async function rawHttp(port: number, request: string | Buffer, ms = 3000): Promise<{ status: number; head: string; body: string }> {
  const sock = connect({ host: "127.0.0.1", port });
  let out = Buffer.alloc(0);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      sock.destroy();
      resolve();
    }, ms);
    sock.on("connect", () => sock.write(request));
    sock.on("data", (d: Buffer) => {
      out = Buffer.concat([out, d]);
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const s = out.toString("latin1");
  const i = s.indexOf("\r\n\r\n");
  const head = i >= 0 ? s.slice(0, i) : s;
  return { status: Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0), head, body: i >= 0 ? s.slice(i + 4) : "" };
}

/** Markers of a leaked stack trace or source path in a response body. */
export function looksLikeLeak(body: string, extra: string[] = []): string | undefined {
  const patterns = [/\bat [\w.$<>]+ \(/, /\.tsx?:\d+/, /node_modules/, /\/packages\//, /\/Users\//, /\/home\//, /file:\/\//, /Error: .*\n\s+at /];
  for (const p of patterns) if (p.test(body)) return `matched ${p}`;
  for (const s of extra) if (s && body.includes(s)) return `contains ${s}`;
  return undefined;
}
