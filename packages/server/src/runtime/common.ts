import { isIP } from "node:net";
import { DEFAULT_TRUSTED_PROXIES } from "@beamhop/sdk";
import { normalizeIp, parseCidr, parseIp } from "@beamhop/sdk/net";

export interface RunningServer {
  runtime: "bun" | "node";
  hostname: string;
  port: number;
  /** stop accepting new connections (open sockets stay up) */
  stopAccepting(): void;
  /**
   * Waits (at most STOP_GRACE_MS, or until `signal` aborts) for the websocket close handshakes relay.stop() started,
   * so clients see a clean 1001 instead of 1006.
   */
  settle(signal?: AbortSignal): Promise<void>;
  /** settle(), then force-close everything that is still open */
  stop(): Promise<void>;
}

/** How long stopping waits for websocket close handshakes before cutting the sockets. */
export const STOP_GRACE_MS = 1_000;

/** Resolves once every one of `waits` settled, `ms` passed or `signal` aborted, whichever comes first. */
export function graceFor(waits: Promise<unknown>[], ms: number = STOP_GRACE_MS, signal?: AbortSignal): Promise<void> {
  if (!waits.length || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    (timer as { unref?: () => void }).unref?.();
    signal?.addEventListener("abort", done, { once: true });
    Promise.allSettled(waits).then(done);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

export interface ServeOptions {
  host?: string;
  port?: number;
}

export { normalizeIp };

type HeaderGetter = (name: string) => string | null | undefined;

/** Whether a socket peer is a reverse proxy whose client-IP header may be believed. */
export type ProxyMatcher = (peer: string) => boolean;

/** Compiles `server.trustedProxies` (addresses or CIDR ranges); throws on an entry that is neither. */
export function proxyMatcher(list: readonly string[]): ProxyMatcher {
  const ranges = list.map((entry) => {
    const range = parseCidr(entry);
    if (!range) throw new Error(`server.trustedProxies: "${entry}" is not an IP address or CIDR range`);
    return range;
  });
  return (peer) => {
    const ip = parseIp(peer);
    return !!ip && ranges.some((r) => r.v === ip.v && (ip.value & r.mask) === r.network);
  };
}

const defaultProxies = proxyMatcher(DEFAULT_TRUSTED_PROXIES);

/**
 * Client IP = socket address, or — when trustProxy is on and the socket peer is a trusted proxy (`trusted`,
 * from server.trustedProxies) — the address that reverse proxy saw. Peers outside it (e.g. a client reaching
 * the published port directly) are identified by their own address, whatever headers they send.
 * `proxyHeader` names where the proxy puts it:
 * - "x-forwarded-for" (default): the *rightmost* entry — proxies append the peer address, everything to the
 *   left is client-supplied. Falls back to X-Real-IP only when the request carries no X-Forwarded-For at all.
 * - any other header (x-real-ip, cf-connecting-ip, fly-client-ip …): read as a single address. Use this when
 *   the proxy *sets* that header but passes a client's own X-Forwarded-For through untouched (e.g. nginx with
 *   only `proxy_set_header X-Real-IP $remote_addr`).
 * Values that aren't IP addresses are ignored (→ socket address).
 */
export function clientIp(
  remote: string | undefined | null,
  header: HeaderGetter,
  trustProxy: boolean,
  proxyHeader = "x-forwarded-for",
  trusted: ProxyMatcher = defaultProxies,
): string {
  const peer = normalizeIp(remote);
  if (trustProxy && trusted(peer)) {
    const name = proxyHeader.trim().toLowerCase() || "x-forwarded-for";
    if (name === "x-forwarded-for") {
      const xff = header("x-forwarded-for");
      const ip = xff?.trim() ? validIp(lastForwardedHop(xff)) : validIp(header("x-real-ip"));
      if (ip) return ip;
    } else {
      const ip = validIp(lastForwardedHop(header(name)));
      if (ip) return ip;
    }
  }
  return peer;
}

function validIp(raw: string | null | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  const ip = normalizeIp(raw);
  return isIP(ip) ? ip : undefined;
}

/** Rightmost non-empty entry of an X-Forwarded-For header (the hop appended by the nearest proxy). */
export function lastForwardedHop(xff: string | null | undefined): string | undefined {
  if (!xff) return undefined;
  const hops = xff.split(",").map((s) => s.trim()).filter(Boolean);
  return hops[hops.length - 1];
}

/** Websocket close reasons are limited to 123 UTF-8 bytes (`ws` throws on longer ones): cut on a character boundary. */
export function closeReason(reason: string | undefined): string | undefined {
  if (!reason) return reason;
  const bytes = Buffer.from(reason, "utf8");
  if (bytes.length <= 123) return reason;
  let end = 123;
  // back off continuation bytes (10xxxxxx) so a multi-byte character isn't split
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

/**
 * Websocket transport cap for a relay message limit. Above the relay's own `maxMessageBytes` (with headroom), so
 * a moderately oversized frame reaches the relay and gets the NIP-01 answer (OK/CLOSED "invalid: message too
 * large") instead of the transport dropping the connection with 1006. Still bounded: far larger frames are cut off
 * by the transport before they are buffered.
 */
export const wsMaxPayload = (maxMessageBytes: number) => Math.max(64 * 1024, maxMessageBytes * 2);
