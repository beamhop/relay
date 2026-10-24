/**
 * Which media URLs from untrusted Nostr data (profile pictures, banners, note images, group pictures) the admin
 * panel may fetch. Every remote fetch tells the host the admin's IP, user agent and when they looked, and the
 * person who posted it chose that host, so only this relay's own origins load by default; remote media waits for
 * the per-browser "Load remote images and video" preference or a click.
 * No DOM or React imports: unit-tested in test/media-policy.test.ts.
 */

/** Returns the URL only if it parses as http(s); untrusted Nostr metadata must not become javascript:/data: links or styles. */
export function safeUrl(u: string | undefined | null): string | undefined {
  if (!u || typeof u !== "string") return undefined;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.href : undefined;
  } catch {
    return undefined;
  }
}

export interface MediaPolicy {
  /** origins served by this relay (the panel's own origin, the configured publicUrl) */
  trustedOrigins: readonly string[];
  /** the admin opted in to loading remote media in this browser */
  allowRemote: boolean;
}

/**
 * - `load`: fetch it now (own origin, or remote media allowed)
 * - `ask`: a valid remote URL that may only load after an explicit click
 * - `none`: nothing loadable (missing, malformed, not http(s))
 */
export type MediaVerdict = { kind: "load"; src: string } | { kind: "ask"; src: string; host: string } | { kind: "none" };

export function originOf(u: string | undefined | null): string | undefined {
  if (!u) return undefined;
  try {
    const o = new URL(u).origin;
    return o === "null" ? undefined : o;
  } catch {
    return undefined;
  }
}

export function isTrustedOrigin(src: string, trusted: readonly string[]): boolean {
  const o = originOf(src);
  return !!o && trusted.includes(o);
}

export function mediaVerdict(url: string | undefined | null, policy: MediaPolicy): MediaVerdict {
  const src = safeUrl(url);
  if (!src) return { kind: "none" };
  if (policy.allowRemote || isTrustedOrigin(src, policy.trustedOrigins)) return { kind: "load", src };
  return { kind: "ask", src, host: new URL(src).host };
}

/** Like mediaVerdict, but for images that only decorate (avatars, banners): never offers a click, just falls back. */
export function autoMediaSrc(url: string | undefined | null, policy: MediaPolicy): string | undefined {
  const v = mediaVerdict(url, policy);
  return v.kind === "load" ? v.src : undefined;
}
