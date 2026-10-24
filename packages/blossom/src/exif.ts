/**
 * Pure-JS metadata strippers (no native deps). They remove privacy-sensitive metadata segments
 * losslessly without touching the image data:
 * - JPEG: APP1 (Exif / XMP), APP13 (Photoshop IRB / IPTC) and COM segments. ICC (APP2), JFIF (APP0)
 *   and Adobe (APP14) segments are kept. A non-default EXIF orientation is carried over into a minimal
 *   APP1 holding only that tag, so the photo still displays upright.
 * - PNG: eXIf, tEXt, zTXt, iTXt and tIME chunks.
 * - WebP: EXIF and XMP chunks (VP8X flags and RIFF size are updated).
 * Malformed input is returned unchanged.
 *
 * The walkers only record the byte ranges to drop and then copy the spans between them once, so memory never grows
 * with the number of segments/chunks (a 100 MiB body of 2-byte JPEG markers once meant millions of views and
 * gigabytes of RSS); segment/chunk counts are capped as well.
 */

export interface StripResult {
  data: Uint8Array;
  stripped: boolean;
  /** set when stripping changed the format (e.g. HEIC re-encoded as JPEG) */
  type?: string;
  /** metadata may be present but could not be removed (caller should refuse the upload) */
  unsafe?: boolean;
}

const unchanged = (data: Uint8Array): StripResult => ({ data, stripped: false });

/** Header segments before the first scan; real files have tens (a split ICC profile adds at most 255). */
const MAX_JPEG_SEGMENTS = 4096;
/** PNG/WebP chunks; real files have a few plus one or two per IDAT block / animation frame. */
const MAX_CHUNKS = 100_000;

/** Appends [start, end) to ascending drop ranges (flat start/end pairs), merging it into an adjacent previous one. */
function drop(drops: number[], start: number, end: number) {
  if (drops.length && drops[drops.length - 1] === start) drops[drops.length - 1] = end;
  else drops.push(start, end);
}

/** `data[0, end)` without the `drops` ranges; `insert` goes where the range holding `insert.at` was. */
function excise(data: Uint8Array, drops: number[], end: number, insert?: { at: number; bytes: Uint8Array }): Uint8Array {
  let size = end + (insert?.bytes.byteLength ?? 0);
  for (let k = 0; k < drops.length; k += 2) size -= drops[k + 1] - drops[k];
  const out = new Uint8Array(size);
  let off = 0;
  let from = 0;
  for (let k = 0; k < drops.length; k += 2) {
    out.set(data.subarray(from, drops[k]), off);
    off += drops[k] - from;
    if (insert && insert.at >= drops[k] && insert.at < drops[k + 1]) {
      out.set(insert.bytes, off);
      off += insert.bytes.byteLength;
    }
    from = drops[k + 1];
  }
  out.set(data.subarray(from, end), off);
  return out;
}

const JPEG_STRIP_MARKERS = new Set([0xe1, 0xed, 0xfe]);
const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

/** Orientation (tag 0x0112) from an APP1 Exif payload (after the 2-byte length), or undefined. */
export function exifOrientation(payload: Uint8Array): number | undefined {
  if (payload.length < 14 || EXIF_HEADER.some((b, k) => payload[k] !== b)) return undefined;
  const tiff = payload.subarray(6);
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = String.fromCharCode(tiff[0], tiff[1]);
  if (order !== "II" && order !== "MM") return undefined;
  const le = order === "II";
  if (view.getUint16(2, le) !== 42) return undefined;
  const ifd = view.getUint32(4, le);
  if (ifd + 2 > tiff.length) return undefined;
  const count = view.getUint16(ifd, le);
  for (let k = 0; k < count; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > tiff.length) return undefined;
    if (view.getUint16(e, le) !== 0x0112) continue;
    if (view.getUint16(e + 2, le) !== 3) return undefined; // SHORT
    const v = view.getUint16(e + 8, le);
    return v >= 1 && v <= 8 ? v : undefined;
  }
  return undefined;
}

/** APP1 segment (marker included) with an Exif IFD0 holding only the orientation tag. */
function orientationSegment(orientation: number): Uint8Array {
  const out = new Uint8Array(2 + 2 + 6 + 26);
  const view = new DataView(out.buffer);
  out[0] = 0xff;
  out[1] = 0xe1;
  view.setUint16(2, out.length - 2); // segment length (excludes the marker)
  out.set(EXIF_HEADER, 4);
  const t = 10; // TIFF header, little-endian
  out.set([0x49, 0x49, 0x2a, 0x00], t);
  view.setUint32(t + 4, 8, true); // IFD0 right after the header
  view.setUint16(t + 8, 1, true); // one entry
  view.setUint16(t + 10, 0x0112, true);
  view.setUint16(t + 12, 3, true); // SHORT
  view.setUint32(t + 14, 1, true); // count
  view.setUint16(t + 18, orientation, true);
  view.setUint32(t + 22, 0, true); // no next IFD
  return out;
}

