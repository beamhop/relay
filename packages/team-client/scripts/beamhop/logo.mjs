// SPDX-License-Identifier: AGPL-3.0-or-later
// Regenerate static/beamhop-logo.png (the source for PWA icons) from static/beamhop-logo.svg:
//   bun scripts/beamhop/logo.mjs

import {fileURLToPath} from "node:url"
import sharp from "sharp"

const at = path => fileURLToPath(new URL(`../../${path}`, import.meta.url))

await sharp(at("static/beamhop-logo.svg")).resize(512, 512).png().toFile(at("static/beamhop-logo.png"))

console.log("[beamhop] wrote static/beamhop-logo.png")
