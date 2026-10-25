/**
 * Single-file executable: `bun build --compile` with the admin UI embedded.
 * Generates .build/embedded-ui.ts importing every admin-ui/dist file `with { type: "file" }`
 * so Bun embeds them; the entry registers them via setEmbeddedUi() before running the CLI.
 * bun:sqlite is used for SQLite; sharp/better-sqlite3 are excluded (thumbnails disabled).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(import.meta.dir, "..");
const gen = join(root, ".build");
const uiDist = resolve(process.env.BEAMHOP_UI_DIST ?? resolve(root, "../admin-ui/dist"));
const outfile = process.env.BEAMHOP_BINARY_OUT ?? join(root, "dist/beamhop");
const target = process.env.BEAMHOP_BINARY_TARGET; // e.g. bun-linux-x64

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

rmSync(gen, { recursive: true, force: true });
mkdirSync(gen, { recursive: true });
const files = existsSync(join(uiDist, "index.html")) ? walk(uiDist).filter((f) => !f.endsWith(".map")) : [];
if (!files.length) console.warn("warning: packages/admin-ui/dist not found — binary will serve a placeholder at /admin (run `bun run build:ui` first)");

const lines = files.map((f, i) => `import f${i} from ${JSON.stringify(relative(gen, f).split("\\").join("/").replace(/^(?!\.)/, "./"))} with { type: "file" };`);
lines.push(`export const files: Record<string, string> = {`);
files.forEach((f, i) => lines.push(`  ${JSON.stringify(relative(uiDist, f).split("\\").join("/"))}: f${i},`));
lines.push(`};`);
writeFileSync(join(gen, "embedded-ui.ts"), lines.join("\n") + "\n");
writeFileSync(join(gen, "no-autorun.ts"), `(globalThis as { __BEAMHOP_NO_AUTORUN__?: boolean }).__BEAMHOP_NO_AUTORUN__ = true;\nexport {};\n`);
// @peculiar/x509 (via @simplewebauthn/server) needs reflect-metadata loaded before tsyringe
let preload = "";
try {
  const x509 = Bun.resolveSync("@peculiar/x509", Bun.resolveSync("@simplewebauthn/server", resolve(root, "../admin-api")));
  preload = `import ${JSON.stringify(Bun.resolveSync("reflect-metadata", x509))};\n`;
} catch {
  /* nothing to preload */
}
// an embedded entry point is found by its path relative to the entry points' common directory
const verifyWorker = resolve(root, "../core/src/pipeline/verify-worker.ts");
const commonDir = (a: string, b: string) => {
  const x = a.split(sep);
  const y = b.split(sep);
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return x.slice(0, i).join(sep);
};
const workerSpec = "./" + relative(commonDir(gen, resolve(verifyWorker, "..")), verifyWorker).split(sep).join("/");
writeFileSync(
  join(gen, "entry.ts"),
  `${preload}import "./no-autorun.ts";
import { files } from "./embedded-ui.ts";
import { setEmbeddedUi } from "../src/static.ts";
import { setVerifyWorkerPath } from "../../core/src/pipeline/verify-pool.ts";
import { main } from "../src/cli.ts";
setEmbeddedUi(files);
setVerifyWorkerPath(${JSON.stringify(workerSpec)});
main().catch((err) => {
  console.error("error: " + (err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
`,
);

mkdirSync(resolve(outfile, ".."), { recursive: true });
const args = [
  // the signature verification worker is an extra entry point (found through setVerifyWorkerPath above)
  "build", "--compile", join(gen, "entry.ts"), verifyWorker, "--outfile", outfile, "--minify-syntax", "--minify-whitespace",
  "--external", "better-sqlite3", "--external", "sharp",
  ...(target ? ["--target", target] : []),
];
const proc = Bun.spawnSync([process.execPath, ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
rmSync(gen, { recursive: true, force: true });
if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
console.log(`built ${outfile} (${files.length} admin-ui files embedded)`);
