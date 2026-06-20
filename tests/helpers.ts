import { schnorr } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { getEventHash } from "../src/crypto";
import type { RelayConfig, NostrEvent } from "../src/types";

export function testConfig(overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    storage: { backend: "memory" },
    admin: {
      web: false,
    },
    disabledNips: new Set(),
    relay: {
      name: "Test Relay",
      description: "Test relay",
      software: "https://example.test",
      version: "test",
    },
    limits: {
      maxMessageLength: 524_288,
      maxSubscriptions: 64,
      maxSubIdLength: 64,
      maxLimit: 1000,
      defaultLimit: 500,
      maxEventTags: 4000,
      maxContentLength: 1_000_000,
      authEventMaxAgeSeconds: 600,
    },
    requireAuthForRead: false,
    requireAuthForWrite: false,
    acceptProtectedEvents: true,
    managementAdminPubkeys: new Set(),
    ...overrides,
  };
}

export function secretKey(seed: number): Uint8Array {
  const key = new Uint8Array(32);
  key.fill(seed);
  return key;
}

export function pubkeyFor(sk: Uint8Array): string {
  return bytesToHex(schnorr.getPublicKey(sk));
}

export function signedEvent(
  sk: Uint8Array,
  input: Partial<Omit<NostrEvent, "id" | "sig" | "pubkey">> & Pick<NostrEvent, "kind">,
): NostrEvent {
  const event = {
    pubkey: pubkeyFor(sk),
    created_at: input.created_at ?? 1_700_000_000,
    kind: input.kind,
    tags: input.tags ?? [],
    content: input.content ?? "",
  };
  const id = getEventHash(event);
  const sig = bytesToHex(schnorr.sign(hexToBytes(id), sk));
  return { ...event, id, sig };
}

export async function waitFor<T>(read: () => T | undefined, label: string, timeoutMs = 1000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}
