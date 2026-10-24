import { describe, expect, test } from "bun:test";
import { autoMediaSrc, mediaVerdict, safeUrl, type MediaPolicy } from "../src/lib/media-policy";

const own: MediaPolicy = { trustedOrigins: ["https://relay.example", "http://192.168.1.10:3334"], allowRemote: false };
const optedIn: MediaPolicy = { ...own, allowRemote: true };

describe("safeUrl", () => {
  test.each(["javascript:alert(1)", "data:image/png;base64,AA", "blob:https://relay.example/x", "//evil.example/x.png", "not a url", "", undefined, null])(
    "refuses %p",
    (u) => {
      expect(safeUrl(u as string | undefined)).toBeUndefined();
    },
  );
  test("accepts http(s)", () => {
    expect(safeUrl("https://a.example/p.png")).toBe("https://a.example/p.png");
  });
  test("ignores non-strings from crafted metadata", () => {
    expect(safeUrl({} as unknown as string)).toBeUndefined();
  });
});

describe("mediaVerdict", () => {
  test("this relay's own media always loads", () => {
    expect(mediaVerdict("https://relay.example/abc.jpg", own)).toEqual({ kind: "load", src: "https://relay.example/abc.jpg" });
    expect(mediaVerdict("http://192.168.1.10:3334/abc.jpg", own).kind).toBe("load");
  });

  test("remote media waits for a click unless the admin opted in", () => {
    expect(mediaVerdict("https://tracker.example/p.png?u=1", own)).toEqual({ kind: "ask", src: "https://tracker.example/p.png?u=1", host: "tracker.example" });
    expect(mediaVerdict("https://tracker.example/p.png", optedIn).kind).toBe("load");
  });

  test("a different port or scheme is a different origin", () => {
    expect(mediaVerdict("https://relay.example:8443/a.png", own).kind).toBe("ask");
    expect(mediaVerdict("http://relay.example/a.png", own).kind).toBe("ask");
  });

  test("lookalike hosts are not trusted", () => {
    expect(mediaVerdict("https://relay.example.evil.example/a.png", own).kind).toBe("ask");
    expect(mediaVerdict("https://relay.example@evil.example/a.png", own).kind).toBe("ask");
  });

  test("unsafe URLs never load, even when opted in", () => {
    expect(mediaVerdict("javascript:alert(1)", optedIn)).toEqual({ kind: "none" });
    expect(mediaVerdict("data:image/svg+xml,<svg/>", optedIn)).toEqual({ kind: "none" });
  });
});

describe("autoMediaSrc (avatars, banners)", () => {
  test("falls back instead of loading remote pictures", () => {
    expect(autoMediaSrc("https://tracker.example/p.png", own)).toBeUndefined();
    expect(autoMediaSrc("https://relay.example/p.png", own)).toBe("https://relay.example/p.png");
    expect(autoMediaSrc("https://tracker.example/p.png", optedIn)).toBe("https://tracker.example/p.png");
  });
});
