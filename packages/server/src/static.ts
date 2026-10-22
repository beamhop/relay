import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { isBun } from "@beamhop/sdk";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".pbf": "application/x-protobuf",
  ".xml": "application/xml",
};
export const mimeFor = (path: string) => MIME[extname(path).toLowerCase()] ?? "application/octet-stream";

/** Response body for a file on disk (or embedded in a Bun binary). */
export function fileBody(path: string): BodyInit {
  if (isBun) return (globalThis as unknown as { Bun: { file(p: string): Blob } }).Bun.file(path);
  return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
}

export interface AssetSource {
  readonly kind: "dir" | "embedded" | "none";
  readonly location?: string;
  /** rel path without leading slash; returns absolute/embedded file path */
  resolve(rel: string): string | undefined;
}

// Set by the binary build entry (scripts/build-binary.ts) with files embedded via `with { type: "file" }`.
let embedded: Record<string, string> | undefined;
export function setEmbeddedUi(files: Record<string, string>) {
  embedded = files;
}

function dirSource(dir: string): AssetSource {
  const root = resolve(dir);
  return {
    kind: "dir",
    location: root,
    resolve(rel) {
      const p = normalize(join(root, rel));
      if (p !== root && !p.startsWith(root + sep)) return undefined;
      try {
        return statSync(p).isFile() ? p : undefined;
      } catch {
        return undefined;
      }
    },
  };
}

/** Candidate admin-ui dist folders: explicit → next to the node bundle → workspace package. */
export function uiDirCandidates(uiDir?: string): string[] {
  if (uiDir) return [uiDir];
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, "admin-ui"), // dist/node/admin-ui (node build)
    resolve(here, "../../admin-ui/dist"), // packages/server/src → packages/admin-ui/dist
    resolve(process.cwd(), "packages/admin-ui/dist"),
    resolve(process.cwd(), "admin-ui"),
  ];
}

export function createAssetSource(uiDir?: string): AssetSource {
  if (!uiDir && embedded && Object.keys(embedded).length) {
    const files = embedded;
    return { kind: "embedded", location: "(embedded)", resolve: (rel) => files[rel] };
  }
  for (const d of uiDirCandidates(uiDir)) {
    if (existsSync(join(d, "index.html"))) return dirSource(d);
  }
  return { kind: "none", resolve: () => undefined };
}

const NO_CACHE = "no-cache";
const IMMUTABLE = "public, max-age=31536000, immutable";

/** Vite emits content-hashed names into assets/ (e.g. index-B2x9fQ1a.js). */
function cacheControlFor(rel: string): string {
  const base = rel.split("/").pop() ?? rel;
  if (["index.html", "sw.js", "registerSW.js", "manifest.json"].includes(base) || base.endsWith(".webmanifest")) return NO_CACHE;
  if (rel.startsWith("assets/") || /[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|svg|jpg|webp|wasm)$/.test(base)) return IMMUTABLE;
  return "public, max-age=3600";
}

const placeholder = (msg: string) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>beamhop admin</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e6e8ee;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:36rem;padding:2rem;border:1px solid #232838;border-radius:12px;background:#11141c}code{background:#1b2030;padding:.15rem .35rem;border-radius:4px}</style></head>
<body><main><h1>beamhop admin</h1><p>${msg}</p><p>Build it with <code>bun run build:ui</code> and restart, or set <code>BEAMHOP_ADMIN_UI_DIR</code>.</p><p>The admin REST API is available at <code>/admin/api</code>.</p></main></body></html>`;

/**
 * Serves the admin SPA mounted at `/admin`. `subPath` is the path after `/admin/` (no leading slash).
 * Returns undefined only for non-GET/HEAD methods.
 */
export async function serveAdminAsset(source: AssetSource, subPath: string, req: Request): Promise<Response | undefined> {
  if (req.method !== "GET" && req.method !== "HEAD") return undefined;
  let rel: string;
  try {
    rel = decodeURIComponent(subPath).replace(/^\/+/, "");
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (rel.split("/").includes("..")) return new Response("forbidden", { status: 403 });

  if (source.kind === "none") {
    return new Response(placeholder("The admin UI has not been built yet."), { status: 200, headers: { "content-type": MIME[".html"], "cache-control": NO_CACHE } });
  }

  let file = rel === "" ? undefined : source.resolve(rel);
  let servedRel = rel;
  if (!file) {
    // SPA fallback: extension-less paths (client routes) → index.html; missing assets → 404
    const hasExt = extname(rel) !== "" && !rel.endsWith(".html");
    if (hasExt) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
    file = source.resolve("index.html");
    servedRel = "index.html";
    if (!file) return new Response("admin ui missing index.html", { status: 500 });
  }
  const headers: Record<string, string> = {
    "content-type": mimeFor(servedRel),
    "cache-control": cacheControlFor(servedRel),
    "x-content-type-options": "nosniff",
  };
  if (servedRel === "sw.js") headers["service-worker-allowed"] = "/admin/";
  if (servedRel === "index.html") headers["x-frame-options"] = "DENY";
  if (req.method === "HEAD") return new Response(null, { headers });
  return new Response(fileBody(file), { headers });
}
