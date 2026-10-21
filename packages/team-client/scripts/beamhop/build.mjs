// SPDX-License-Identifier: AGPL-3.0-or-later
// Beamhop static web build (replaces upstream scripts/build/app.sh + web.sh, which also drive
// Capacitor native builds and expect a git checkout + upstream `.env`).
//
//   bun run build                    -> build/ (static, served by Beamhop at /app)
//   BEAMHOP_BASE="" bun run build    -> build/ served at the domain root
//
// Output: packages/team-client/build

import {spawnSync} from "node:child_process"
import {readFileSync, readdirSync, writeFileSync} from "node:fs"
import {delimiter, join} from "node:path"
import {fileURLToPath} from "node:url"
import {applyBeamhopBuildEnv} from "./env.mjs"

const root = fileURLToPath(new URL("../..", import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
const env = applyBeamhopBuildEnv({...process.env})

// Deterministic chunk names (upstream uses the git short hash).
env.VITE_BUILD_HASH ||= `beamhop-${pkg.version}`
env.PATH = [join(root, "node_modules", ".bin"), env.PATH].join(delimiter)

const run = (cmd, args) => {
  const result = spawnSync(cmd, args, {cwd: root, env, stdio: "inherit"})
  if (result.status !== 0) {
    console.error(`[beamhop] ${cmd} ${args.join(" ")} failed`)
    process.exit(result.status ?? 1)
  }
}

// PWA icons from the platform logo (writes static/pwa-*.png, favicon.ico, ...; gitignored).
run("pwa-assets-generator", [])
run("vite", ["build"])

// Fill app.html placeholders, as upstream web.sh does with perl.
const replacements = {
  "{NAME}": env.VITE_PLATFORM_NAME,
  "{DESCRIPTION}": env.VITE_PLATFORM_DESCRIPTION,
  "{ACCENT}": env.VITE_PLATFORM_ACCENT,
  "{URL}": env.VITE_PLATFORM_URL || `${env.BEAMHOP_BASE}/`,
}

const buildDir = join(root, "build")

for (const file of readdirSync(buildDir).filter(f => f.endsWith(".html"))) {
  const path = join(buildDir, file)
  let html = readFileSync(path, "utf8")
  for (const [key, value] of Object.entries(replacements)) html = html.replaceAll(key, value)
  writeFileSync(path, html)
}

console.log(`[beamhop] static build ready in ${buildDir} (base path "${env.BEAMHOP_BASE}")`)
