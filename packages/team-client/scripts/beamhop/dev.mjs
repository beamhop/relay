// SPDX-License-Identifier: AGPL-3.0-or-later
// `vite dev` with Beamhop defaults. Point it at a running Beamhop with
//   VITE_BEAMHOP_HOME_RELAY=ws://localhost:3000 bun run dev

import {spawnSync} from "node:child_process"
import {delimiter, join} from "node:path"
import {fileURLToPath} from "node:url"
import {applyBeamhopBuildEnv} from "./env.mjs"

const root = fileURLToPath(new URL("../..", import.meta.url))
const env = applyBeamhopBuildEnv({...process.env})

env.PATH = [join(root, "node_modules", ".bin"), env.PATH].join(delimiter)

const result = spawnSync("vite", ["dev", ...process.argv.slice(2)], {cwd: root, env, stdio: "inherit"})

process.exit(result.status ?? 0)
