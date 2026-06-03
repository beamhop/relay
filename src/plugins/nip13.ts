/**
 * NIP-13: Proof of Work.
 *
 * Difficulty is the number of leading zero *bits* in the event id (sha256, hex).
 * A relay may require a minimum difficulty; events below it are rejected.
 *
 * If the event carries a `["nonce", "<nonce>", "<target>"]` tag, the committed
 * target must itself meet the relay minimum — this prevents a miner from
 * getting "lucky" with a low committed target yet a high actual difficulty, and
 * lets the relay reject events that don't even *claim* enough work (per NIP-13:
 * "the relay should reject the event" if the committed target is below the
 * required minimum). Both the actual id difficulty and, when present, the
 * committed target are checked.
 *
 * Off by default: with no `minPow`, every event passes.
 */
import type { NostrEvent } from "../types.ts";
import type { NostrPlugin } from "../plugin.ts";

/** Count leading zero bits of a lowercase-hex string (e.g. an event id). */
export function countLeadingZeroBits(hex: string): number {
  let count = 0;
  for (let i = 0; i < hex.length; i++) {
    const nibble = parseInt(hex[i]!, 16);
    if (Number.isNaN(nibble)) break;
    if (nibble === 0) {
      count += 4;
      continue;
    }
    // clz of a 4-bit value
    count += Math.clz32(nibble) - 28;
    break;
  }
  return count;
}

/** The committed PoW target from an event's nonce tag, or undefined if absent/invalid. */
export function committedTarget(event: NostrEvent): number | undefined {
  for (const tag of event.tags) {
    if (tag[0] !== "nonce") continue;
    const target = Number(tag[2]);
    if (Number.isInteger(target) && target >= 0) return target;
  }
  return undefined;
}

export interface Nip13Options {
  /** Minimum required difficulty (leading zero bits). 0 or unset disables PoW. */
  minPow?: number;
}

export function nip13(opts: Nip13Options = {}): NostrPlugin {
  const minPow = opts.minPow ?? 0;
  return {
    name: "nip13",
    supportedNips: [13],

    eventValidators: [
      (event) => {
        if (minPow <= 0) return { ok: true };
        if (countLeadingZeroBits(event.id) < minPow) {
          return {
            ok: false,
            reason: `pow: difficulty ${countLeadingZeroBits(event.id)} is less than ${minPow}`,
          };
        }
        // If the author committed a target, it must also meet the minimum.
        const target = committedTarget(event);
        if (target !== undefined && target < minPow) {
          return {
            ok: false,
            reason: `pow: committed target ${target} is less than ${minPow}`,
          };
        }
        return { ok: true };
      },
    ],
  };
}
