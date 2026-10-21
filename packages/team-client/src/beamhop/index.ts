// SPDX-License-Identifier: AGPL-3.0-or-later
// Beamhop Team entry point. Imported once from src/routes/+layout.svelte, right after
// "@app/core/policies" so the federation policy is in place before the first welshman app is
// built. Everything Beamhop-specific lives in src/beamhop/ to keep upstream merges easy.

import {appPolicies} from "@app/core/app"
import {installLinkBasePath} from "./base-path"
import {loadBeamhopConfig} from "./config"
import {federationPolicy} from "./federation"
import {loadDirectory} from "./features/directory"

appPolicies.push(federationPolicy)

if (typeof window !== "undefined") {
  installLinkBasePath()
  loadBeamhopConfig().then(() => loadDirectory())
}

export {default as EscrowNotice} from "./components/EscrowNotice.svelte"
export * from "./config"
export {isRelayAllowed} from "./federation"
export {getHomeRelay} from "./env"
export {requestTeamSession, isSsoEnabled} from "./features/sso"
export {directory, isDirectoryEnabled} from "./features/directory"
