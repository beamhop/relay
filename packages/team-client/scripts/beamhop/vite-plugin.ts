// SPDX-License-Identifier: AGPL-3.0-or-later
// Beamhop Vite plugin: redirects a few imports of upstream (Flotilla) code to small shims in
// src/beamhop/shims so the app can run under a SvelteKit base path (/app) without touching the
// dozens of upstream call sites that assume the app lives at "/".
//
//   $app/stores, $app/state  -> `page.url` with the base path stripped
//   $app/navigation          -> goto/pushState/replaceState/preload* prefix the base path
//
// Only importers inside src/ (and outside src/beamhop/) are redirected; the shims themselves
// import the real modules.

import {dirname, join, resolve, sep} from "node:path"
import {fileURLToPath} from "node:url"
import type {Plugin} from "vite"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const srcDir = join(root, "src") + sep
const beamhopDir = join(root, "src", "beamhop") + sep
const shimDir = join(root, "src", "beamhop", "shims")

const kitShims: [RegExp, string][] = [
  [/(^\$app\/stores$)|([\\/]runtime[\\/]app[\\/]stores(\.js)?$)/, "app-stores.ts"],
  [/(^\$app\/state$)|([\\/]runtime[\\/]app[\\/]state([\\/]index)?(\.js)?$)/, "app-state.ts"],
  [/(^\$app\/navigation$)|([\\/]runtime[\\/]app[\\/]navigation(\.js)?$)/, "app-navigation.ts"],
]

export const beamhop = (): Plugin => ({
  name: "beamhop",
  enforce: "pre",
  async resolveId(id, importer, options) {
    if (!importer) return null

    const from = importer.split("?")[0]

    if (from.startsWith(beamhopDir) || !from.startsWith(srcDir)) return null

    for (const [pattern, shim] of kitShims) {
      if (pattern.test(id)) {
        return this.resolve(join(shimDir, shim), importer, {...options, skipSelf: true})
      }
    }

    return null
  },
})
