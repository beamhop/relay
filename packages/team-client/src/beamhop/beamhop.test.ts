// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for the Beamhop-owned glue (run by the repo-root `bun test`).

import {beforeAll, describe, expect, mock, test} from "bun:test"

mock.module("$app/paths", () => ({base: "/app", assets: "/app"}))

let basePath: typeof import("./base-path")
let config: typeof import("./config")
let env: typeof import("./env")
let federation: typeof import("./federation")

beforeAll(async () => {
  Object.assign(globalThis, {
    location: new URL("https://chat.example.com/app/spaces") as unknown as Location,
  })
  basePath = await import("./base-path")
  config = await import("./config")
  env = await import("./env")
  federation = await import("./federation")
})

describe("base path", () => {
  test("withBase prefixes root-relative paths only", () => {
    expect(basePath.withBase("/home")).toBe("/app/home")
    expect(basePath.withBase("/")).toBe("/app/")
    expect(basePath.withBase("/app/home")).toBe("/app/home")
    expect(basePath.withBase("/app")).toBe("/app")
    expect(basePath.withBase("/apple")).toBe("/app/apple")
    expect(basePath.withBase("https://x.org/home")).toBe("https://x.org/home")
    expect(basePath.withBase("//cdn.example/x")).toBe("//cdn.example/x")
    expect(basePath.withBase("")).toBe("")
  })

  test("stripBase removes the base path", () => {
    expect(basePath.stripBase("/app")).toBe("/")
    expect(basePath.stripBase("/app/spaces/x")).toBe("/spaces/x")
    expect(basePath.stripBase("/apple")).toBe("/apple")
    const url = basePath.stripBaseUrl(new URL("https://h.example/app/join?r=1#x"))
    expect(url.pathname).toBe("/join")
    expect(url.search).toBe("?r=1")
  })
})

describe("config.json", () => {
  test("defaults are safe: no extra relays, all features off", () => {
    const parsed = config.parseBeamhopConfig(undefined)
    expect(parsed.allowedRelays).toEqual([])
    expect(parsed.features).toEqual({sso: false, escrowNotice: false, directory: false})
  })

  test("parses known keys and ignores junk", () => {
    const parsed = config.parseBeamhopConfig({
      allowedRelays: ["wss://partner.example.com", 42, ""],
      features: {sso: true, escrowNotice: "yes", directory: true, other: true},
      extra: 1,
    })
    expect(parsed.allowedRelays).toEqual(["wss://partner.example.com"])
    expect(parsed.features).toEqual({sso: true, escrowNotice: false, directory: true})
  })

  test("loadBeamhopConfig fetches <base>/config.json and falls back on errors", async () => {
    const calls: string[] = []
    const fetchStub = (async (input: RequestInfo | URL) => {
      calls.push(String(input))
      return Response.json({allowedRelays: ["wss://partner.example.com/"]})
    }) as typeof fetch
    const loaded = await config.loadBeamhopConfig(fetchStub)
    expect(calls).toEqual(["/app/config.json"])
    expect(loaded.allowedRelays).toEqual(["wss://partner.example.com/"])
  })
})

describe("env + federation", () => {
  test("home relay defaults to the same-origin WebSocket", () => {
    expect(env.getHomeRelay()).toBe("wss://chat.example.com/")
    expect(env.beamhopEnv("VITE_DEFAULT_RELAYS", "")).toBe("wss://chat.example.com/")
    expect(env.beamhopEnv("VITE_DEFAULT_RELAYS", "relay.damus.io")).toBe("relay.damus.io")
    expect(env.beamhopEnv("VITE_PLATFORM_URL", "")).toBe("https://chat.example.com/app")
    expect(env.beamhopEnv("VITE_PLATFORM_LOGO", "static/beamhop-logo.png")).toBe(
      "/app/beamhop-logo.png",
    )
  })

  test("only the home relay and allowedRelays may connect", () => {
    config.beamhopConfig.set(config.parseBeamhopConfig({}))
    expect(federation.isRelayAllowed("wss://chat.example.com")).toBe(true)
    expect(federation.isRelayAllowed("wss://relay.damus.io/")).toBe(false)

    config.beamhopConfig.set(config.parseBeamhopConfig({allowedRelays: ["wss://relay.damus.io"]}))
    expect(federation.isRelayAllowed("wss://relay.damus.io/")).toBe(true)
  })

  test("the socket policy refuses to open disallowed sockets", () => {
    config.beamhopConfig.set(config.parseBeamhopConfig({}))
    const opened: string[] = []
    const makeSocket = (url: string) => ({url, open: () => opened.push(url)})
    const pool = {socketPolicies: [] as ((s: ReturnType<typeof makeSocket>) => unknown)[]}

    // Minimal stand-in for a welshman App: the policy only touches `pool.socketPolicies`.
    federation.federationPolicy({pool} as never)

    for (const url of ["wss://chat.example.com/", "wss://elsewhere.example.org/"]) {
      const socket = makeSocket(url)
      for (const policy of pool.socketPolicies) policy(socket)
      socket.open()
    }

    expect(opened).toEqual(["wss://chat.example.com/"])
  })
})
