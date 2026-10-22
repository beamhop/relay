import type { NostrEvent } from "@beamhop/sdk";

/** NIP-13: number of leading zero bits of the event id. */
export function countLeadingZeroBits(hex: string): number {
  let count = 0;
  for (let i = 0; i < hex.length; i++) {
    const nibble = parseInt(hex[i], 16);
    if (nibble === 0) {
      count += 4;
      continue;
    }
    count += Math.clz32(nibble) - 28;
    break;
  }
  return count;
}

/** Returns a rejection reason or undefined. */
export function checkPow(event: NostrEvent, minDifficulty: number): string | undefined {
  if (!(minDifficulty > 0)) return undefined;
  const difficulty = countLeadingZeroBits(event.id);
  if (difficulty < minDifficulty) return `pow: difficulty ${difficulty} is less than ${minDifficulty}`;
  const nonce = event.tags.find((t) => t[0] === "nonce");
  if (nonce && nonce[2] !== undefined) {
    const target = Number(nonce[2]);
    // a committed target lower than required means the difficulty was reached by luck
    if (!Number.isFinite(target) || target < minDifficulty) return `pow: committed target ${nonce[2]} is less than ${minDifficulty}`;
  }
  return undefined;
}
