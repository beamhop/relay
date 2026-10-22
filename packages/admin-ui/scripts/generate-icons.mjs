// Regenerates public/icons/*.png from public/favicon.svg. Usage: node scripts/generate-icons.mjs
// sharp isn't a dependency of admin-ui; it is resolved from the workspace (packages/blossom) or the bun store.
import { createRequire } from "node:module";
import { readFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
function loadSharp() {
  const candidates = [join(root, "../blossom/package.json"), join(root, "package.json")];
  for (const c of candidates) {
    try {
      return createRequire(c)("sharp");
    } catch {}
  }
  const store = join(root, "../../node_modules/.bun");
  const dir = readdirSync(store).find((d) => d.startsWith("sharp@"));
  if (dir) return createRequire(join(store, dir, "node_modules/sharp/package.json"))("sharp");
  throw new Error("sharp not found");
}
const sharp = loadSharp();
const svg = readFileSync(join(root, "public/favicon.svg"));
const maskable = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#5b21b6"/></linearGradient></defs><rect width="512" height="512" fill="url(#g)"/><g transform="translate(76.8 76.8) scale(0.7)"><path d="M104 360 Q184 92 264 360 Q324 196 384 300" fill="none" stroke="#fff" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/><circle cx="408" cy="200" r="36" fill="#fff"/></g></svg>`,
);
mkdirSync(join(root, "public/icons"), { recursive: true });
await sharp(svg, { density: 384 }).resize(192, 192).png().toFile(join(root, "public/icons/icon-192.png"));
await sharp(svg, { density: 384 }).resize(512, 512).png().toFile(join(root, "public/icons/icon-512.png"));
await sharp(maskable, { density: 384 }).resize(512, 512).png().toFile(join(root, "public/icons/maskable-512.png"));
console.log("icons written");
