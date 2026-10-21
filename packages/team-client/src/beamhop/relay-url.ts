// SPDX-License-Identifier: AGPL-3.0-or-later
// Intranet relay hosts (PLAN §12.10, air-gapped installs): `isRelayUrl` in @welshman/util rejects
// hosts without a dot (other than localhost), so a home relay like `ws://relay:3334` could not be
// used. scripts/beamhop/vite-plugin.ts patches that one check (see `patchIsRelayUrl`) to also
// ask `globalThis.__beamhopIsIntranetHost`, which accepts ONLY the dotless hosts of the home
// relay, the configured allowedRelays and relays Beamhop handed us (bunker) — never arbitrary
// single-label names from events or relay lists.

import {getAllowedRelays} from "./federation"

declare global {
  var __beamhopIsIntranetHost: ((hostname: string) => boolean) | undefined
}

const hostOf = (url: string) => {
  try {
    return new URL(url.includes("://") ? url : `wss://${url}`).hostname.toLowerCase()
  } catch {
    return ""
  }
}

/** Dotless hostnames among the relays this workspace trusts. */
export const intranetHosts = () => {
  const hosts = new Set<string>()

  for (const url of getAllowedRelays()) {
    const host = hostOf(url)

    if (host && !host.includes(".") && host !== "localhost") hosts.add(host)
  }

  return hosts
}

export const isIntranetHost = (hostname: string) => {
  const host = hostname.toLowerCase()

  return !host.includes(".") && intranetHosts().has(host)
}

export const installIntranetRelayHosts = () => {
  globalThis.__beamhopIsIntranetHost = isIntranetHost
}
