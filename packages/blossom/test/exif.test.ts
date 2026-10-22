import { describe, expect, test } from "bun:test";
import { createImageProcessor, loadSharp, stripJpegMetadata, stripPngMetadata, stripWebpMetadata } from "../src";
import { PNG_1x1, jpegWithExif } from "./fakes";

const has = (hay: Uint8Array, needle: string) => Buffer.from(hay).includes(Buffer.from(needle));

describe("pure-js metadata stripping", () => {
  test("removes JPEG APP1/COM segments and keeps the rest byte-identical", () => {
    const { withExif, withoutExif } = jpegWithExif();
    expect(has(withExif, "GPS")).toBe(true);
    const r = stripJpegMetadata(withExif);
    expect(r.stripped).toBe(true);
    expect(has(r.data, "GPS")).toBe(false);
    expect(has(r.data, "secret")).toBe(false);
    expect([...r.data]).toEqual([...withoutExif]);
    // idempotent
    expect(stripJpegMetadata(r.data).stripped).toBe(false);
  });

  test("leaves non-JPEG / malformed input untouched", () => {
    const junk = Uint8Array.from([0xff, 0xd8, 0x00, 0x01]);
    expect(stripJpegMetadata(junk)).toEqual({ data: junk, stripped: false });
    expect(stripJpegMetadata(PNG_1x1).stripped).toBe(false);
  });

  test("removes PNG text/eXIf chunks", () => {
    // insert a tEXt chunk after IHDR (8 sig + 25 IHDR)
    const payload = Buffer.from("Comment\0secret location");
    const chunk = Buffer.alloc(12 + payload.length);
    chunk.writeUInt32BE(payload.length, 0);
    chunk.write("tEXt", 4, "ascii");
    payload.copy(chunk, 8);
    const png = Buffer.concat([PNG_1x1.subarray(0, 33), chunk, PNG_1x1.subarray(33)]);
    const r = stripPngMetadata(new Uint8Array(png));
    expect(r.stripped).toBe(true);
    expect([...r.data]).toEqual([...PNG_1x1]);
  });

  test("removes WebP EXIF chunk and updates header", () => {
    const chunk = (fourcc: string, data: Buffer) => {
      const h = Buffer.alloc(8);
      h.write(fourcc, 0, "ascii");
      h.writeUInt32LE(data.length, 4);
      return Buffer.concat([h, data, data.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x08 | 0x04;
    const body = Buffer.concat([Buffer.from("WEBP"), chunk("VP8X", vp8x), chunk("VP8L", Buffer.from([1, 2, 3])), chunk("EXIF", Buffer.from("GPS data")), chunk("XMP ", Buffer.from("<x/>"))]);
    const riff = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), body]);
    riff.writeUInt32LE(riff.length - 8, 4);
    const r = stripWebpMetadata(new Uint8Array(riff));
    expect(r.stripped).toBe(true);
    const out = Buffer.from(r.data);
    expect(out.includes("GPS")).toBe(false);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out[20] & 0x0c).toBe(0);
  });
});

describe("image processor", () => {
  test("pure-js mode when sharp disabled", async () => {
    const p = await createImageProcessor({ useSharp: false });
    expect(p.sharp).toBe(false);
    expect(await p.thumbnail(PNG_1x1, "image/png")).toBeUndefined();
    const r = await p.stripMetadata(jpegWithExif().withExif, "image/jpeg");
    expect(r.stripped).toBe(true);
  });

  test("sharp re-encodes images with EXIF and makes thumbnails", async () => {
    const sharp = (await loadSharp()) as unknown as ((...a: unknown[]) => any) | undefined;
    if (!sharp) return; // sharp optional
    const jpeg = new Uint8Array(
      await sharp({ create: { width: 640, height: 480, channels: 3, background: "#f00" } })
        .jpeg()
        .withExif({ IFD0: { Copyright: "secret-owner" } })
        .toBuffer(),
    );
    expect(has(jpeg, "secret-owner")).toBe(true);
    const p = await createImageProcessor();
    expect(p.sharp).toBe(true);
    const r = await p.stripMetadata(jpeg, "image/jpeg");
    expect(r.stripped).toBe(true);
    expect(has(r.data, "secret-owner")).toBe(false);
    expect((await sharp(r.data).metadata()).format).toBe("jpeg");
    // clean image is not re-encoded
    expect((await p.stripMetadata(r.data, "image/jpeg")).stripped).toBe(false);
    const thumb = (await p.thumbnail(jpeg, "image/jpeg"))!;
    const meta = await sharp(thumb).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.width).toBe(320);
  });
});
