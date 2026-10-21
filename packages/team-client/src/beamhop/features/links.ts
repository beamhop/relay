// SPDX-License-Identifier: AGPL-3.0-or-later
// Legal links (terms of service, privacy policy). Beamhop is self-hosted: there are no
// platform-wide terms, so the links come from `links` in config.json (or the build-time
// VITE_PLATFORM_TERMS / VITE_PLATFORM_PRIVACY) and are hidden when absent.

import {derived} from "svelte/store"
import {beamhopConfig, type BeamhopLinks} from "../config"

const buildLink = (value: unknown) => (typeof value === "string" && value ? value : undefined)

const buildTerms = buildLink(import.meta.env.VITE_PLATFORM_TERMS)
const buildPrivacy = buildLink(import.meta.env.VITE_PLATFORM_PRIVACY)

/** Effective links: config.json first, then the build-time values. */
export const resolveLegalLinks = (links: BeamhopLinks): BeamhopLinks => {
  const out: BeamhopLinks = {}
  const terms = links.terms ?? buildTerms
  const privacy = links.privacy ?? buildPrivacy

  if (terms) out.terms = terms
  if (privacy) out.privacy = privacy

  return out
}

export const legalLinks = derived(beamhopConfig, $config => resolveLegalLinks($config.links))
