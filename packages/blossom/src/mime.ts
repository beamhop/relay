const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/jxl": "jxl",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/mpeg": "mpeg",
  "video/ogg": "ogv",
  "video/x-msvideo": "avi",
  "video/3gpp": "3gp",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/vnd.wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/webm": "weba",
  "application/pdf": "pdf",
  "application/json": "json",
  "application/zip": "zip",
  "application/gzip": "gz",
  "application/x-tar": "tar",
  "application/epub+zip": "epub",
  "application/octet-stream": "bin",
  "text/plain": "txt",
  "text/html": "html",
  "text/css": "css",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/javascript": "js",
};

export const DEFAULT_MIME = "application/octet-stream";

const SVG_START = /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>/]/i;
/** How much of an unrecognised blob is looked at to tell text (and SVG) from binary. */
const SNIFF_BYTES = 64 * 1024;

/**
 * Type of a blob whose bytes file-type couldn't recognise. The declared Content-Type is only believed for text
 * types, and only when the bytes are text: real images, audio and video carry magic bytes file-type knows, so a
 * declared media type on unrecognised bytes (e.g. a script or archive behind a junk prefix labelled image/png)
 * becomes application/octet-stream and has to pass the allowlist as that.
 */
export function typeOfUnrecognized(data: Uint8Array, declared: string | undefined): string {
  const text = sniffText(data);
  if (text === undefined) return DEFAULT_MIME;
  if (SVG_START.test(text)) return "image/svg+xml";
  if (declared && (declared.startsWith("text/") || declared === "application/json")) return declared;
  return DEFAULT_MIME;
}

/** Whether the bytes are UTF-8 text starting like an SVG document (an XML prolog, comments and a doctype allowed). */
export function isSvgText(data: Uint8Array): boolean {
  const text = sniffText(data);
  return text !== undefined && SVG_START.test(text);
}

/** The first SNIFF_BYTES as text, or undefined when they aren't UTF-8 text. */
function sniffText(data: Uint8Array): string | undefined {
  let text: string;
  try {
    // stream: a multi-byte character cut off at the sniff boundary isn't an error
    text = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, SNIFF_BYTES), { stream: true });
  } catch {
    return undefined;
  }
  return text.includes("\0") ? undefined : text;
}

/** Normalises a Content-Type header value to a bare lowercase mime (`image/png; x=y` → `image/png`). */
export function normalizeMime(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const mime = value.split(";")[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : undefined;
}

export function extFromMime(mime: string): string {
  return MIME_TO_EXT[mime] ?? "bin";
}

/** Matches against an allowlist supporting `*`, `*\/*`, `image/*` and exact entries. Empty list = allow all. */
export function isMimeAllowed(mime: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const [top] = mime.split("/");
  return allowlist.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (entry === "*" || entry === "*/*") return true;
    if (entry.endsWith("/*")) return entry.slice(0, -2) === top;
    return entry === mime;
  });
}

/**
 * Types that are safe to render inline from our origin: passive media and plain text. Everything else
 * (SVG, HTML, XML, JS, unknown …) is served as a download. `<img src>` embedding of SVG still works.
 */
export function isInlineSafe(mime: string): boolean {
  if (mime === "image/svg+xml" || mime.includes("xml")) return false;
  const top = mime.split("/")[0];
  return top === "image" || top === "video" || top === "audio" || mime === "text/plain" || mime === "application/pdf";
}

export const topLevelType = (mime: string) => mime.split("/")[0] || "application";

/** JavaScript MIME type essences (WHATWG MIME Sniffing), plus the common non-standard ones. */
const JAVASCRIPT_TYPES = new Set([
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
