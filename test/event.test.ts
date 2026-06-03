import { describe, expect, test } from "bun:test";
import {
  getEventHash,
  serializeEvent,
  validateStructure,
  verifyEvent,
} from "../src/event.ts";
import { clone, events } from "./fixtures.ts";

describe("serializeEvent", () => {
  test("produces the canonical 6-element array form", () => {
    expect(serializeEvent(events.note)).toBe(
      '[0,"f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",1700000000,1,[["t","intro"]],"hello nostr"]',
    );
  });
  test("escapes control chars and quotes but leaves unicode literal", () => {
    const s = serializeEvent(events.noteUnicode);
    expect(s).toContain('line1\\nline2 \\"quoted\\" \\\\back 🚀 ');
    expect(s).not.toContain("\\u"); // emoji stays literal, not \uXXXX
  });
});

describe("getEventHash", () => {
  test("matches the precomputed id for every fixture", () => {
    for (const event of Object.values(events)) {
      expect(getEventHash(event)).toBe(event.id);
    }
  });
});

describe("validateStructure", () => {
  test("accepts a well-formed event", () => {
    expect(validateStructure(events.note)).toBe(true);
  });
  test("rejects non-objects", () => {
    expect(validateStructure(null)).toBe(false);
    expect(validateStructure("nope")).toBe(false);
  });
  test("rejects a bad id length", () => {
    const e = clone(events.note);
    e.id = "abc";
    expect(validateStructure(e)).toBe(false);
  });
  test("rejects an uppercase (non-lowercase-hex) pubkey", () => {
    const e = clone(events.note);
    e.pubkey = e.pubkey.toUpperCase();
    expect(validateStructure(e)).toBe(false);
  });
  test("rejects a bad sig length", () => {
    const e = clone(events.note);
    e.sig = "00";
    expect(validateStructure(e)).toBe(false);
  });
  test("rejects a non-string content", () => {
    const e = clone(events.note) as Record<string, unknown>;
    e.content = 123;
    expect(validateStructure(e)).toBe(false);
  });
  test("rejects a non-integer or negative created_at", () => {
    const e = clone(events.note) as Record<string, unknown>;
    e.created_at = 1.5;
    expect(validateStructure(e)).toBe(false);
    e.created_at = -1;
    expect(validateStructure(e)).toBe(false);
  });
  test("rejects a non-integer kind", () => {
    const e = clone(events.note) as Record<string, unknown>;
    e.kind = 1.2;
    expect(validateStructure(e)).toBe(false);
  });
  test("rejects non-array tags", () => {
    const e = clone(events.note) as Record<string, unknown>;
    e.tags = "no";
    expect(validateStructure(e)).toBe(false);
  });
  test("rejects a tag that is not an array", () => {
    const e = clone(events.note) as Record<string, unknown>;
    e.tags = ["notanarray"];
    expect(validateStructure(e)).toBe(false);
  });
  test("rejects a tag item that is not a string", () => {
    const e = clone(events.note) as Record<string, unknown>;
    e.tags = [["e", 5]];
    expect(validateStructure(e)).toBe(false);
  });
});

describe("verifyEvent", () => {
  test("accepts every valid fixture", () => {
    for (const event of Object.values(events)) {
      expect(verifyEvent(event)).toBe(true);
    }
  });
  test("rejects when content is tampered (id mismatch)", () => {
    const e = clone(events.note);
    e.content = "tampered";
    expect(verifyEvent(e)).toBe(false);
  });
  test("rejects when the signature is tampered", () => {
    const e = clone(events.note);
    e.sig = e.sig.slice(0, -2) + (e.sig.endsWith("0") ? "1" : "0");
    expect(verifyEvent(e)).toBe(false);
  });
  test("rejects a structurally invalid event without throwing", () => {
    const e = clone(events.note);
    e.id = "zz";
    expect(verifyEvent(e)).toBe(false);
  });
});
