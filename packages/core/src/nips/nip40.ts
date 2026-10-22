import type { NostrEvent } from "@beamhop/sdk";

/** NIP-40 expiration timestamp, if present and valid. */
export function expirationOf(event: NostrEvent): number | undefined {
  for (const t of event.tags) {
    if (t[0] !== "expiration" || t[1] === undefined) continue;
    if (!/^\d{1,12}$/.test(t[1])) return undefined;
    return Number(t[1]);
  }
  return undefined;
}

export const isExpired = (event: NostrEvent, now: number) => {
  const exp = expirationOf(event);
  return exp !== undefined && exp <= now;
};
