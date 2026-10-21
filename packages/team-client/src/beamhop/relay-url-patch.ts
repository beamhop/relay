// SPDX-License-Identifier: AGPL-3.0-or-later
// Build-time half of the intranet relay host support (see ./relay-url.ts): a source transform
// for @welshman/util's Relay.js, used by scripts/beamhop/vite-plugin.ts. Pure (no app imports)
// so the Vite config can load it.

// The check upstream ships in @welshman/util `isRelayUrl` (dist/util/src/Relay.js).
const UPSTREAM_CHECK =
  /if \(!parsed\.hostname\.includes\("\."\) && parsed\.hostname !== "localhost"\)/

/**
 * Source transform for @welshman/util's Relay.js: let `isRelayUrl` accept trusted intranet
 * hosts. Returns null when the upstream code changed shape (the build then warns).
 */
export const patchIsRelayUrl = (code: string): string | null => {
  if (!UPSTREAM_CHECK.test(code)) return null

  return code.replace(
    UPSTREAM_CHECK,
    'if (!parsed.hostname.includes(".") && parsed.hostname !== "localhost" && !globalThis.__beamhopIsIntranetHost?.(parsed.hostname)) /* beamhop: intranet relay hosts */',
  )
}

/** Module ids the transform applies to. */
export const isWelshmanRelayModule = (id: string) =>
  /@welshman[\\/+]util[^?]*[\\/]dist[\\/]util[\\/]src[\\/]Relay\.js$/.test(id.split("?")[0] ?? "")
