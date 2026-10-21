// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Image container parsing without decoding pixels (runtime-agnostic, no deps):
 *
 * - `sniffImage`: format from magic bytes (the declared content type may lie).
 * - `imageInfo`: pixel size, EXIF orientation and animation from the headers, so the
 *   decompression-bomb guard runs before any decoder allocates memory.
 * - `stripContainerMetadata`: lossless removal of EXIF/GPS/XMP/ICC/comments by
 *   dropping container segments/chunks; pixels are untouched (also keeps animation).
 */

export type ImageFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'gif';

export interface ImageInfo {
  format: ImageFormat;
  /** Stored pixel size (before EXIF orientation). */
  width: number;
  height: number;
  /** EXIF orientation 1..8 (1 = as stored). */
  orientation: number;
  /** More than one frame (GIF, animated WebP, APNG). */
  animated: boolean;
}

const MIME: Record<ImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
};

export const mimeOf = (f: ImageFormat): string => MIME[f];

/** `image/webp` | `webp` | `jpg` → format; unknown → undefined. */
export function imageFormat(f: string | undefined): ImageFormat | undefined {
  if (!f) return undefined;
  const k = f.toLowerCase().replace(/^image\//, '');
  if (k === 'jpg') return 'jpeg';
  return k in MIME ? (k as ImageFormat) : undefined;
}

const ascii = (b: Uint8Array, at: number, s: string): boolean => {
  if (at + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
};
const u16be = (b: Uint8Array, i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
const u16le = (b: Uint8Array, i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, i: number) => u16le(b, i) | ((b[i + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, i: number) => u16be(b, i) * 0x10000 + u16be(b, i + 2);
const u32le = (b: Uint8Array, i: number) => u16le(b, i) + u16le(b, i + 2) * 0x10000;

export function sniffImage(b: Uint8Array): ImageFormat | undefined {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(b, 0, '\x89PNG\r\n\x1a\n')) return 'png';
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'webp';
  if (ascii(b, 0, 'GIF87a') || ascii(b, 0, 'GIF89a')) return 'gif';
  if (ascii(b, 4, 'ftyp')) {
    const end = Math.min(b.length, u32be(b, 0));
    for (let i = 8; i + 4 <= end; i += 4) {
      if (ascii(b, i, 'avif') || ascii(b, i, 'avis')) return 'avif';
    }
  }
  return undefined;
}

/** Orientation tag (0x0112) of a TIFF/EXIF block starting at `at`; 1 when absent. */
export function exifOrientation(b: Uint8Array, at = 0): number {
  const le = ascii(b, at, 'II');
  if (!le && !ascii(b, at, 'MM')) return 1;
  const r16 = (i: number) => (le ? u16le(b, at + i) : u16be(b, at + i));
  const r32 = (i: number) => (le ? u32le(b, at + i) : u32be(b, at + i));
  const ifd = r32(4);
  const n = r16(ifd);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (at + e + 12 > b.length) break;
    if (r16(e) === 0x0112) {
      const v = r16(e + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

function jpegInfo(b: Uint8Array): ImageInfo | undefined {
  let orientation = 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return undefined;
    const m = b[i + 1] ?? 0;
    if (m === 0xff) {
      i++;
      continue;
    }
    const len = u16be(b, i + 2);
    if (m === 0xe1 && ascii(b, i + 4, 'Exif\0\0')) orientation = exifOrientation(b, i + 10);
    // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC).
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return {
        format: 'jpeg',
        height: u16be(b, i + 5),
        width: u16be(b, i + 7),
        orientation,
        animated: false,
      };
    }
    if (m === 0xda) return undefined;
    i += 2 + len;
  }
  return undefined;
}

function pngInfo(b: Uint8Array): ImageInfo | undefined {
  if (!ascii(b, 12, 'IHDR')) return undefined;
  const info: ImageInfo = {
    format: 'png',
    width: u32be(b, 16),
    height: u32be(b, 20),
    orientation: 1,
    animated: false,
  };
  for (let i = 8; i + 8 <= b.length; ) {
    const len = u32be(b, i);
    if (ascii(b, i + 4, 'acTL')) info.animated = u32be(b, i + 8) > 1;
    if (ascii(b, i + 4, 'eXIf')) info.orientation = exifOrientation(b, i + 8);
    if (ascii(b, i + 4, 'IDAT') || ascii(b, i + 4, 'IEND')) break;
    i += 12 + len;
  }
  return info;
}

function webpInfo(b: Uint8Array): ImageInfo | undefined {
  const info: ImageInfo = { format: 'webp', width: 0, height: 0, orientation: 1, animated: false };
  for (let i = 12; i + 8 <= b.length; ) {
    const len = u32le(b, i + 4);
    const d = i + 8;
    if (ascii(b, i, 'VP8X')) {
      info.animated = ((b[d] ?? 0) & 0x02) !== 0;
      info.width = u24le(b, d + 4) + 1;
      info.height = u24le(b, d + 7) + 1;
    } else if (ascii(b, i, 'VP8 ') && !info.width) {
      info.width = u16le(b, d + 6) & 0x3fff;
      info.height = u16le(b, d + 8) & 0x3fff;
    } else if (ascii(b, i, 'VP8L') && !info.width) {
      const bits = u32le(b, d + 1);
      info.width = (bits & 0x3fff) + 1;
      info.height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (ascii(b, i, 'EXIF')) {
      // Some writers keep the JPEG "Exif\0\0" prefix inside the chunk.
      info.orientation = exifOrientation(b, ascii(b, d, 'Exif\0\0') ? d + 6 : d);
    }
    i = d + len + (len & 1);
  }
  return info.width ? info : undefined;
}

function gifInfo(b: Uint8Array): ImageInfo | undefined {
  let frames = 0;
  walkGif(b, (kind) => {
    if (kind === 'image') frames++;
    return true;
  });
  return {
    format: 'gif',
    width: u16le(b, 6),
    height: u16le(b, 8),
    orientation: 1,
    animated: frames > 1,
  };
}

function avifInfo(b: Uint8Array): ImageInfo | undefined {
  // The primary item's `ispe` (image spatial extents) property; the first one wins.
  for (let i = 4; i + 16 <= b.length; i++) {
    if (ascii(b, i, 'ispe')) {
      return {
        format: 'avif',
        width: u32be(b, i + 8),
        height: u32be(b, i + 12),
        orientation: 1,
        // `avis` major brand = image sequence.
        animated: ascii(b, 8, 'avis'),
      };
    }
  }
  return undefined;
}

/** Header facts of a supported image, or undefined when the bytes are not one. */
export function imageInfo(b: Uint8Array): ImageInfo | undefined {
  switch (sniffImage(b)) {
    case 'jpeg':
      return jpegInfo(b);
    case 'png':
      return pngInfo(b);
    case 'webp':
      return webpInfo(b);
    case 'gif':
      return gifInfo(b);
    case 'avif':
      return avifInfo(b);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- lossless strip

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Keep JFIF (APP0) and Adobe (APP14, colour transform); drop APP1..APP13/APP15 and comments. */
function stripJpeg(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error('Malformed JPEG');
    const m = b[i + 1] ?? 0;
    if (m === 0xda) {
      parts.push(b.subarray(i));
      return concat(parts);
    }
    const end = i + 2 + u16be(b, i + 2);
    const drop = (m >= 0xe1 && m <= 0xef && m !== 0xee) || m === 0xfe;
    if (!drop) parts.push(b.subarray(i, end));
    i = end;
  }
  throw new Error('Malformed JPEG');
}

const PNG_KEEP = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'IEND',
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
  'sBIT',
  'bKGD',
  'pHYs',
  'acTL',
  'fcTL',
  'fdAT',
]);

function stripPng(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  for (let i = 8; i + 12 <= b.length; ) {
    const end = i + 12 + u32be(b, i);
    const type = String.fromCharCode(...b.subarray(i + 4, i + 8));
    if (PNG_KEEP.has(type)) parts.push(b.subarray(i, end));
    if (type === 'IEND') break;
    i = end;
  }
  return concat(parts);
}

const WEBP_KEEP = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);

function stripWebp(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  for (let i = 12; i + 8 <= b.length; ) {
    const len = u32le(b, i + 4);
    const end = Math.min(b.length, i + 8 + len + (len & 1));
    const type = String.fromCharCode(...b.subarray(i, i + 4));
    if (WEBP_KEEP.has(type)) {
      const chunk = b.slice(i, end);
      // VP8X flags: clear ICC (0x20), EXIF (0x08) and XMP (0x04).
      if (type === 'VP8X') chunk[8] = (chunk[8] ?? 0) & ~(0x20 | 0x08 | 0x04);
      parts.push(chunk);
    }
    i = end;
  }
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(b.subarray(0, 12));
  new DataView(out.buffer).setUint32(4, 4 + body.length, true);
  out.set(body, 12);
  return out;
}

type GifBlock = 'header' | 'image' | 'ext' | 'trailer';

/**
 * Walk GIF blocks; `visit(kind, start, end, label)` returns whether to keep the block.
 * Returns the kept byte ranges.
 */
function walkGif(
  b: Uint8Array,
  visit: (kind: GifBlock, start: number, end: number, label?: number) => boolean,
): Array<[number, number]> {
  const kept: Array<[number, number]> = [];
  const keep = (k: GifBlock, s: number, e: number, l?: number) => {
    if (visit(k, s, e, l)) kept.push([s, e]);
  };
  const subBlocks = (start: number) => {
    let i = start;
    while (i < b.length) {
      const n = b[i] ?? 0;
      i += 1 + n;
      if (n === 0) break;
    }
    return i;
  };
  const flags = b[10] ?? 0;
  let i = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);
  keep('header', 0, i);
  while (i < b.length) {
    const intro = b[i];
    if (intro === 0x3b) {
      keep('trailer', i, i + 1);
      break;
    }
    if (intro === 0x21) {
      const end = subBlocks(i + 2);
      keep('ext', i, end, b[i + 1]);
      i = end;
    } else if (intro === 0x2c) {
      const f = b[i + 9] ?? 0;
      const lzw = i + 10 + (f & 0x80 ? 3 * 2 ** ((f & 7) + 1) : 0);
      const end = subBlocks(lzw + 1);
      keep('image', i, end);
      i = end;
    } else break;
  }
  return kept;
}

/** Drop comments and application extensions other than the loop count (NETSCAPE2.0 / ANIMEXTS1.0). */
function stripGif(b: Uint8Array): Uint8Array {
  const ranges = walkGif(b, (kind, s, _e, label) => {
    if (kind !== 'ext') return true;
    if (label === 0xfe) return false;
    if (label === 0xff) return ascii(b, s + 3, 'NETSCAPE2.0') || ascii(b, s + 3, 'ANIMEXTS1.0');
    return true;
  });
  return concat(ranges.map(([s, e]) => b.subarray(s, e)));
}

/**
 * Remove metadata without re-encoding. Supported for JPEG, PNG, WebP and GIF;
 * throws for other formats (AVIF metadata lives in item boxes: re-encode instead).
 */
export function stripContainerMetadata(b: Uint8Array, format: ImageFormat): Uint8Array {
  switch (format) {
    case 'jpeg':
      return stripJpeg(b);
    case 'png':
      return stripPng(b);
    case 'webp':
      return stripWebp(b);
    case 'gif':
      return stripGif(b);
    default:
      throw new Error(`Cannot strip ${format} metadata without re-encoding`);
  }
}
