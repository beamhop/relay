/**
 * Pure-JS metadata strippers (no native deps). They remove privacy-sensitive metadata segments
 * losslessly without touching the image data:
 * - JPEG: APP1 (Exif / XMP), APP13 (Photoshop IRB / IPTC) and COM segments, plus everything after the primary
 *   image's EOI (MPF/MPO secondary images carry their own EXIF) and then the MPF index (APP2). ICC (APP2), JFIF
 *   (APP0) and Adobe (APP14) segments are kept. A non-default EXIF orientation is carried over into a minimal
 *   APP1 holding only that tag, so the photo still displays upright.
 * - PNG: eXIf, tEXt, zTXt, iTXt and tIME chunks.
 * - WebP: EXIF and XMP chunks (VP8X flags and RIFF size are updated).
 * Malformed input is returned unchanged (`hasLeftoverMetadata` tells the caller whether that left metadata behind).
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

const MPF_HEADER = [0x4d, 0x50, 0x46, 0x00]; // "MPF\0"

interface JpegScan {
  /** header ranges to drop (fill bytes, metadata segments) */
  drops: number[];
  /** whether a metadata segment (EXIF/XMP, IPTC, comment) was found */
  metadata: boolean;
  /** a minimal APP1 carrying a non-default EXIF orientation */
  orientation?: { at: number; bytes: Uint8Array };
  /** [start, end) of an APP2 MPF segment (the index of images appended after the primary EOI) */
  mpf?: [number, number];
  /** offset just past the primary image's EOI; -1 when the image is truncated or the scan data malformed */
  end: number;
}

/** Walks the header segments of a JPEG and finds where its primary image ends; undefined when malformed. */
function scanJpeg(data: Uint8Array): JpegScan | undefined {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return undefined;
  const scan: JpegScan = { drops: [], metadata: false, end: -1 };
  let i = 2;
  for (let n = 0; i < data.length; n++) {
    if (data[i] !== 0xff || n >= MAX_JPEG_SEGMENTS) return undefined;
    // skip fill bytes (not copied)
    let j = i + 1;
    while (j < data.length && data[j] === 0xff) j++;
    if (j >= data.length) return undefined;
    const marker = data[j];
    const segStart = j - 1;
    if (segStart > i) drop(scan.drops, i, segStart);
    if (marker === 0xd9) {
      scan.end = j + 1;
      break;
    }
    if (marker === 0xda) {
      scan.end = primaryEnd(data, segStart, scan);
      break;
    }
    // standalone RST/TEM markers belong inside entropy-coded data, never between header segments
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) return undefined;
    if (j + 2 >= data.length) return undefined;
    const len = (data[j + 1] << 8) | data[j + 2];
    const end = j + 1 + len;
    if (len < 2 || end > data.length) return undefined;
    if (JPEG_STRIP_MARKERS.has(marker)) {
      scan.metadata = true;
      drop(scan.drops, segStart, end);
      if (marker === 0xe1 && !scan.orientation) {
        const o = exifOrientation(data.subarray(j + 3, end));
        // keep it where the EXIF segment was (right after SOI/APP0, before the frame header)
        if (o && o !== 1) scan.orientation = { at: segStart, bytes: orientationSegment(o) };
      }
    } else if (marker === 0xe2 && !scan.mpf && len >= 6 && MPF_HEADER.every((b, k) => data[j + 3 + k] === b)) {
      scan.mpf = [segStart, end];
    }
    i = end;
  }
  return scan;
}

/**
 * Offset just past the EOI of the image whose first SOS marker is at `sos`: entropy-coded data runs until a marker
 * other than byte stuffing (FF00) or a restart (RSTn); progressive scans are separated by length-delimited segments
 * (DHT, SOS, …). -1 when it never ends (truncated) or is malformed. One pass, no allocation. Metadata segments
 * between those scans (decoders read them; an APP1 there carries EXIF like one in the header) are added to `scan`'s
 * drops.
 */
