import type { Logger } from "@beamhop/sdk";
import { jpegHasTrailer, pngHasPrivateText, stripMetadata, type StripResult } from "./exif";
import { Semaphore } from "./limits";

// Minimal structural type of the parts of sharp we use (sharp is optional and loaded dynamically).
interface SharpInstance {
  metadata(): Promise<{ exif?: unknown; xmp?: unknown; iptc?: unknown; orientation?: number; pages?: number; width?: number; height?: number; pageHeight?: number }>;
  rotate(): SharpInstance;
  resize(w: number, h: number, o: Record<string, unknown>): SharpInstance;
  jpeg(o?: Record<string, unknown>): SharpInstance;
  png(o?: Record<string, unknown>): SharpInstance;
  webp(o?: Record<string, unknown>): SharpInstance;
  avif?(o?: Record<string, unknown>): SharpInstance;
  tiff?(o?: Record<string, unknown>): SharpInstance;
  keepIccProfile?(): SharpInstance;
  toBuffer(): Promise<Uint8Array>;
}
type SharpFactory = (input: Uint8Array, opts?: Record<string, unknown>) => SharpInstance;

let sharpPromise: Promise<SharpFactory | undefined> | undefined;

/** Loads sharp if installed; resolves undefined otherwise (e.g. compiled binary without native modules). */
export function loadSharp(): Promise<SharpFactory | undefined> {
  sharpPromise ??= (async () => {
    try {
      const specifier = "sharp";
      const mod = (await import(/* @vite-ignore */ specifier)) as { default?: SharpFactory };
      const factory = (mod.default ?? mod) as SharpFactory;
      return typeof factory === "function" ? factory : undefined;
    } catch {
      return undefined;
    }
  })();
  return sharpPromise;
}

const STRIPPABLE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
/** Formats that commonly carry EXIF/GPS but that the pure-JS stripper can't rewrite: sharp re-encodes them. */
const REENCODE_TYPES = new Set(["image/avif", "image/heic", "image/heif", "image/tiff"]);

/** Crude check used when sharp is unavailable: does the file contain an EXIF/XMP payload at all? */
export function hasMetadataMarker(data: Uint8Array, mime: string): boolean {
  if (mime === "image/tiff") return true; // TIFF *is* an EXIF container; can't tell GPS-free files apart cheaply
  const needles = ["Exif\0\0", "http://ns.adobe.com/xap/"].map((n) => new TextEncoder().encode(n));
  return needles.some((needle) => indexOf(data, needle) >= 0);
}

function indexOf(hay: Uint8Array, needle: Uint8Array): number {
  const first = needle[0];
  for (let i = hay.indexOf(first); i >= 0 && i + needle.length <= hay.length; i = hay.indexOf(first, i + 1)) {
    let k = 1;
    while (k < needle.length && hay[i + k] === needle[k]) k++;
    if (k === needle.length) return i;
  }
  return -1;
}

/**
 * Decompression-bomb guard: images above this many pixels (≈ 7000×7000) are never decoded by sharp — a tiny
 * PNG can declare 16k×16k and cost ~1 GB of RAM to rotate/re-encode. Such files skip re-encoding (pure-JS
 * stripping still applies) and get no thumbnail.
 */
const MAX_DECODE_PIXELS = 50_000_000;
/** Concurrent sharp decode jobs (each can hold a few hundred MB at the pixel limit). */
const SHARP_CONCURRENCY = 2;

const THUMBNAIL_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/tiff", "image/heif", "image/heic"]);
const THUMBNAIL_SIZE = 320;

export interface ImageProcessor {
  /** true when sharp is available (re-encoding + thumbnails) */
  readonly sharp: boolean;
  stripMetadata(data: Uint8Array, mime: string): Promise<StripResult>;
  thumbnail(data: Uint8Array, mime: string): Promise<Uint8Array | undefined>;
}

/**
 * With sharp: images carrying EXIF/XMP/IPTC (or a non-default orientation) are re-encoded in the same
 * format with the orientation applied via `.rotate()` and all metadata dropped (ICC profile kept).
 * Clean images are left untouched so their hash doesn't change. Without sharp (or if it fails):
 * lossless pure-JS segment stripping (see exif.ts).
 */
