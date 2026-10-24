import { type BeamhopConfig, type UnsignedEvent, nowSec } from "@beamhop/sdk";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import type { RelayKey } from "./context";
import { hexToBytes, isHex64 } from "./util/hex";

/** The relay key from config (the server generates and persists one when none is configured). */
export function loadRelayKey(config: BeamhopConfig): RelayKey {
  const hex = config.relaySecretKey?.toLowerCase();
  if (!hex) throw new Error("config.relaySecretKey is required (the server generates one on first start)");
  if (!isHex64(hex)) throw new Error("config.relaySecretKey must be a 64-char hex string");
  const sk = hexToBytes(hex);
  const pubkey = getPublicKey(sk);
  return {
    pubkey,
    sign: (t: UnsignedEvent) => finalizeEvent({ kind: t.kind, created_at: t.created_at ?? nowSec(), tags: t.tags ?? [], content: t.content ?? "" }, sk),
  };
}