export function stripJpegMetadata(data: Uint8Array): StripResult {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return unchanged(data);
  const drops: number[] = [];
  let i = 2;
  let stripped = false;
  let orientation: { at: number; bytes: Uint8Array } | undefined;
  for (let n = 0; i < data.length; n++) {
    if (data[i] !== 0xff || n >= MAX_JPEG_SEGMENTS) return unchanged(data);
    // skip fill bytes (not copied)
    let j = i + 1;
    while (j < data.length && data[j] === 0xff) j++;
    if (j >= data.length) return unchanged(data);
    const marker = data[j];
    const segStart = j - 1;
    if (segStart > i) drop(drops, i, segStart);
    // start of scan / end of image: the remainder is kept verbatim
    if (marker === 0xda || marker === 0xd9) break;
    // standalone RST/TEM markers belong inside entropy-coded data, never between header segments
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) return unchanged(data);
    if (j + 2 >= data.length) return unchanged(data);
    const len = (data[j + 1] << 8) | data[j + 2];
    const end = j + 1 + len;
    if (len < 2 || end > data.length) return unchanged(data);
    if (JPEG_STRIP_MARKERS.has(marker)) {
      stripped = true;
      drop(drops, segStart, end);
      if (marker === 0xe1 && !orientation) {
        const o = exifOrientation(data.subarray(j + 3, end));
        // keep it where the EXIF segment was (right after SOI/APP0, before the frame header)
        if (o && o !== 1) orientation = { at: segStart, bytes: orientationSegment(o) };
      }
    }
    i = end;
  }
  return stripped ? { data: excise(data, drops, data.length, orientation), stripped } : unchanged(data);
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_STRIP_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);
/** text-chunk keywords that carry whole metadata profiles (ImageMagick/exiftool "Raw profile type …", XMP) */
const PNG_PROFILE_KEYWORD = /^(raw profile type |xml:com\.adobe\.xmp)/i;

/**
 * Whether a PNG has metadata a decoder-level check (libvips) misses: an eXIf chunk or a tEXt/zTXt/iTXt chunk
 * holding an EXIF/XMP/IPTC profile. Ordinary text chunks (Software, Comment, …) don't count.
 */
export function pngHasPrivateText(data: Uint8Array): boolean {
  if (data.length < 8 || PNG_SIG.some((b, k) => data[k] !== b)) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 8; i + 12 <= data.length; ) {
    const len = view.getUint32(i);
    const type = String.fromCharCode(data[i + 4], data[i + 5], data[i + 6], data[i + 7]);
    if (type === "eXIf") return true;
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const body = data.subarray(i + 8, Math.min(i + 8 + len, i + 8 + 80, data.length));
      const nul = body.indexOf(0);
      const keyword = String.fromCharCode(...body.subarray(0, nul < 0 ? body.length : nul));
      if (PNG_PROFILE_KEYWORD.test(keyword)) return true;
    }
    if (type === "IEND") break;
    i += 12 + len;
  }
  return false;
}

export function stripPngMetadata(data: Uint8Array): StripResult {
  if (data.length < 8 || PNG_SIG.some((b, k) => data[k] !== b)) return unchanged(data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const drops: number[] = [];
  let i = 8;
  for (let n = 0; i < data.length; n++) {
    if (i + 12 > data.length || n >= MAX_CHUNKS) return unchanged(data);
    const len = view.getUint32(i);
    const type = String.fromCharCode(data[i + 4], data[i + 5], data[i + 6], data[i + 7]);
    const end = i + 12 + len;
    if (end > data.length) return unchanged(data);
    if (PNG_STRIP_CHUNKS.has(type)) drop(drops, i, end);
    i = end;
    if (type === "IEND") {
      if (i < data.length) drop(drops, i, data.length); // drop trailing garbage after IEND
      break;
    }
  }
  return drops.length ? { data: excise(data, drops, data.length), stripped: true } : unchanged(data);
}

export function stripWebpMetadata(data: Uint8Array): StripResult {
  const tag = (o: number) => String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3]);
  if (data.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WEBP") return unchanged(data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const drops: number[] = [];
  let dropped = 0;
  let vp8xFlags = -1; // output offset of the last VP8X chunk's flags byte
  let i = 12;
  const riffEnd = Math.min(data.length, 8 + view.getUint32(4, true));
  for (let n = 0; i < riffEnd; n++) {
    if (i + 8 > riffEnd || n >= MAX_CHUNKS) return unchanged(data);
    const fourcc = tag(i);
    const size = view.getUint32(i + 4, true);
    const end = Math.min(i + 8 + size + (size & 1), riffEnd);
    if (i + 8 + size > riffEnd) return unchanged(data);
    if (fourcc === "EXIF" || fourcc === "XMP ") {
      drop(drops, i, end);
      dropped += end - i;
    } else if (fourcc === "VP8X") vp8xFlags = end - i > 8 ? i + 8 - dropped : -1;
    i = end;
  }
  if (!drops.length) return unchanged(data);
  // anything past the RIFF size is dropped too
  const out = excise(data, drops, riffEnd);
  if (vp8xFlags >= 0) out[vp8xFlags] &= ~(0x08 | 0x04); // clear EXIF + XMP flags
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return { data: out, stripped: true };
}

export function stripMetadata(data: Uint8Array, mime: string): StripResult {
  switch (mime) {
    case "image/jpeg":
      return stripJpegMetadata(data);
    case "image/png":
      return stripPngMetadata(data);
    case "image/webp":
      return stripWebpMetadata(data);
    default:
      return unchanged(data);
  }
}
