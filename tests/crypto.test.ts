import { expect, test } from "bun:test";
import { verifyEvent } from "../src/crypto";
import { secretKey, signedEvent } from "./helpers";

test("verifies Nostr event id and Schnorr signature", () => {
  const event = signedEvent(secretKey(1), { kind: 1, content: "hello" });
  expect(verifyEvent(event)).toEqual({ ok: true });

  const tampered = { ...event, content: "changed" };
  expect(verifyEvent(tampered)).toMatchObject({ ok: false, prefix: "invalid" });
});
