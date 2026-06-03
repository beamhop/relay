import { describe, expect, test } from "bun:test";
import { sha256, sha256Hex } from "../../src/crypto/sha256.ts";
import { utf8ToBytes } from "../../src/crypto/hex.ts";

describe("sha256", () => {
  test("known vector for empty input", () => {
    expect(sha256Hex(utf8ToBytes(""))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
  test("known vector for 'abc'", () => {
    expect(sha256Hex(utf8ToBytes("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  test("returns a 32-byte digest", () => {
    expect(sha256(utf8ToBytes("x")).length).toBe(32);
  });
  test("hex output is 64 lowercase chars", () => {
    const hex = sha256Hex(utf8ToBytes("hello"));
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
