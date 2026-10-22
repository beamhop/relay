import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { BlossomError } from "./http";

function ipv4Private(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  );
}

function ipv6Private(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (v === "::" || v === "::1") return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return ipv4Private(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
}

export function isPrivateAddress(ip: string): boolean {
  const fam = isIP(ip.replace(/^\[|\]$/g, ""));
  if (fam === 4) return ipv4Private(ip);
  if (fam === 6) return ipv6Private(ip);
  return true;
}

/** Rejects URLs that resolve to loopback/private/link-local addresses (basic SSRF protection). */
export async function assertPublicUrl(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw new BlossomError(403, "mirror target not allowed");
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addrs.length === 0) throw new BlossomError(502, "could not resolve mirror host");
  if (addrs.some(isPrivateAddress)) throw new BlossomError(403, "mirror target not allowed");
}

export interface FetchRemoteOptions {
  fetch: typeof fetch;
  allowPrivate: boolean;
  timeoutMs: number;
  maxRedirects?: number;
}

/** Fetches a remote blob following redirects manually so every hop is SSRF-checked. */
export async function fetchRemote(rawUrl: string, opts: FetchRemoteOptions): Promise<Response> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlossomError(400, "invalid mirror url");
  }
  const signal = AbortSignal.timeout(opts.timeoutMs);
  for (let hop = 0; hop <= (opts.maxRedirects ?? 5); hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlossomError(400, "mirror url must be http(s)");
    if (!opts.allowPrivate) await assertPublicUrl(url);
    let res: Response;
    try {
      res = await opts.fetch(url, { redirect: "manual", signal });
    } catch (err) {
      const timeout = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
      throw new BlossomError(timeout ? 504 : 502, timeout ? "mirror fetch timed out" : "mirror fetch failed");
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      await res.body?.cancel();
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new BlossomError(502, `mirror source responded ${res.status}`);
    }
    return res;
  }
  throw new BlossomError(502, "too many redirects");
}
