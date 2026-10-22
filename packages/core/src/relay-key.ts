import { type BeamhopConfig, type KvStore, type Logger, type UnsignedEvent, nowSec } from "@beamhop/sdk";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import type { RelayKey } from "./context";
import { bytesToHex, hexToBytes, isHex64 } from "./util/hex";

export const KV_NAMESPACE = "core";
export const KV_SECRET_KEY = "relaySecretKey";

/** Loads the relay key from config, then KV; generates and persists a new one if absent. */
export async function loadRelayKey(config: BeamhopConfig, kv: KvStore, logger: Logger): Promise<RelayKey> {
  let hex = config.relaySecretKey?.toLowerCase();
  if (hex && !isHex64(hex)) throw new Error("config.relaySecretKey must be a 64-char hex string");
  if (!hex) {
    const stored = await kv.get<string>(KV_NAMESPACE, KV_SECRET_KEY);
    if (typeof stored === "string" && isHex64(stored)) hex = stored;
  }
  if (!hex) {
    hex = bytesToHex(generateSecretKey());
    await kv.set(KV_NAMESPACE, KV_SECRET_KEY, hex);
    logger.info("generated new relay key");
  }
  const sk = hexToBytes(hex);
  const pubkey = getPublicKey(sk);
  return {
    pubkey,
    sign: (t: UnsignedEvent) => finalizeEvent({ kind: t.kind, created_at: t.created_at ?? nowSec(), tags: t.tags ?? [], content: t.content ?? "" }, sk),
  };
}
