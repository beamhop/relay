// SPDX-License-Identifier: AGPL-3.0-or-later
// Beamhop Team entry point. Imported once from src/routes/+layout.svelte, right after
// "@app/core/policies" so the federation policy is in place before the first welshman app is
// built. Everything Beamhop-specific lives in src/beamhop/ to keep upstream merges easy.

import {appPolicies} from "@app/core/app"
import {installLinkBasePath} from "./base-path"
import {loadBeamhopConfig} from "./config"
import {federationPolicy} from "./federation"
import {loadDirectory} from "./features/directory"
import {loadOutboundPolicy, outboundPublishPolicy} from "./features/outbound"
import {installIntranetRelayHosts} from "./relay-url"

appPolicies.push(federationPolicy)
appPolicies.push(outboundPublishPolicy)
installIntranetRelayHosts()

if (typeof window !== "undefined") {
  installLinkBasePath()
  loadBeamhopConfig().then(() => loadDirectory())
  loadOutboundPolicy()
}

export {default as EscrowNotice} from "./components/EscrowNotice.svelte"
export {default as BeamhopOverlay} from "./components/BeamhopOverlay.svelte"
export * from "./config"
export {isRelayAllowed, trustRelays} from "./federation"
export {getHomeRelay} from "./env"
export {isIntranetHost} from "./relay-url"
export {
  requestTeamSession,
  signInWithTeamSession,
  isSsoEnabled,
  TeamSessionError,
  type TeamSession,
} from "./features/sso"
export {directory, directoryState, isDirectoryEnabled, loadDirectory} from "./features/directory"
export {legalLinks} from "./features/links"
export {
  deriveGroupOutbound,
  loadOutboundPolicy,
  outboundPolicy,
  selectPublishRelays,
  type OutboundPolicy,
} from "./features/outbound"
