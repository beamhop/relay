/**
 * Node build: bundles the CLI for `node` (>= 22) into dist/node/cli.js, copies the built admin UI next to it
 * and writes a publishable package.json (published to npm as `beamhop`, so `npx beamhop` works).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");
const out = join(root, "dist/node");
const uiDist = resolve(process.env.BEAMHOP_UI_DIST ?? resolve(root, "../admin-ui/dist"));
const pkgJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const self = pkgJson(join(root, "package.json"));

// native / optional deps stay external and become dependencies of the published package
const external = ["better-sqlite3", "sharp", "postgres", "bufferutil", "utf-8-validate", "bun:sqlite", "bun"];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// @peculiar/x509 (via @simplewebauthn/server) needs reflect-metadata loaded before tsyringe; in the CJS-wrapped
// bundle that ordering is lost, so the entry imports it first.
const preload: string[] = [];
try {
  const x509 = Bun.resolveSync("@peculiar/x509", Bun.resolveSync("@simplewebauthn/server", resolve(root, "../admin-api")));
  preload.push(Bun.resolveSync("reflect-metadata", x509));
} catch {
  /* admin-api without webauthn: nothing to preload */
}
const buildDir = join(root, ".build");
mkdirSync(buildDir, { recursive: true });
const entry = join(buildDir, "node-entry.ts");
// relative specifiers: the entry's source ends up in the published cli.js.map, which shouldn't carry the build
// machine's paths
const spec = (f: string) => JSON.stringify(relative(buildDir, f).split(sep).join("/").replace(/^(?!\.)/, "./"));
writeFileSync(entry, [...preload, join(root, "src/cli.ts")].map((f) => `import ${spec(f)};`).join("\n") + "\n");

const result = await Bun.build({
  entrypoints: [entry],
  outdir: out,
  target: "node",
  format: "esm",
  external,
  minify: { syntax: true, whitespace: false, identifiers: false },
  sourcemap: "linked",
  banner: "#!/usr/bin/env node",
  naming: "cli.js",
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
chmodSync(join(out, "cli.js"), 0o755);

// the signature verification worker runs as its own file next to cli.js (core's VerifyPool looks for it there)
const worker = await Bun.build({
  entrypoints: [resolve(root, "../core/src/pipeline/verify-worker.ts")],
  outdir: out,
  target: "node",
  format: "esm",
  minify: { syntax: true, whitespace: false, identifiers: false },
  naming: "verify-worker.js",
});
if (!worker.success) {
  for (const log of worker.logs) console.error(log);
  process.exit(1);
}

if (existsSync(join(uiDist, "index.html"))) {
  cpSync(uiDist, join(out, "admin-ui"), { recursive: true });
  console.log("copied admin UI → dist/node/admin-ui");
} else {
  console.warn("warning: packages/admin-ui/dist not found — the node build will serve a placeholder at /admin (run `bun run build:ui` first)");
}

// versions of external deps, taken from the workspace packages that use them
const depVersion = (name: string) => {
  for (const p of ["storage", "blossom", "metrics", "core", "admin-api"]) {
    const f = resolve(root, `../${p}/package.json`);
    if (!existsSync(f)) continue;
    const j = pkgJson(f);
    const v = j.dependencies?.[name] ?? j.optionalDependencies?.[name];
    if (v) return v as string;
  }
  return undefined;
};
const deps: Record<string, string> = {};
const optional: Record<string, string> = {};
for (const d of ["better-sqlite3", "postgres"]) { const v = depVersion(d); if (v) deps[d] = v; }
for (const d of ["sharp", "bufferutil", "utf-8-validate"]) { const v = depVersion(d); if (v) optional[d] = v; }

writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      name: "beamhop",
      version: self.version,
      description: "Nostr relay + Blossom media server + PWA admin panel + plugins",
      license: "MIT",
      type: "module",
      bin: { beamhop: "./cli.js" },
      main: "./cli.js",
      engines: { node: ">=22" },
      dependencies: deps,
      optionalDependencies: optional,
      keywords: ["nostr", "relay", "blossom", "nip-01", "nip-11", "nip-86"],
    },
    null,
    2,
  ) + "\n",
);
for (const f of ["README.md", "LICENSE"]) {
  const p = resolve(root, "../..", f);
  if (existsSync(p)) cpSync(p, join(out, f));
}
console.log(`built ${join(out, "cli.js")} — run: node ${join("packages/server/dist/node/cli.js")} start`);