export async function createImageProcessor(
  opts: { useSharp?: boolean; logger?: Logger; maxPixels?: number; concurrency?: number } = {},
): Promise<ImageProcessor> {
  const loaded = opts.useSharp === false ? undefined : await loadSharp();
  const log = opts.logger;
  const maxPixels = opts.maxPixels ?? MAX_DECODE_PIXELS;
  const gate = new Semaphore(opts.concurrency ?? SHARP_CONCURRENCY);
  // libvips refuses to decode beyond the limit even if a metadata check is bypassed (e.g. odd containers)
  const sharp: SharpFactory | undefined = loaded && ((input, o) => loaded(input, { limitInputPixels: maxPixels, ...o }));

  type Meta = Awaited<ReturnType<SharpInstance["metadata"]>>;
  /**
   * Header reads by buffer: an upload's bytes go through strip and then thumbnail, and when stripping leaves them
   * as they are (the usual case) the thumbnail reuses the first read. Weak, so it holds nothing past the upload.
   */
  const metaCache = new WeakMap<Uint8Array, Meta | undefined>();
  /** header-only read; undefined when the declared size is over the decode limit */
  async function decodableMeta(data: Uint8Array): Promise<Meta | undefined> {
    if (metaCache.has(data)) return metaCache.get(data);
    const meta = await readMeta(data);
    metaCache.set(data, meta);
    return meta;
  }
  async function readMeta(data: Uint8Array): Promise<Meta | undefined> {
    const meta = await sharp!(data).metadata();
    const w = meta.width ?? 0;
    const h = meta.pageHeight && (meta.pages ?? 1) > 1 ? meta.pageHeight * (meta.pages ?? 1) : (meta.height ?? 0);
    if (!w || !h || w * h > maxPixels) {
      log?.info("image too large to decode, skipping sharp", { width: w, height: h });
      return undefined;
    }
    return meta;
  }

  async function sharpStrip(data: Uint8Array, mime: string): Promise<StripResult | undefined> {
    if (!sharp) return undefined;
    try {
      const meta = await decodableMeta(data);
      if (!meta) return undefined;
      const rotated = (meta.orientation ?? 1) !== 1;
      if (!meta.exif && !meta.xmp && !meta.iptc && !rotated) return { data, stripped: false };
      const animated = (meta.pages ?? 1) > 1;
      let img = sharp(data, animated ? { animated: true } : undefined);
      if (!animated) img = img.rotate();
      if (img.keepIccProfile) img = img.keepIccProfile();
      img = mime === "image/jpeg" ? img.jpeg({ quality: 92 }) : mime === "image/png" ? img.png() : img.webp({ quality: 90 });
      return { data: new Uint8Array(await img.toBuffer()), stripped: true };
    } catch (err) {
      log?.warn("sharp metadata strip failed, falling back to pure-js", { error: String(err) });
      return undefined;
    }
  }

  /** AVIF/HEIC/HEIF/TIFF: re-encode with sharp when metadata is present (HEIC/HEIF → JPEG: no HEVC encoder). */
  async function sharpReencode(data: Uint8Array, mime: string): Promise<StripResult | undefined> {
    if (!sharp) return undefined;
    try {
      const meta = await decodableMeta(data);
      if (!meta) return undefined;
      const rotated = (meta.orientation ?? 1) !== 1;
      if (!meta.exif && !meta.xmp && !meta.iptc && !rotated) return { data, stripped: false };
      let img = sharp(data).rotate();
      if (img.keepIccProfile) img = img.keepIccProfile();
      let type = mime;
      if (mime === "image/avif" && img.avif) img = img.avif({ quality: 60 });
      else if (mime === "image/tiff" && img.tiff) img = img.tiff();
      else (img = img.jpeg({ quality: 92 })), (type = "image/jpeg");
      return { data: new Uint8Array(await img.toBuffer()), stripped: true, ...(type !== mime ? { type } : {}) };
    } catch (err) {
      log?.warn("sharp re-encode failed", { mime, error: String(err) });
      return undefined;
    }
  }

  return {
    sharp: !!sharp,
    async stripMetadata(data, mime) {
      if (REENCODE_TYPES.has(mime)) {
        const r = sharp ? await gate.run(() => sharpReencode(data, mime)) : undefined;
        if (r) return r;
        // No sharp, or it can't decode this file (prebuilt sharp has no HEVC decoder, so HEIC/HEIF with EXIF always
        // lands here): refuse rather than publish location data. The caller turns `unsafe` into a 415.
        return hasMetadataMarker(data, mime) ? { data, stripped: false, unsafe: true } : { data, stripped: false };
      }
      if (!STRIPPABLE_TYPES.has(mime)) return { data, stripped: false };
      const r = sharp ? await gate.run(() => sharpStrip(data, mime)) : undefined;
      if (r?.stripped) return r;
      if (r) {
        // sharp says clean, but it only looks at the primary image's metadata. libvips doesn't surface PNG
        // tEXt/zTXt/iTXt chunks, so an EXIF/XMP/IPTC profile smuggled in one (ImageMagick's "Raw profile type exif",
        // with GPS) still needs the pure-JS pass, and so does a JPEG with images appended after its EOI (MPF/MPO
        // secondary images carry their own EXIF). Anything else stays byte-identical so the client's sha256 keeps
        // matching.
        const hidden = mime === "image/png" ? pngHasPrivateText(data) : mime === "image/jpeg" && jpegHasTrailer(data);
        return hidden ? stripMetadata(data, mime) : r;
      }
      // sharp unavailable or the image is too large to decode: lossless pure-JS stripping (keeps orientation)
      return stripMetadata(data, mime);
    },
    async thumbnail(data, mime) {
      if (!sharp || !THUMBNAIL_TYPES.has(mime)) return undefined;
      return gate.run(async () => {
        try {
          if (!(await decodableMeta(data))) return undefined;
          const buf = await sharp(data)
            .rotate()
            .resize(THUMBNAIL_SIZE, THUMBNAIL_SIZE, { fit: "inside", withoutEnlargement: true })
            .webp({ quality: 75 })
            .toBuffer();
          return new Uint8Array(buf);
        } catch (err) {
          log?.debug("thumbnail generation failed", { error: String(err) });
          return undefined;
        }
      });
    },
  };
}
