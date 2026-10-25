/**
 * How stored media is served from our own origins (Blossom and the admin panel's preview): which types may render
 * inline, which Content-Type and CSP a blob goes out with, and which fetch destinations are refused. Both servers
 * must apply the same rules, so they live here once.
 */

export const DEFAULT_MIME = "application/octet-stream";

/**
 * Types that are safe to render inline from our origin: passive media and plain text. Everything else
 * (SVG, HTML, XML, JS, unknown …) is served as a download. `<img src>` embedding of SVG still works.
 */
export function isInlineSafe(mime: string): boolean {
  if (mime === "image/svg+xml" || mime.includes("xml")) return false;
  const top = mime.split("/")[0];
  return top === "image" || top === "video" || top === "audio" || mime === "text/plain" || mime === "application/pdf";
}

/** JavaScript MIME type essences (WHATWG MIME Sniffing), plus the common non-standard ones. */
export const JAVASCRIPT_TYPES = new Set([
  "application/ecmascript", "application/javascript", "application/x-ecmascript", "application/x-javascript",
  "text/ecmascript", "text/javascript", "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
  "text/javascript1.3", "text/javascript1.4", "text/javascript1.5", "text/jscript", "text/livescript",
  "text/x-ecmascript", "text/x-javascript", "application/node",
]);

/**
 * Content-Type a stored blob is served with. Same-origin content must never be runnable as script (the admin panel
 * allows `script-src 'self'`): JavaScript goes out as plain text and WebAssembly as opaque bytes, so with nosniff
 * a `<script>`, worker or `instantiateStreaming` refuses it.
 */
export function servedType(mime: string): string {
  if (JAVASCRIPT_TYPES.has(mime)) return "text/plain; charset=utf-8";
  if (mime === "application/wasm") return DEFAULT_MIME;
  return mime;
}

/** `Sec-Fetch-Dest` values of requests that would run or apply the response as code. */
export const SCRIPT_DESTINATIONS = new Set(["script", "worker", "sharedworker", "serviceworker", "audioworklet", "paintworklet", "xslt"]);

/**
 * CSP for a served blob. Everything is sandboxed (no scripts, no same-origin) except inline-safe audio/video:
 * Chromium refuses to play a directly-opened media document under `sandbox`, so those get `media-src 'self'`
 * instead (`default-src 'none'` still blocks scripts). XML-based "media" types (`video/x+xml`) render as documents,
 * so they stay sandboxed.
 */
export function blobCsp(mime: string): string {
  const top = mime.split("/")[0];
  return (top === "audio" || top === "video") && isInlineSafe(mime) ? "default-src 'none'; media-src 'self'" : "default-src 'none'; sandbox";
}
