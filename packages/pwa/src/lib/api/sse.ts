// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal Server-Sent Events parser for `fetch` streams. `EventSource` cannot
 * send an `Authorization` header, so the live channel is read with fetch.
 */
import type { LiveMessage } from './types.ts';

export class SseParser {
  private buf = '';
  private event = 'message';
  private data: string[] = [];
  private id: string | undefined;

  /** Feed a decoded chunk; returns the complete messages it finished. */
  push(chunk: string): LiveMessage[] {
    this.buf += chunk;
    const out: LiveMessage[] = [];
    let nl = this.buf.search(/\r\n|\n|\r/);
    while (nl >= 0) {
      const line = this.buf.slice(0, nl);
      const sep = this.buf.startsWith('\r\n', nl) ? 2 : 1;
      this.buf = this.buf.slice(nl + sep);
      const msg = this.line(line);
      if (msg) out.push(msg);
      nl = this.buf.search(/\r\n|\n|\r/);
    }
    return out;
  }

  private line(line: string): LiveMessage | null {
    if (line === '') {
      if (this.data.length === 0) {
        this.event = 'message';
        return null;
      }
      const raw = this.data.join('\n');
      let data: unknown = raw;
      try {
        data = JSON.parse(raw);
      } catch {
        // keep the raw string
      }
      const msg: LiveMessage = { event: this.event, data };
      if (this.id !== undefined) msg.id = this.id;
      this.event = 'message';
      this.data = [];
      return msg;
    }
    if (line.startsWith(':')) return null;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
    return null;
  }
}

/** Read an SSE response body, calling `onMessage` for each message until it ends. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onMessage: (m: LiveMessage) => void,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const parser = new SseParser();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const m of parser.push(dec.decode(value, { stream: true }))) onMessage(m);
  }
}
