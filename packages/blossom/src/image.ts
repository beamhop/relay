import type { Logger } from "@beamhop/sdk";
import { stripMetadata, type StripResult } from "./exif";

// Minimal structural type of the parts of sharp we use (sharp is optional and loaded dynamically).
interface SharpInstance {
  metadata(): Promise<{ exif?: unknown; xmp?: unknown; iptc?: unknown; orientation?: number; pages?: number }>;
  rotate(): SharpInstance;
  resize(w: number, h: number, o: Record<string, unknown>): SharpInstance;
  jpeg(o?: Record<string, unknown>): SharpInstance;
  png(o?: Record<string, unknown>): SharpInstance;
  webp(o?: Record<string, unknown>): SharpInstance;
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

export const STRIPPABLE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const THUMBNAIL_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif", "image/tiff", "image/heif", "image/heic"]);
export const THUMBNAIL_SIZE = 320;

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
export async function createImageProcessor(opts: { useSharp?: boolean; logger?: Logger } = {}): Promise<ImageProcessor> {
  const sharp = opts.useSharp === false ? undefined : await loadSharp();
  const log = opts.logger;

  async function sharpStrip(data: Uint8Array, mime: string): Promise<StripResult | undefined> {
    if (!sharp) return undefined;
    try {
      const meta = await sharp(data).metadata();
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

  return {
    sharp: !!sharp,
    async stripMetadata(data, mime) {
      if (!STRIPPABLE_TYPES.has(mime)) return { data, stripped: false };
      return (await sharpStrip(data, mime)) ?? stripMetadata(data, mime);
    },
    async thumbnail(data, mime) {
      if (!sharp || !THUMBNAIL_TYPES.has(mime)) return undefined;
      try {
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
    },
  };
}
