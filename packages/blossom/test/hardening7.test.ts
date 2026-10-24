import { afterEach, describe, expect, test } from "bun:test";
import { typeOfUnrecognized } from "../src/mime";
import { authHeader, createHarness, newUser, type Harness } from "./fakes";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const alice = newUser();
const enc = (s: string) => new TextEncoder().encode(s);
const upload = (body: Uint8Array, type?: string) =>
  h!.request("/upload", {
    method: "PUT",
    body: body as BodyInit,
    headers: { authorization: authHeader(alice.sk, "upload", { server: ["cdn.example.com"] }), ...(type ? { "content-type": type } : {}) },
  });

describe("declared Content-Type of unrecognised bytes", () => {
  test("only text types are believed, and only for text", () => {
    expect(typeOfUnrecognized(enc("hello"), "text/plain")).toBe("text/plain");
    expect(typeOfUnrecognized(enc('{"a":1}'), "application/json")).toBe("application/json");
    expect(typeOfUnrecognized(enc("hello"), "image/png")).toBe("application/octet-stream");
    expect(typeOfUnrecognized(new Uint8Array([0, 1, 2, 255]), "text/plain")).toBe("application/octet-stream");
    expect(typeOfUnrecognized(enc("a\0b"), "text/plain")).toBe("application/octet-stream");
    // a multi-byte character cut at the sniff boundary is still text
    const long = enc("a".repeat(64 * 1024 - 1) + "é");
    expect(typeOfUnrecognized(long, "text/plain")).toBe("text/plain");
  });

  test("SVG is recognised whatever it's labelled", () => {
    for (const svg of ['<svg xmlns="http://www.w3.org/2000/svg"/>', '<?xml version="1.0"?>\n<!-- x -->\n<!DOCTYPE svg>\n<svg>', "﻿  <SVG>"])
      expect(typeOfUnrecognized(enc(svg), "image/png")).toBe("image/svg+xml");
  });

  test("a script or archive behind a junk prefix can't be stored as an allowed media type", async () => {
    h = await createHarness({ useSharp: false });
    // file-type only checks offset 0, unzip tools find the archive anyway
    const polyglot = new Uint8Array([...enc("junk"), 0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    for (const type of ["image/png", "video/mp4", "audio/mpeg"]) expect((await upload(polyglot, type)).status).toBe(415);
    expect((await upload(enc("<script>alert(1)</script>"), "image/png")).status).toBe(415);
  });

  test("text still uploads where the allowlist permits it", async () => {
    h = await createHarness({ useSharp: false });
    await h.deps.settings.update({ blossom: { allowedMimeTypes: ["text/*", "image/*"] } } as never, "test");
    expect((await (await upload(enc("plain notes"), "text/plain")).json()).type).toBe("text/plain");
    expect((await (await upload(enc("<svg><script>alert(1)</script></svg>"), "text/plain")).json()).type).toBe("image/svg+xml");
  });
});
