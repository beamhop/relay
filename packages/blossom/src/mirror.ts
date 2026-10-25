import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
import { isForbiddenDestination } from "@beamhop/sdk/net";
import { BlossomError } from "./http";

export { parseIpv6 } from "@beamhop/sdk/net";

/**
 * Whether the mirror (and the proxy check) treats an address as non-public: a private/special range or one of this
 * host's own addresses (see @beamhop/sdk/net).
 */
export const isPrivateAddress = isForbiddenDestination;

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
