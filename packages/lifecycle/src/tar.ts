// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal POSIX ustar writer/reader + gzip via the Web `CompressionStream`
 * (Bun and Workers). Regular files only; names up to 255 bytes (prefix split).
 */

export interface TarEntry {
  name: string;
  data: Uint8Array;
  /** Unix seconds. */
  mtime?: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function writeStr(buf: Uint8Array, off: number, len: number, s: string) {
  const b = enc.encode(s);
  buf.set(b.subarray(0, len), off);
}

function writeOctal(buf: Uint8Array, off: number, len: number, n: number) {
  writeStr(buf, off, len, `${n.toString(8).padStart(len - 1, '0')}\0`);
}

function splitName(name: string): { prefix: string; base: string } {
  if (enc.encode(name).length <= 100) return { prefix: '', base: name };
  const cut = name.lastIndexOf('/', name.length - 1);
  for (let i = cut; i > 0; i = name.lastIndexOf('/', i - 1)) {
    const prefix = name.slice(0, i);
    const base = name.slice(i + 1);
    if (enc.encode(prefix).length <= 155 && enc.encode(base).length <= 100) return { prefix, base };
  }
  throw new Error(`tar: name too long: ${name}`);
}

function header(e: TarEntry): Uint8Array {
  const h = new Uint8Array(512);
  const { prefix, base } = splitName(e.name);
  writeStr(h, 0, 100, base);
  writeOctal(h, 100, 8, 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, e.data.length);
  writeOctal(h, 136, 12, Math.floor(e.mtime ?? 0));
  h.fill(0x20, 148, 156); // checksum placeholder: spaces
  h[156] = 0x30; // '0' regular file
  writeStr(h, 257, 6, 'ustar\0');
  writeStr(h, 263, 2, '00');
  writeStr(h, 265, 32, 'beamhop');
  writeStr(h, 297, 32, 'beamhop');
  writeStr(h, 345, 155, prefix);
  let sum = 0;
  for (const b of h) sum += b;
  writeStr(h, 148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return h;
}

export function tarPack(entries: TarEntry[]): Uint8Array {
  let size = 1024;
  for (const e of entries) size += 512 + Math.ceil(e.data.length / 512) * 512;
  const out = new Uint8Array(size);
  let off = 0;
  for (const e of entries) {
    out.set(header(e), off);
    off += 512;
    out.set(e.data, off);
    off += Math.ceil(e.data.length / 512) * 512;
  }
  return out;
}

function readStr(buf: Uint8Array, off: number, len: number): string {
  const slice = buf.subarray(off, off + len);
  const end = slice.indexOf(0);
  return dec.decode(end >= 0 ? slice.subarray(0, end) : slice);
}

function readOctal(buf: Uint8Array, off: number, len: number): number {
  const s = readStr(buf, off, len).trim();
  return s ? Number.parseInt(s, 8) : 0;
}

export function tarUnpack(buf: Uint8Array): TarEntry[] {
  const out: TarEntry[] = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] as number);
    if (sum !== readOctal(h, 148, 8)) throw new Error('tar: header checksum mismatch');
    const base = readStr(h, 0, 100);
    const prefix = readStr(h, 345, 155);
    const size = readOctal(h, 124, 12);
    const type = h[156];
    off += 512;
    if (off + size > buf.length) throw new Error('tar: truncated archive');
    if (type === 0x30 || type === 0) {
      out.push({
        name: prefix ? `${prefix}/${base}` : base,
        data: buf.slice(off, off + size),
        mtime: readOctal(h, 136, 12),
      });
    }
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

async function pipe(data: Uint8Array, t: { readable: ReadableStream; writable: WritableStream }) {
  const writer = t.writable.getWriter();
  const [out] = await Promise.all([
    new Response(t.readable).arrayBuffer(),
    writer.write(data).then(() => writer.close()),
  ]);
  return new Uint8Array(out);
}

export function gzip(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new CompressionStream('gzip'));
}

export function gunzip(data: Uint8Array): Promise<Uint8Array> {
  return pipe(data, new DecompressionStream('gzip'));
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
