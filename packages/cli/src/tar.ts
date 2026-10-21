// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Minimal streaming ustar writer/reader (+ gzip) for backups and moves, so the
 * single binary needs no `tar` on the host. Files are streamed from/to disk;
 * extraction rejects absolute paths, `..` and links (path traversal).
 */
import {
  closeSync,
  createReadStream,
  createWriteStream,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';

const BLOCK = 512;
const enc = new TextEncoder();
const dec = new TextDecoder();

function octal(n: number, len: number): string {
  return `${n.toString(8).padStart(len - 1, '0')}\0`;
}

function splitName(path: string): { name: string; prefix: string } {
  const bytes = enc.encode(path);
  if (bytes.length <= 100) return { name: path, prefix: '' };
  const idx = path.lastIndexOf('/', path.length - 1);
  for (let i = idx; i > 0; i = path.lastIndexOf('/', i - 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (enc.encode(prefix).length <= 155 && enc.encode(name).length <= 100) return { name, prefix };
  }
  throw new Error(`path too long for the archive: ${path}`);
}

function header(
  path: string,
  size: number,
  mode: number,
  mtime: number,
  type: '0' | '5',
): Uint8Array {
  const h = new Uint8Array(BLOCK);
  const put = (s: string, off: number, len: number) => h.set(enc.encode(s).subarray(0, len), off);
  const { name, prefix } = splitName(path);
  put(name, 0, 100);
  put(octal(mode & 0o7777, 8), 100, 8);
  put(octal(0, 8), 108, 8);
  put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(Math.floor(mtime), 12), 136, 12);
  put('        ', 148, 8);
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

export class TarWriter {
  private fd: number;
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, 'w', 0o600);
  }

  private write(b: Uint8Array) {
    let off = 0;
    while (off < b.length) off += writeSync(this.fd, b, off, b.length - off);
  }

  private pad(size: number) {
    const rem = size % BLOCK;
    if (rem) this.write(new Uint8Array(BLOCK - rem));
  }

  addBytes(path: string, data: Uint8Array, mode = 0o644, mtime = Date.now() / 1000): void {
    this.write(header(path, data.length, mode, mtime, '0'));
    this.write(data);
    this.pad(data.length);
  }

  /** Stream a file into the archive; returns its SHA-256 (hex) and size. */
  addFile(path: string, file: string, mode?: number): { sha256: string; size: number } {
    const st = statSync(file);
    const hasher = new Bun.CryptoHasher('sha256');
    this.write(header(path, st.size, mode ?? st.mode, st.mtimeMs / 1000, '0'));
    const src = openSync(file, 'r');
    const buf = new Uint8Array(1 << 20);
    let left = st.size;
    try {
      while (left > 0) {
        const n = readSync(src, buf, 0, Math.min(buf.length, left), null);
        if (n <= 0) throw new Error(`${file} changed while archiving`);
        const chunk = buf.subarray(0, n);
        hasher.update(chunk);
        this.write(chunk);
        left -= n;
      }
    } finally {
      closeSync(src);
    }
    this.pad(st.size);
    return { sha256: hasher.digest('hex'), size: st.size };
  }

  close(): void {
    this.write(new Uint8Array(BLOCK * 2));
    closeSync(this.fd);
  }
}

export interface TarEntry {
  path: string;
  size: number;
  mode: number;
  type: 'file' | 'dir' | 'other';
}

function parseHeader(h: Uint8Array): TarEntry | null {
  if (h.every((b) => b === 0)) return null;
  const str = (off: number, len: number) => {
    const s = h.subarray(off, off + len);
    const end = s.indexOf(0);
    return dec.decode(end === -1 ? s : s.subarray(0, end));
  };
  const num = (off: number, len: number) => Number.parseInt(str(off, len).trim() || '0', 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!;
  if (sum !== num(148, 8)) throw new Error('the archive is damaged (bad header checksum)');
  const prefix = str(345, 155);
  const name = str(0, 100);
  const flag = str(156, 1);
  return {
    path: prefix ? `${prefix}/${name}` : name,
    size: num(124, 12),
    mode: num(100, 8),
    type: flag === '0' || flag === '' ? 'file' : flag === '5' ? 'dir' : 'other',
  };
}

/** Iterate entries; `onFile` receives a reader for the entry's bytes (call it to consume). */
export function readTar(
  path: string,
  onEntry: (e: TarEntry, read: (sink: (chunk: Uint8Array) => void) => void) => void,
): void {
  const fd = openSync(path, 'r');
  const h = new Uint8Array(BLOCK);
  let pos = 0;
  try {
    for (;;) {
      if (readSync(fd, h, 0, BLOCK, pos) < BLOCK) break;
      pos += BLOCK;
      const e = parseHeader(h);
      if (!e) break;
      const start = pos;
      onEntry(e, (sink) => {
        const buf = new Uint8Array(1 << 20);
        let left = e.size;
        let p = start;
        while (left > 0) {
          const n = readSync(fd, buf, 0, Math.min(buf.length, left), p);
          if (n <= 0) throw new Error('the archive is truncated');
          sink(buf.subarray(0, n));
          left -= n;
          p += n;
        }
      });
      pos = start + Math.ceil(e.size / BLOCK) * BLOCK;
    }
  } finally {
    closeSync(fd);
  }
}

/** Reject anything that could escape the destination directory. */
export function safeJoin(root: string, entryPath: string): string {
  const n = normalize(entryPath);
  if (isAbsolute(entryPath) || n.split(/[\\/]/).includes('..') || n.startsWith(sep))
    throw new Error(`refusing unsafe path in archive: ${entryPath}`);
  return join(root, n);
}

export function extractFile(
  read: (sink: (chunk: Uint8Array) => void) => void,
  dest: string,
  mode: number,
): void {
  mkdirSync(dirname(dest), { recursive: true });
  const fd = openSync(dest, 'w', mode & 0o777 || 0o644);
  try {
    read((chunk) => {
      let off = 0;
      while (off < chunk.length) off += writeSync(fd, chunk, off, chunk.length - off);
    });
  } finally {
    closeSync(fd);
  }
}

export async function gzipFile(src: string, dest: string): Promise<void> {
  await pipeline(
    createReadStream(src),
    createGzip({ level: 6 }),
    createWriteStream(dest, { mode: 0o600 }),
  );
}

export async function gunzipFile(src: string, dest: string): Promise<void> {
  await pipeline(createReadStream(src), createGunzip(), createWriteStream(dest, { mode: 0o600 }));
}

/** Open `.tar` or `.tar.gz` as a plain tar path (gunzipping to `tmp` if needed). */
export async function asPlainTar(
  path: string,
  tmp: string,
): Promise<{ tar: string; cleanup(): void }> {
  const fd = openSync(path, 'r');
  const magic = new Uint8Array(2);
  readSync(fd, magic, 0, 2, 0);
  closeSync(fd);
  if (magic[0] === 0x1f && magic[1] === 0x8b) {
    await gunzipFile(path, tmp);
    return { tar: tmp, cleanup: () => rmSync(tmp, { force: true }) };
  }
  return { tar: path, cleanup: () => {} };
}
