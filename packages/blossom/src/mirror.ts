import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { networkInterfaces } from "node:os";
import { Readable } from "node:stream";
import { BlossomError } from "./http";

function ipv4Private(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  return ipv4NumPrivate(((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]);
}

/** Non-public IPv4 ranges (RFC 6890 special-purpose + multicast/reserved). */
function ipv4NumPrivate(n: number): boolean {
  const a = n >>> 24;
  const b = (n >>> 16) & 0xff;
  const c = (n >>> 8) & 0xff;
  return (
    a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Expands an IPv6 literal (optionally with an embedded dotted IPv4 tail) into 8 16-bit groups. */
export function parseIpv6(input: string): number[] | undefined {
  let v = input.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = v.indexOf("%");
  if (zone >= 0) v = v.slice(0, zone);
  const tail: number[] = [];
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (dotted) {
    const p = dotted[2].split(".").map(Number);
    if (p.some((n) => n > 255)) return undefined;
    tail.push((p[0] << 8) | p[1], (p[2] << 8) | p[3]);
    v = dotted[1].endsWith("::") ? dotted[1] : dotted[1].slice(0, -1);
  }
  const halves = v.split("::");
  if (halves.length > 2) return undefined;
  const part = (s: string) => (s === "" ? [] : s.split(":").map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)));
  const head = part(halves[0]);
  const rest = halves.length === 2 ? part(halves[1]) : [];
  const fixed = head.length + rest.length + tail.length;
  if ([...head, ...rest].some(Number.isNaN)) return undefined;
  if (halves.length === 1 && fixed !== 8) return undefined;
  if (halves.length === 2 && fixed > 7) return undefined;
  return [...head, ...new Array(8 - fixed).fill(0), ...rest, ...tail];
}

function ipv6Private(ip: string): boolean {
  const g = parseIpv6(ip);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => ipv4NumPrivate(((hi << 16) >>> 0) + lo);
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zero(0, 8)) return true; // ::
  if (zero(0, 7) && g[7] === 1) return true; // ::1
  if (zero(0, 5) && g[5] === 0xffff) return v4(g[6], g[7]); // ::ffff:a.b.c.d (IPv4-mapped)
  if (zero(0, 4) && g[4] === 0xffff && g[5] === 0) return v4(g[6], g[7]); // ::ffff:0:a.b.c.d (SIIT)
  if (zero(0, 6)) return v4(g[6], g[7]); // ::a.b.c.d (deprecated IPv4-compatible)
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6], g[7]); // 64:ff9b::/96 NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64
  if (g[0] === 0x2002) return v4(g[1], g[2]); // 6to4 embeds an IPv4
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g[0] === 0x100 && zero(1, 4)) return true; // discard-only 100::/64
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true; // link-local, site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

let localAddrs: { at: number; set: Set<string> } | undefined;
/** Addresses bound to this host's interfaces (incl. a public IP on a VPS): reaching them loops back over `lo`. */
function isOwnAddress(ip: string): boolean {
  if (!localAddrs || Date.now() - localAddrs.at > 60_000) {
    const set = new Set<string>();
    try {
      for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) set.add(a.address.toLowerCase().split("%")[0]);
    } catch {
      /* unavailable (sandbox): rely on the range checks */
    }
    localAddrs = { at: Date.now(), set };
  }
  return localAddrs.set.has(ip.toLowerCase());
}

export function isPrivateAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  const addr = bare.split("%")[0];
  const fam = isIP(addr);
  if (fam === 0) return true;
  if (isOwnAddress(addr)) return true;
  return fam === 4 ? ipv4Private(bare) : ipv6Private(bare);
}

const notAllowed = () => new BlossomError(403, "mirror target not allowed");

/** Rejects URLs whose host is (or resolves to) a loopback/private/link-local address (basic SSRF protection). */
async function assertPublicUrl(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) throw notAllowed();
  const addrs = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addrs.length === 0) throw new BlossomError(502, "could not resolve mirror host");
  if (addrs.some(isPrivateAddress)) throw notAllowed();
}

/**
 * DNS lookup used for the actual connection: resolves, rejects private answers, and hands the *checked*
 * address to the socket — so a rebinding DNS server can't swap in a private IP between check and connect.
 */
const publicOnlyLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { all: true, family: (options as { family?: number }).family ?? 0 })
    .then((addrs) => {
      if (addrs.length === 0) throw new BlossomError(502, "could not resolve mirror host");
      if (addrs.some((a) => isPrivateAddress(a.address))) throw notAllowed();
      if ((options as { all?: boolean }).all) (callback as (e: null, a: typeof addrs) => void)(null, addrs);
      else callback(null, addrs[0].address, addrs[0].family);
    })
    .catch((err) => callback(err as NodeJS.ErrnoException, "", 0));
};

const MIRROR_USER_AGENT = "beamhop/0.1 (+blossom mirror)";
/** Statuses a `Response` must be built without a body (fetch spec "null body status"). */
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * Minimal fetch over node:http(s) with `publicOnlyLookup` pinned in. No redirects (handled by the caller).
 * Everything runs inside emitter callbacks, so nothing here may throw: an exception would be uncaught and
 * take the whole process down (e.g. `new Response()` rejects statuses outside 200–599).
 */
export function pinnedFetch(url: URL, init: { signal: AbortSignal }): Promise<Response> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    let req: http.ClientRequest;
    try {
      req = mod.request(
        url,
        { method: "GET", lookup: publicOnlyLookup, signal: init.signal, headers: { accept: "*/*", "user-agent": MIRROR_USER_AGENT } },
        (res) => {
          try {
            const status = res.statusCode ?? 0;
            if (status < 200 || status > 599) {
              res.destroy();
              return reject(new BlossomError(502, "mirror source returned an error"));
            }
            const headers = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              try {
                if (Array.isArray(v)) for (const x of v) headers.append(k, x);
                else if (v !== undefined) headers.set(k, v);
              } catch {
                // a header value the WHATWG Headers class refuses; irrelevant for mirroring
              }
            }
            let body: ReadableStream<Uint8Array> | null = null;
            if (NULL_BODY_STATUSES.has(status)) res.resume();
            else body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
            resolve(new Response(body, { status, headers }));
          } catch (err) {
            res.destroy();
            reject(err instanceof BlossomError ? err : new BlossomError(502, "mirror fetch failed"));
          }
        },
      );
    } catch {
      return reject(new BlossomError(502, "mirror fetch failed"));
    }
    req.on("error", reject);
    req.end();
  });
}

interface FetchRemoteOptions {
  /** custom fetch (tests); when omitted a DNS-pinned node:http(s) client is used */
  fetch?: typeof fetch;
  allowPrivate: boolean;
  /** destination ports allowed when `allowPrivate` is off (default 80 and 443) */
  allowedPorts?: number[];
  /** abort signal covering the whole transfer (pass one to tell afterwards whether a cut-off body was a timeout) */
  signal?: AbortSignal;
  /** without a `signal`: timeout for the whole transfer (default 30 s) */
  timeoutMs?: number;
}

const DEFAULT_MIRROR_PORTS = [80, 443];
const MAX_REDIRECTS = 5;

/** Fetches a remote blob following redirects manually so every hop is SSRF-checked. */
export async function fetchRemote(rawUrl: string, opts: FetchRemoteOptions): Promise<Response> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlossomError(400, "invalid mirror url");
  }
  const signal = opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 30_000);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlossomError(400, "mirror url must be http(s)");
    if (!opts.allowPrivate) {
      // no port scanning of internal services through us: only the usual web ports
      const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
      if (!(opts.allowedPorts ?? DEFAULT_MIRROR_PORTS).includes(port)) throw notAllowed();
      await assertPublicUrl(url);
    }
    let res: Response;
    try {
      res = opts.fetch
        ? await opts.fetch(url, { redirect: "manual", signal })
        : opts.allowPrivate
          ? await fetch(url, { redirect: "manual", signal })
          : await pinnedFetch(url, { signal });
    } catch (err) {
      if (err instanceof BlossomError) throw err;
      const cause = (err as { cause?: unknown })?.cause;
      if (cause instanceof BlossomError) throw cause;
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
      // don't echo the upstream status: it turns mirroring into a probing oracle
      throw new BlossomError(502, "mirror source returned an error");
    }
    return res;
  }
  throw new BlossomError(502, "too many redirects");
}
