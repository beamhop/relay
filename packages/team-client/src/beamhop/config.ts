// SPDX-License-Identifier: AGPL-3.0-or-later
// Runtime configuration served by Beamhop at `<base>/config.json` (e.g. /app/config.json).
//
// {
//   "allowedRelays": ["wss://partner.example.com/"],   // federation allowlist; [] = home only
//   "features": {
//     "sso": false,            // sign in with company SSO -> NIP-46 bunker (Wave 4)
//     "escrowNotice": false,   // show the DM escrow disclosure banner (PLAN §12.8)
//     "directory": false       // company people directory (Wave 4)
//   }
// }
//
// Missing or invalid config means the safe defaults below: home relay only, all features off.

import {writable, get} from "svelte/store"
import {base} from "$app/paths"

export type BeamhopFeatures = {
  sso: boolean
  escrowNotice: boolean
  directory: boolean
}

export type BeamhopConfig = {
  allowedRelays: string[]
  features: BeamhopFeatures
}

const csv = (value: unknown) =>
  typeof value === "string"
    ? value
        .split(",")
        .map(s => s.trim())
        .filter(Boolean)
    : []

/** Build-time allowlist (VITE_BEAMHOP_ALLOWED_RELAYS), merged with the runtime one. */
const buildAllowedRelays = csv(import.meta.env.VITE_BEAMHOP_ALLOWED_RELAYS)

export const defaultBeamhopConfig = (): BeamhopConfig => ({
  allowedRelays: [...buildAllowedRelays],
  features: {sso: false, escrowNotice: false, directory: false},
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Defensive parse: unknown keys are ignored, wrong types fall back to defaults. */
export const parseBeamhopConfig = (raw: unknown): BeamhopConfig => {
  const config = defaultBeamhopConfig()

  if (!isRecord(raw)) return config

  if (Array.isArray(raw.allowedRelays)) {
    const urls = raw.allowedRelays.filter((u): u is string => typeof u === "string" && u !== "")

    config.allowedRelays = [...new Set([...config.allowedRelays, ...urls])]
  }

  if (isRecord(raw.features)) {
    for (const key of Object.keys(config.features) as (keyof BeamhopFeatures)[]) {
      if (typeof raw.features[key] === "boolean") {
        config.features[key] = raw.features[key] as boolean
      }
    }
  }

  return config
}

export const beamhopConfig = writable<BeamhopConfig>(defaultBeamhopConfig())

export const beamhopConfigLoaded = writable(false)

export const getBeamhopConfig = () => get(beamhopConfig)

export const isFeatureEnabled = (feature: keyof BeamhopFeatures) =>
  getBeamhopConfig().features[feature]

let loading: Promise<BeamhopConfig> | undefined

/** Fetch `<base>/config.json` once. Failures keep the safe defaults. */
export const loadBeamhopConfig = (fetchImpl: typeof fetch = fetch) => {
  loading ??= (async () => {
    try {
      const res = await fetchImpl(`${base}/config.json`, {
        cache: "no-store",
        credentials: "same-origin",
      })

      if (res.ok) {
        beamhopConfig.set(parseBeamhopConfig(await res.json()))
      }
    } catch (e) {
      console.warn("[beamhop] could not load config.json, using defaults", e)
    } finally {
      beamhopConfigLoaded.set(true)
    }

    return getBeamhopConfig()
  })()

  return loading
}
