import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface DiscoveredPlugin {
  /** folder or package name (used as fallback display name if loading fails) */
  id: string;
  /** absolute file path, or bare specifier when it couldn't be located on disk */
  entry: string;
  /** package root (for resolving `ui` paths) */
  root: string;
  source: "local" | "npm";
  version?: string;
  description?: string;
}

interface Pkg {
  name?: string;
  version?: string;
  description?: string;
  main?: string;
  module?: string;
  exports?: unknown;
  beamhop?: { entry?: string };
}

const readPkg = (dir: string): Pkg | undefined => {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
};

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const safeReaddir = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

function exportsEntry(exp: unknown): string | undefined {
  if (typeof exp === "string") return exp;
  if (!exp || typeof exp !== "object") return undefined;
  const e = exp as Record<string, unknown>;
  const dot = "." in e ? e["."] : e;
  if (typeof dot === "string") return dot;
  if (dot && typeof dot === "object") {
    const d = dot as Record<string, unknown>;
    for (const k of ["bun", "import", "node", "default"]) {
      const v = d[k];
      if (typeof v === "string") return v;
      if (v && typeof v === "object" && typeof (v as Record<string, unknown>).default === "string") return (v as Record<string, string>).default;
    }
  }
  return undefined;
}

const DEFAULT_ENTRIES = ["index.ts", "index.js", "index.mjs", "src/index.ts", "src/index.js", "dist/index.js"];

/** Entry file of a plugin package dir: package.json `beamhop.entry` → `main`/`exports`/`module` → index.{ts,js}. */
export function resolvePackageEntry(dir: string): string | undefined {
  const pkg = readPkg(dir);
  const candidates = [pkg?.beamhop?.entry, pkg?.main, exportsEntry(pkg?.exports), pkg?.module, ...DEFAULT_ENTRIES].filter((c): c is string => !!c);
  for (const c of candidates) {
    const p = resolve(dir, c);
    if (isFile(p)) return p;
  }
  return undefined;
}

function nodeModulesDirs(from: string): string[] {
  const out: string[] = [];
  let dir = resolve(from);
  for (;;) {
    const nm = join(dir, "node_modules");
    if (isDir(nm)) out.push(nm);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

const PLUGIN_RE = /^beamhop-plugin-/;

/**
 * 1. every sub-folder (or single .ts/.js file) of `dir`
 * 2. node_modules packages named beamhop-plugin-* / @scope/beamhop-plugin-* (walking up from cwd)
 * 3. explicitly configured package names / paths
 * Duplicates (e.g. workspace symlinks of local plugins) are collapsed by real path.
 */
export function discoverPlugins(opts: { dir: string; packages: string[]; cwd?: string; autoDiscoverNpm?: boolean }): DiscoveredPlugin[] {
  const cwd = opts.cwd ?? process.cwd();
  const found: DiscoveredPlugin[] = [];
  const seen = new Set<string>();

  if (isDir(opts.dir)) {
    for (const name of safeReaddir(opts.dir).sort()) {
      if (name.startsWith(".") || name.startsWith("_") || name === "node_modules") continue;
      const root = join(opts.dir, name);
      if (isDir(root)) {
        const entry = resolvePackageEntry(root);
        if (!entry) continue;
        const pkg = readPkg(root);
        seen.add(real(root));
        found.push({ id: pkg?.name ?? name, entry, root, source: "local", version: pkg?.version, description: pkg?.description });
      } else if (/\.(ts|js|mjs)$/.test(name) && !/\.(test|spec|d)\.(ts|js)$/.test(name)) {
        seen.add(real(root));
        found.push({ id: name.replace(/\.(ts|js|mjs)$/, ""), entry: root, root: opts.dir, source: "local" });
      }
    }
  }

  const nmDirs = nodeModulesDirs(cwd);
  const addPackage = (pkgDir: string, fallbackName: string) => {
    const r = real(pkgDir);
    if (seen.has(r)) return;
    const entry = resolvePackageEntry(pkgDir);
    if (!entry) return;
    seen.add(r);
    const pkg = readPkg(pkgDir);
    found.push({ id: pkg?.name ?? fallbackName, entry, root: pkgDir, source: "npm", version: pkg?.version, description: pkg?.description });
  };
  if (opts.autoDiscoverNpm !== false) {
    for (const nm of nmDirs) {
      for (const name of safeReaddir(nm)) {
        if (PLUGIN_RE.test(name)) addPackage(join(nm, name), name);
        else if (name.startsWith("@")) for (const sub of safeReaddir(join(nm, name))) if (PLUGIN_RE.test(sub)) addPackage(join(nm, name, sub), `${name}/${sub}`);
      }
    }
  }
  for (const spec of opts.packages) {
    if (isAbsolute(spec) || spec.startsWith(".")) {
      const p = resolve(cwd, spec);
      if (isDir(p)) addPackage(p, spec);
      else if (isFile(p) && !seen.has(real(p))) {
        seen.add(real(p));
        found.push({ id: spec, entry: p, root: dirname(p), source: "npm" });
      }
      continue;
    }
    const dir = nmDirs.map((nm) => join(nm, ...spec.split("/"))).find(isDir);
    if (dir) addPackage(dir, spec);
    else if (!found.some((f) => f.id === spec)) found.push({ id: spec, entry: spec, root: cwd, source: "npm" });
  }
  return found;
}

export const importSpecifier = (entry: string) => (isAbsolute(entry) && existsSync(entry) ? pathToFileURL(entry).href : entry);
