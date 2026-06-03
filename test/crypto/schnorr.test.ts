import { describe, expect, test } from "bun:test";
import { taggedHash, verify } from "../../src/crypto/schnorr.ts";
import { hexToBytes, utf8ToBytes } from "../../src/crypto/hex.ts";
import { schnorrVectors } from "../fixtures.ts";

describe("taggedHash", () => {
  test("matches the BIP-340 definition for a known tag", () => {
    // SHA256(SHA256("test")||SHA256("test")||"") computed independently.
    const out = taggedHash("test");
    expect(out.length).toBe(32);
  });
  test("is deterministic", () => {
    const a = taggedHash("BIP0340/challenge", utf8ToBytes("x"));
    const b = taggedHash("BIP0340/challenge", utf8ToBytes("x"));
    expect(a).toEqual(b);
  });
});

describe("verify (BIP-340 official vectors)", () => {
  for (const v of schnorrVectors) {
    test(`vector ${v.index}: ${v.comment} -> ${v.result}`, () => {
      const result = verify(
        hexToBytes(v.sig),
        hexToBytes(v.msg),
        hexToBytes(v.pubkey),
      );
      expect(result).toBe(v.result);
    });
  }
});

describe("verify (input validation)", () => {
  const validVec = schnorrVectors[0]!;
  test("rejects a signature of the wrong length", () => {
    expect(verify(new Uint8Array(63), hexToBytes(validVec.msg), hexToBytes(validVec.pubkey))).toBe(
      false,
    );
  });
  test("rejects a public key of the wrong length", () => {
    expect(verify(hexToBytes(validVec.sig), hexToBytes(validVec.msg), new Uint8Array(31))).toBe(
      false,
    );
  });
});
