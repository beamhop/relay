// SPDX-License-Identifier: AGPL-3.0-or-later
// Stub for `nostr-signer-capacitor-plugin` (NIP-55 Android signer bridge). Upstream installs it
// from GitHub and only uses it inside the Capacitor Android app, which Beamhop does not ship.
// Wired in by scripts/beamhop/vite-plugin.ts (bundling) and tsconfig paths (type checking).

const unavailable = () => {
  throw new Error("NIP-55 Android signer is not available in the Beamhop web build")
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const NostrSignerPlugin: any = new Proxy({}, {get: () => unavailable})
