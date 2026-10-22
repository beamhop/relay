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

export const topLevelType = (mime: string) => mime.split("/")[0] || "application";
