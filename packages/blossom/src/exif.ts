/**
 * Pure-JS metadata strippers (no native deps). They remove privacy-sensitive metadata segments
 * losslessly without touching the image data:
 * - JPEG: APP1 (Exif / XMP), APP13 (Photoshop IRB / IPTC) and COM segments. ICC (APP2), JFIF (APP0)
 *   and Adobe (APP14) segments are kept. Note: the EXIF orientation is lost with the EXIF segment.
 * - PNG: eXIf, tEXt, zTXt, iTXt and tIME chunks.
 * - WebP: EXIF and XMP chunks (VP8X flags and RIFF size are updated).
 * Malformed input is returned unchanged.
 */

export interface StripResult {
  data: Uint8Array;
  stripped: boolean;
}

const unchanged = (data: Uint8Array): StripResult => ({ data, stripped: false });

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

const JPEG_STRIP_MARKERS = new Set([0xe1, 0xed, 0xfe]);

export function stripJpegMetadata(data: Uint8Array): StripResult {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return unchanged(data);
  const parts: Uint8Array[] = [data.subarray(0, 2)];
  let i = 2;
  let stripped = false;
  while (i < data.length) {
    if (data[i] !== 0xff) return unchanged(data);
    // skip fill bytes
    let j = i + 1;
    while (j < data.length && data[j] === 0xff) j++;
    if (j >= data.length) return unchanged(data);
    const marker = data[j];
    const segStart = j - 1;
    if (marker === 0xda || marker === 0xd9) {
      // start of scan / end of image: copy remainder verbatim
      parts.push(data.subarray(segStart));
      i = data.length;
      break;
    }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(data.subarray(segStart, j + 1));
      i = j + 1;
      continue;
    }
    if (j + 2 >= data.length) return unchanged(data);
    const len = (data[j + 1] << 8) | data[j + 2];
    const end = j + 1 + len;
    if (len < 2 || end > data.length) return unchanged(data);
    if (JPEG_STRIP_MARKERS.has(marker)) stripped = true;
    else parts.push(data.subarray(segStart, end));
    i = end;
  }
  return stripped ? { data: concat(parts), stripped } : unchanged(data);
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_STRIP_CHUNKS = new Set(["eXIf", "tEXt", "zTXt", "iTXt", "tIME"]);

export function stripPngMetadata(data: Uint8Array): StripResult {
  if (data.length < 8 || PNG_SIG.some((b, k) => data[k] !== b)) return unchanged(data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const parts: Uint8Array[] = [data.subarray(0, 8)];
  let i = 8;
  let stripped = false;
  while (i < data.length) {
    if (i + 12 > data.length) return unchanged(data);
    const len = view.getUint32(i);
    const type = String.fromCharCode(data[i + 4], data[i + 5], data[i + 6], data[i + 7]);
    const end = i + 12 + len;
    if (end > data.length) return unchanged(data);
    if (PNG_STRIP_CHUNKS.has(type)) stripped = true;
    else parts.push(data.subarray(i, end));
    i = end;
    if (type === "IEND") {
      if (i < data.length) stripped = true; // drop trailing garbage after IEND
      break;
    }
  }
  return stripped ? { data: concat(parts), stripped } : unchanged(data);
}

export function stripWebpMetadata(data: Uint8Array): StripResult {
  const tag = (o: number) => String.fromCharCode(data[o], data[o + 1], data[o + 2], data[o + 3]);
  if (data.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WEBP") return unchanged(data);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const parts: Uint8Array[] = [];
  let i = 12;
  let stripped = false;
  let vp8x: Uint8Array | undefined;
  const riffEnd = Math.min(data.length, 8 + view.getUint32(4, true));
  while (i < riffEnd) {
    if (i + 8 > riffEnd) return unchanged(data);
    const fourcc = tag(i);
    const size = view.getUint32(i + 4, true);
    const end = i + 8 + size + (size & 1);
    if (i + 8 + size > riffEnd) return unchanged(data);
    if (fourcc === "EXIF" || fourcc === "XMP ") stripped = true;
    else {
      const chunk = data.slice(i, Math.min(end, riffEnd));
      if (fourcc === "VP8X") vp8x = chunk;
      parts.push(chunk);
    }
    i = end;
  }
  if (!stripped) return unchanged(data);
  if (vp8x && vp8x.length > 8) vp8x[8] &= ~(0x08 | 0x04); // clear EXIF + XMP flags
  const body = concat(parts);
  const out = new Uint8Array(12 + body.length);
  out.set(data.subarray(0, 12));
  out.set(body, 12);
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
