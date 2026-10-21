// SPDX-License-Identifier: AGPL-3.0-or-later
// Runtime defaults for upstream's VITE_* settings (hooked into src/app/core/env.ts).
//
// A Beamhop build leaves relay/service settings empty (scripts/beamhop/env.mjs); here they are
// filled from the page location so a company instance works with zero configuration:
//   home relay   = same-origin WebSocket (wss://<host>/), or VITE_BEAMHOP_HOME_RELAY
//   platform URL = <origin><base>       (links, invites)
//   Blossom      = <origin>/            (same-origin media server)
// Non-empty build-time values always win, so upstream-style deployments still work.

import {base} from "$app/paths"

const hasLocation = typeof location !== "undefined" && Boolean(location.host)

const sameOriginWs = () => {
  if (!hasLocation) return ""

  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/`
}

/** The relay this client belongs to. Everything defaults to it. */
export const getHomeRelay = (): string =>
  (import.meta.env.VITE_BEAMHOP_HOME_RELAY as string | undefined) || sameOriginWs()

const origin = () => (hasLocation ? location.origin : "")

const relayKeys = new Set([
  // Upstream normalizes this at module load, so it must not be empty (only used by native push).
  "VITE_PUSH_BRIDGE",
  "VITE_PLATFORM_RELAYS",
  "VITE_DEFAULT_RELAYS",
  "VITE_INDEXER_RELAYS",
  "VITE_DEFAULT_SEARCH_RELAYS",
  "VITE_DEFAULT_MESSAGING_RELAYS",
  "VITE_SIGNER_RELAYS",
])

const runtimeDefault = (key: string): string | undefined => {
  if (relayKeys.has(key)) return getHomeRelay()

  switch (key) {
    case "VITE_PLATFORM_URL":
      return origin() + base
    case "VITE_PLATFORM_ABOUT":
      // Beamhop's own landing page / portal at the domain root.
      return origin() ? `${origin()}/` : ""
    case "VITE_DEFAULT_BLOSSOM_SERVERS":
      return origin() ? `${origin()}/` : ""
    case "VITE_DUFFLEPUD_URL":
      // Link previews, read-state sync, map tiles. Not implemented by Beamhop yet; keeping it
      // same-origin means nothing leaks to a third-party service by default.
      return origin() ? `${origin()}/api/v1/team/dufflepud` : ""
    case "VITE_PUSH_SERVER":
      // Web push subscriptions. Not implemented by Beamhop yet (same-origin, never third-party).
      return origin() ? `${origin()}/api/v1/team/push` : ""
    case "VITE_THEME":
      return "beamhop"
    default:
      return undefined
  }
}

/** Upstream env lookup hook: returns `value` unless it is empty and Beamhop has a default. */
export const beamhopEnv = (key: string, value: string | undefined): string => {
  if (key === "VITE_PLATFORM_LOGO" && value) {
    // Upstream strips "static" and serves from "/"; under a base path the asset lives at <base>/
    return value.replace(/^static/, base)
  }

  if (value) return value

  return runtimeDefault(key) ?? value ?? ""
}
