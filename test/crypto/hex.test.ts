import { describe, expect, test } from "bun:test";
import {
  bigIntToBytes,
  bytesToBigInt,
  bytesToHex,
  hexToBytes,
  utf8ToBytes,
} from "../../src/crypto/hex.ts";

describe("bytesToHex", () => {
  test("encodes bytes as lowercase hex", () => {
    expect(bytesToHex(new Uint8Array([0x00, 0x0f, 0xff, 0xa0]))).toBe("000fffa0");
  });
  test("empty array -> empty string", () => {
    expect(bytesToHex(new Uint8Array([]))).toBe("");
  });
});

describe("hexToBytes", () => {
  test("roundtrips with bytesToHex", () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 255]);
    expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
  });
  test("accepts uppercase hex", () => {
    expect(hexToBytes("ABCD")).toEqual(new Uint8Array([0xab, 0xcd]));
  });
  test("throws on odd length", () => {
    expect(() => hexToBytes("abc")).toThrow("odd length");
  });
  test("throws on invalid character", () => {
    expect(() => hexToBytes("zz")).toThrow("invalid hex");
  });
});

describe("utf8ToBytes", () => {
  test("encodes multibyte characters", () => {
    expect(utf8ToBytes("🚀")).toEqual(new Uint8Array([0xf0, 0x9f, 0x9a, 0x80]));
  });
});

describe("bytesToBigInt / bigIntToBytes", () => {
  test("empty bytes -> 0n", () => {
    expect(bytesToBigInt(new Uint8Array([]))).toBe(0n);
  });
  test("big-endian roundtrip", () => {
    expect(bytesToBigInt(new Uint8Array([0x01, 0x00]))).toBe(256n);
    expect(bigIntToBytes(256n, 2)).toEqual(new Uint8Array([0x01, 0x00]));
  });
  test("pads to fixed length", () => {
    expect(bigIntToBytes(1n, 4)).toEqual(new Uint8Array([0, 0, 0, 1]));
  });
  test("throws when value does not fit", () => {
    expect(() => bigIntToBytes(0x1ffn, 1)).toThrow("does not fit");
  });
});
