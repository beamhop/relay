/** Converts an http(s) base URL into its ws(s) equivalent. */
export function toWsUrl(publicUrl: string): string {
  return publicUrl.replace(/^http(s?):\/\//i, (_m, s: string) => `ws${s}://`).replace(/\/+$/, "");
}

/**
 * Normalized identity of a relay URL for comparisons (NIP-42 relay tag, NIP-62):
 * host (lowercase, default ports stripped) + path without trailing slash. Scheme-insensitive
 * (ws/wss/http/https are considered equivalent: the host is what prevents cross-relay replay).
 */
export function relayUrlKey(url: string): string | undefined {
  try {
    const u = new URL(url.trim().replace(/^ws(s?):\/\//i, (_m, s: string) => `http${s}://`));
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.host.toLowerCase()}${path}`;
  } catch {
    return undefined;
  }
}

export function sameRelayUrl(a: string, b: string): boolean {
  const ka = relayUrlKey(a);
  return ka !== undefined && ka === relayUrlKey(b);
}
