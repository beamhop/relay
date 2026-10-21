// SPDX-License-Identifier: AGPL-3.0-or-later
// Runtime configuration served by Beamhop at `<base>/config.json` (e.g. /app/config.json).
//
// {
//   "allowedRelays": ["wss://partner.example.com/"],   // federation allowlist; [] = home only
//   "features": {
//     "sso": false,            // sign in with company SSO (managed key or self-custody link)
//     "escrowNotice": false,   // show the DM escrow disclosure banner (PLAN §12.8)
//     "directory": false       // company people directory (GET /api/v1/team/directory)
//   },
//   "escrowNotice": false,     // same as features.escrowNotice (either one turns it on)
//   "sso": {"providers": [{"id": "okta", "label": "Okta", "startUrl": "/api/v1/sso/okta/start?audience=team"}]},
//   "links": {"terms": "https://…", "privacy": "https://…"}   // legal links; hidden when absent
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

export type SsoProvider = {
  id: string
  label: string
  /** Same-origin path that starts the IdP sign-in (e.g. /api/v1/sso/okta/start?audience=team). */
  startUrl: string
}

export type BeamhopLinks = {
  terms?: string
  privacy?: string
}

export type BeamhopConfig = {
  allowedRelays: string[]
  features: BeamhopFeatures
  sso: {providers: SsoProvider[]}
  links: BeamhopLinks
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

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
  sso: {providers: []},
  links: {},
})

/** Legal links must be http(s) URLs or same-origin paths; anything else is dropped. */
const safeLink = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined

  const v = value.trim()

  if (v.startsWith("/") && !v.startsWith("//")) return v

  try {
    const url = new URL(v)

    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined
  } catch {
    return undefined
  }
}

/** SSO start URLs are same-origin paths only (never an absolute URL from config). */
const isProvider = (p: unknown): p is SsoProvider =>
  isRecord(p) &&
  typeof p.id === "string" &&
  typeof p.label === "string" &&
  typeof p.startUrl === "string" &&
  p.startUrl.startsWith("/") &&
  !p.startUrl.startsWith("//")

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

  // Top-level shorthand: {"escrowNotice": true}
  if (raw.escrowNotice === true) config.features.escrowNotice = true

  if (isRecord(raw.sso) && Array.isArray(raw.sso.providers)) {
    config.sso.providers = raw.sso.providers.filter(isProvider).map(p => ({
      id: p.id,
      label: p.label,
      startUrl: p.startUrl,
    }))
  }

  if (isRecord(raw.links)) {
    const terms = safeLink(raw.links.terms)
    const privacy = safeLink(raw.links.privacy)

    if (terms) config.links.terms = terms
    if (privacy) config.links.privacy = privacy
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
