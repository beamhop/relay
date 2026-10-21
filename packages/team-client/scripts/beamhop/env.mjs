// SPDX-License-Identifier: AGPL-3.0-or-later
// Beamhop build-time defaults for the Flotilla VITE_* settings (replaces upstream's `.env`).
//
// Values left empty here are filled in at runtime from the page location by
// src/beamhop/env.ts (home relay = same-origin WebSocket, platform URL = origin + base path,
// Blossom = same origin), so a company instance works with zero configuration.
// Any variable already present in the environment wins over these defaults.

export const BEAMHOP_BASE_DEFAULT = "/app"

export const beamhopBuildEnv = {
  // Branding
  VITE_PLATFORM_NAME: "Beamhop Team",
  VITE_PLATFORM_DESCRIPTION: "Team chat for your company, on your own Beamhop server.",
  VITE_PLATFORM_ACCENT: "#5aa9e6",
  VITE_PLATFORM_LOGO: "static/beamhop-logo.png",
  VITE_THEME: "beamhop",
  VITE_BEAMHOP_BACKGROUND: "#0b1017",
  VITE_PLATFORM_ABOUT: "",
  VITE_PLATFORM_TERMS: "",
  VITE_PLATFORM_PRIVACY: "",
  VITE_PLATFORM_LOGEE: "",

  // Relays: empty means "the home relay" (derived at runtime from location).
  VITE_PLATFORM_URL: "",
  VITE_PLATFORM_RELAYS: "",
  VITE_DEFAULT_RELAYS: "",
  VITE_INDEXER_RELAYS: "",
  VITE_DEFAULT_SEARCH_RELAYS: "",
  VITE_DEFAULT_MESSAGING_RELAYS: "",
  VITE_SIGNER_RELAYS: "",
  VITE_DEFAULT_SPACES: "",
  VITE_BLOCKED_RELAYS: "",
  // Optional explicit home relay (useful for `vite dev` against a separate Beamhop instance).
  VITE_BEAMHOP_HOME_RELAY: "",

  // Media: empty means same-origin Blossom.
  VITE_DEFAULT_BLOSSOM_SERVERS: "",
  VITE_THUMBNAIL_URL: "",

  // No third-party services by default (no telemetry, no hosted signers).
  // beamhop: no-payments - the upstream VITE_HOSTING_* (paid hosting) env vars are gone.
  VITE_DEFAULT_PUBKEYS: "",
  VITE_POMADE_SIGNERS: "",
  VITE_PUSH_SERVER: "",
  VITE_PUSH_BRIDGE: "",
  // Empty means `${origin}/api/v1/team/dufflepud` (not yet implemented by Beamhop).
  VITE_DUFFLEPUD_URL: "",
}

/** Copy defaults into process.env without overriding anything the caller already set. */
export const applyBeamhopBuildEnv = (env = process.env) => {
  for (const [key, value] of Object.entries(beamhopBuildEnv)) {
    if (env[key] === undefined) env[key] = value
  }
  if (env.BEAMHOP_BASE === undefined) env.BEAMHOP_BASE = BEAMHOP_BASE_DEFAULT
  return env
}
