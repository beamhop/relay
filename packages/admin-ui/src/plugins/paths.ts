/**
 * Path handling for a plugin UI's `api.fetch(path)`: the request must stay inside the plugin's own proxy namespace
 * `<apiBase>/plugins/x/<name>/`. A leading "/" means the plugin's root, as before; absolute URLs, protocol-relative
 * paths, dot segments (also percent-encoded), encoded slashes and control characters (which URL parsing strips,
 * turning ".\t." into "..") are refused.
 * No DOM or React imports: unit-tested in test/plugin-paths.test.ts.
 */

export class PluginPathError extends Error {
  constructor(path: string) {
    super(`plugin fetch path not allowed: ${JSON.stringify(path)}`);
    this.name = "PluginPathError";
  }
}

/** `<apiBase>/plugins/x/<name>/` */
export const pluginApiPrefix = (apiBase: string, name: string) => `${apiBase.replace(/\/+$/, "")}/plugins/x/${encodeURIComponent(name)}/`;

/** Normalised path (no leading slash, query kept) relative to the plugin namespace; throws PluginPathError. */
export function pluginRelativePath(path: string): string {
  if (typeof path !== "string") throw new PluginPathError(String(path));
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(path)) throw new PluginPathError(path);
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith("//")) throw new PluginPathError(path);
  const cut = path.search(/[?#]/);
  const pathname = (cut < 0 ? path : path.slice(0, cut)).replace(/^\/+/, "");
  const query = cut < 0 ? "" : path.slice(cut).replace(/#.*$/, "");
  for (const seg of pathname.split("/")) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      throw new PluginPathError(path);
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\")) throw new PluginPathError(path);
  }
  return pathname + query;
}

/** Full same-origin URL path for a plugin's fetch; throws PluginPathError when it would leave the namespace. */
export function pluginFetchUrl(apiBase: string, name: string, path: string): string {
  const prefix = pluginApiPrefix(apiBase, name);
  const url = prefix + pluginRelativePath(path);
  // belt and braces: what the browser will actually request must still be under the prefix
  if (!new URL(url, "http://host.invalid").pathname.startsWith(prefix)) throw new PluginPathError(path);
  return url;
}
