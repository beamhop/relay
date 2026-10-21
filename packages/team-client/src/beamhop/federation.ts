// SPDX-License-Identifier: AGPL-3.0-or-later
// Federation control (PLAN §12.10): internal relays only by default.
//
// The client may only open sockets to the home relay plus `allowedRelays` from config.json
// (or VITE_BEAMHOP_ALLOWED_RELAYS). Everything else — relays from user relay lists, indexers,
// relay hints in events — is silently not connected. Until config.json has loaded, only the
// home relay is allowed (fail closed).

import type {Socket} from "@welshman/net"
import type {AppPolicy} from "@welshman/app"
import {LOCAL_RELAY_URL, normalizeRelayUrl} from "@welshman/util"
import {getBeamhopConfig} from "./config"
import {getHomeRelay} from "./env"

const normalize = (url: string) => {
  try {
    return normalizeRelayUrl(url)
  } catch {
    return url
  }
}

/** Relays Beamhop itself handed us at runtime (e.g. the NIP-46 bunker relays of a team session). */
const trustedRelays = new Set<string>()

export const trustRelays = (urls: string[]) => {
  for (const url of urls) if (url) trustedRelays.add(normalize(url))
}

export const getAllowedRelays = () => {
  const home = getHomeRelay()

  return new Set([
    ...[...(home ? [home] : []), ...getBeamhopConfig().allowedRelays].map(normalize),
    ...trustedRelays,
  ])
}

export const isRelayAllowed = (url: string) =>
  url === LOCAL_RELAY_URL || getAllowedRelays().has(normalize(url))

const federationSocketPolicy = (socket: Socket) => {
  const previousOpen = socket.open

  socket.open = () => {
    if (!isRelayAllowed(socket.url)) {
      return
    }

    previousOpen()
  }

  return () => {
    socket.open = previousOpen
  }
}

/** Welshman app policy installing the socket allowlist on the app's pool. */
export const federationPolicy: AppPolicy = $app => {
  $app.pool.socketPolicies.push(federationSocketPolicy)

  return () => {
    $app.pool.socketPolicies = $app.pool.socketPolicies.filter(p => p !== federationSocketPolicy)
  }
}