function primaryEnd(data: Uint8Array, sos: number, scan: JpegScan): number {
  let i = sos;
  for (let n = 0; n < MAX_JPEG_SEGMENTS; n++) {
    // i: the FF of a length-delimited segment
    if (i + 3 >= data.length) return -1;
    const marker = data[i + 1];
    const len = (data[i + 2] << 8) | data[i + 3];
    let j = i + 2 + len;
    if (len < 2 || j > data.length) return -1;
    if (JPEG_STRIP_MARKERS.has(marker)) {
      scan.metadata = true;
      drop(scan.drops, i, j);
    }
    if (marker === 0xda) {
      for (;;) {
        j = data.indexOf(0xff, j);
        if (j < 0 || j + 1 >= data.length) return -1;
        const next = data[j + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) j++;
        else break;
      }
    }
    while (j + 1 < data.length && data[j] === 0xff && data[j + 1] === 0xff) j++; // fill bytes before a marker
    if (data[j] !== 0xff || j + 1 >= data.length) return -1;
    const next = data[j + 1];
    if (next === 0xd9) return j + 2;
    if ((next >= 0xd0 && next <= 0xd7) || next === 0x01 || next === 0xd8 || next === 0x00) return -1;
    i = j;
  }
  return -1;
}

/** Whether a JPEG carries data after its primary image (MPF/MPO secondary images, vendor trailers). */
export function jpegHasTrailer(data: Uint8Array): boolean {
  const scan = scanJpeg(data);
  return !!scan && scan.end > 0 && scan.end < data.length;
}

/**
 * Anything after the primary image's EOI is dropped too: MPF/MPO secondary images (previews, stereo pairs, depth or
 * HDR gain maps) carry their own EXIF, often with GPS. The primary's MPF index then points nowhere, so it goes too.
 */
export function stripJpegMetadata(data: Uint8Array): StripResult {
  const scan = scanJpeg(data);
  if (!scan) return unchanged(data);
  const { orientation, mpf, end } = scan;
  let drops = scan.drops;
  if (end > 0 && end < data.length) {
    if (mpf) {
      // merge the MPF segment into the (ascending) header drops; it overlaps none of them
      const pairs: [number, number][] = [mpf];
      for (let k = 0; k < drops.length; k += 2) pairs.push([drops[k], drops[k + 1]]);
      pairs.sort((a, b) => a[0] - b[0]);
      drops = [];
      for (const [from, to] of pairs) drop(drops, from, to);
    }
    drop(drops, end, data.length);
  } else if (!scan.metadata) return unchanged(data);
  return { data: excise(data, drops, data.length, orientation), stripped: true };
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

const EXIF_NEEDLE = Uint8Array.from(EXIF_HEADER);
const XMP_NAMESPACE = new TextEncoder().encode("http://ns.adobe.com/xap/");

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  const first = needle[0];
  for (let i = hay.indexOf(first); i >= 0 && i + needle.length <= hay.length; i = hay.indexOf(first, i + 1)) {
    let k = 1;
    while (k < needle.length && hay[i + k] === needle[k]) k++;
    if (k === needle.length) return i;
  }
  return -1;
}

/** Whether a WebP has an EXIF or XMP chunk; tolerant of a truncated or oversized last chunk. */
function webpHasMetadataChunk(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 12, n = 0; i + 8 <= data.length && n < MAX_CHUNKS; n++) {
    const fourcc = String.fromCharCode(data[i], data[i + 1], data[i + 2], data[i + 3]);
    if (fourcc === "EXIF" || fourcc === "XMP ") return true;
    const size = view.getUint32(i + 4, true);
    i += 8 + size + (size & 1);
  }
  return false;
}

/**
 * Whether JPEG/PNG/WebP bytes still carry EXIF/XMP: the check behind "strip or refuse". The walkers above give up
 * on input they consider malformed (junk between JPEG segments, a stray marker, an over-long last chunk) and hand it
 * back unchanged, though decoders read such files fine, metadata included.
 */
export function hasLeftoverMetadata(data: Uint8Array, mime: string): boolean {
  if (mime === "image/png" && pngHasPrivateText(data)) return true;
  if (mime === "image/webp" && webpHasMetadataChunk(data)) return true;
  return indexOf(data, EXIF_NEEDLE) >= 0 || indexOf(data, XMP_NAMESPACE) >= 0;
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
