// SPDX-License-Identifier: AGPL-3.0-or-later
// Unit tests for Beamhop Team features: company sign-in, directory, legal links, escrow notice,
// intranet relay hosts (run by the repo-root `bun test`).

import {mkdtempSync, readFileSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {join} from "node:path"
import {beforeAll, describe, expect, mock, test} from "bun:test"
import {get} from "svelte/store"

mock.module("$app/paths", () => ({base: "/app", assets: "/app"}))

let config: typeof import("./config")
let sso: typeof import("./features/sso")
let directory: typeof import("./features/directory")
let links: typeof import("./features/links")
let escrow: typeof import("./features/escrow")
let relayUrl: typeof import("./relay-url")
let patch: typeof import("./relay-url-patch")
let federation: typeof import("./federation")

const PK = "a".repeat(64)
const OTHER = "b".repeat(64)

beforeAll(async () => {
  Object.assign(globalThis, {
    location: new URL("https://chat.example.com/app/") as unknown as Location,
  })
  config = await import("./config")
  sso = await import("./features/sso")
  directory = await import("./features/directory")
  links = await import("./features/links")
  escrow = await import("./features/escrow")
  relayUrl = await import("./relay-url")
  patch = await import("./relay-url-patch")
  federation = await import("./federation")
})

const enable = (features: Record<string, boolean>, extra: Record<string, unknown> = {}) =>
  config.beamhopConfig.set(config.parseBeamhopConfig({features, ...extra}))

type Route = (init: RequestInit | undefined) => Response | Promise<Response>

/** fetch stub keyed by "METHOD path"; records calls. */
const stubFetch = (routes: Record<string, Route | Route[]>) => {
  const calls: Array<{key: string; body?: unknown}> = []
  const queues = new Map(
    Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]),
  )
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${String(input)}`
    calls.push({key, body: init?.body ? JSON.parse(String(init.body)) : undefined})
    const q = queues.get(key)
    if (!q?.length) return Response.json({error: "not found"}, {status: 404})
    const route = q.length > 1 ? q.shift()! : q[0]!
    return route(init)
  }) as typeof fetch
  return {f, calls}
}

describe("config.json additions", () => {
  test("links, sso providers and the escrowNotice shorthand", () => {
    const c = config.parseBeamhopConfig({
      escrowNotice: true,
      links: {terms: "https://corp.example/terms", privacy: "javascript:alert(1)"},
      sso: {
        providers: [
          {id: "okta", label: "Okta", startUrl: "/api/v1/sso/okta/start?audience=team"},
          {id: "evil", label: "Evil", startUrl: "https://evil.example/start"},
          {id: "bad"},
        ],
      },
    })
    expect(c.features.escrowNotice).toBe(true)
    expect(c.links).toEqual({terms: "https://corp.example/terms"})
    expect(c.sso.providers).toEqual([
      {id: "okta", label: "Okta", startUrl: "/api/v1/sso/okta/start?audience=team"},
    ])
    expect(config.parseBeamhopConfig({}).links).toEqual({})
  })

  test("legal links are hidden when absent", () => {
    expect(links.resolveLegalLinks({})).toEqual({})
    config.beamhopConfig.set(config.parseBeamhopConfig({links: {privacy: "/privacy"}}))
    expect(get(links.legalLinks)).toEqual({privacy: "/privacy"})
  })

  test("escrow notice follows config.json", () => {
    config.beamhopConfig.set(config.parseBeamhopConfig({}))
    expect(get(escrow.showEscrowNotice)).toBe(false)
    config.beamhopConfig.set(config.parseBeamhopConfig({escrowNotice: true}))
    expect(get(escrow.showEscrowNotice)).toBe(true)
  })
})

describe("team session", () => {
  test("parses the three modes and rejects junk", () => {
    expect(
      sso.parseTeamSession({mode: "managed", pubkey: PK, bunkerUrl: "bunker://x?relay=wss://r"}),
    ).toEqual({mode: "managed", pubkey: PK, bunkerUrl: "bunker://x?relay=wss://r"})
    expect(sso.parseTeamSession({mode: "self-custody", pubkey: PK.toUpperCase()})).toEqual({
      mode: "self-custody",
      pubkey: PK,
    })
    expect(sso.parseTeamSession({mode: "link-required", linkUrl: "/api/v1/team/link"})).toEqual({
      mode: "link-required",
      linkUrl: "/api/v1/team/link",
    })
    // never follow a link endpoint on another origin
    expect(
      sso.parseTeamSession({mode: "link-required", linkUrl: "https://evil.example/link"}),
    ).toEqual({mode: "link-required", linkUrl: "/api/v1/team/link"})
    expect(() =>
      sso.parseTeamSession({mode: "managed", pubkey: PK, bunkerUrl: "https://x"}),
    ).toThrow()
    expect(() => sso.parseTeamSession({mode: "self-custody", pubkey: "npub1"})).toThrow()
  })

  test("is refused when SSO is off", async () => {
    enable({sso: false})
    await expect(sso.requestTeamSession(stubFetch({}).f)).rejects.toMatchObject({code: "disabled"})
  })

  test("signed out (401) is reported as such", async () => {
    enable({sso: true})
    const {f} = stubFetch({
      "POST /api/v1/team/session": () =>
        Response.json({error: "Sign in with your company account first"}, {status: 401}),
    })
    await expect(sso.requestTeamSession(f)).rejects.toMatchObject({code: "signed-out", status: 401})
  })

  test("managed: logs in through the bunker", async () => {
    enable({sso: true})
    const bunkerUrl = "bunker://" + OTHER + "?relay=wss%3A%2F%2Fchat.example.com%2F"
    const {f} = stubFetch({
      "POST /api/v1/team/session": () => Response.json({mode: "managed", pubkey: PK, bunkerUrl}),
    })
    const bunkerLogins: Array<[string, string]> = []
    const r = await sso.signInWithTeamSession({
      fetch: f,
      loginWithBunker: async (u, pk) => {
        bunkerLogins.push([u, pk])
      },
      userSigner: async () => undefined,
    })
    expect(r).toEqual({mode: "managed", pubkey: PK, linked: false})
    expect(bunkerLogins).toEqual([[bunkerUrl, PK]])
  })

  const signer = (pubkey: string, log: string[] = []) => ({
    getPubkey: async () => pubkey,
    sign: async (t: import("./features/sso").EventTemplate) => {
      log.push(`sign:${t.kind}`)
      return {...t, id: "0".repeat(64), pubkey, sig: "0".repeat(128)}
    },
    login: async () => {
      log.push("login")
    },
  })

  test("self-custody: uses the person's signer when the key matches", async () => {
    enable({sso: true})
    const log: string[] = []
    const {f} = stubFetch({
      "POST /api/v1/team/session": () => Response.json({mode: "self-custody", pubkey: PK}),
    })
    const r = await sso.signInWithTeamSession({
      fetch: f,
      loginWithBunker: async () => {
        throw new Error("no bunker")
      },
      userSigner: async () => signer(PK, log),
    })
    expect(r).toEqual({mode: "self-custody", pubkey: PK, linked: false})
    expect(log).toEqual(["login"])
  })

  test("self-custody: refuses a different key, and asks for a signer when none", async () => {
    enable({sso: true})
    const {f} = stubFetch({
      "POST /api/v1/team/session": () => Response.json({mode: "self-custody", pubkey: PK}),
    })
    const deps = {fetch: f, loginWithBunker: async () => {}}
    await expect(
      sso.signInWithTeamSession({...deps, userSigner: async () => signer(OTHER)}),
    ).rejects.toMatchObject({code: "wrong-key"})
    await expect(
      sso.signInWithTeamSession({...deps, userSigner: async () => undefined}),
    ).rejects.toMatchObject({code: "no-signer"})
  })

  test("link-required: signs the challenge, links, then signs in", async () => {
    enable({sso: true})
    const log: string[] = []
    const {f, calls} = stubFetch({
      "POST /api/v1/team/session": [
        () => Response.json({mode: "link-required", linkUrl: "/api/v1/team/link"}),
        () => Response.json({mode: "self-custody", pubkey: PK}),
      ],
      "GET /api/v1/team/link": () =>
        Response.json({challenge: "c0ffee", expiresAt: 1, kinds: [22242, 27235], tag: "challenge"}),
      "POST /api/v1/team/link": () => Response.json({mode: "self-custody", pubkey: PK}),
    })
    const r = await sso.signInWithTeamSession({
      fetch: f,
      loginWithBunker: async () => {},
      userSigner: async () => signer(PK, log),
      origin: "https://chat.example.com",
    })
    expect(r).toEqual({mode: "self-custody", pubkey: PK, linked: true})
    expect(log).toEqual(["sign:22242", "login"])
    const posted = calls.find(c => c.key === "POST /api/v1/team/link")?.body as {
      event: {kind: number; tags: string[][]; pubkey: string}
    }
    expect(posted.event.kind).toBe(22242)
    expect(posted.event.tags).toContainEqual(["challenge", "c0ffee"])
    expect(posted.event.pubkey).toBe(PK)
    expect(calls.map(c => c.key)).toEqual([
      "POST /api/v1/team/session",
      "GET /api/v1/team/link",
      "POST /api/v1/team/link",
      "POST /api/v1/team/session",
    ])
  })

  test("link-required: a failed proof surfaces the server's reason", async () => {
    enable({sso: true})
    const {f} = stubFetch({
      "POST /api/v1/team/session": () => Response.json({mode: "link-required"}),
      "GET /api/v1/team/link": () => Response.json({challenge: "x"}),
      "POST /api/v1/team/link": () =>
        Response.json({error: "The signature is not valid"}, {status: 400}),
    })
    await expect(
      sso.signInWithTeamSession({
        fetch: f,
        loginWithBunker: async () => {},
        userSigner: async () => signer(PK),
      }),
    ).rejects.toThrow("The signature is not valid")
  })
})

describe("directory", () => {
  const people = [
    {pubkey: PK, name: "Ayşe", email: "ayse@corp.example", department: "Ops", title: "SRE"},
    {pubkey: OTHER, name: "Bob", department: "Eng", picture: "javascript:x"},
    {pubkey: "c".repeat(64), name: "Cem"},
    {pubkey: "nope", name: "Bad"},
  ]

  test("parses, filters and groups people", () => {
    const parsed = directory.parseDirectory({people})
    expect(parsed.map(p => p.name)).toEqual(["Ayşe", "Bob", "Cem"])
    expect(parsed[1]?.picture).toBeUndefined()
    expect(directory.filterDirectory(parsed, "sre").map(p => p.name)).toEqual(["Ayşe"])
    expect(directory.groupByDepartment(parsed).map(g => g.department)).toEqual(["Eng", "Ops", ""])
  })

  test("loads only when the feature is on; 401 means signed out", async () => {
    enable({directory: false})
    expect(await directory.loadDirectory(stubFetch({}).f)).toEqual([])

    enable({directory: true})
    const ok = stubFetch({"GET /api/v1/team/directory": () => Response.json({people})})
    expect((await directory.loadDirectory(ok.f)).length).toBe(3)
    expect(get(directory.directoryState).people.length).toBe(3)

    const out = stubFetch({
      "GET /api/v1/team/directory": () => Response.json({error: "x"}, {status: 401}),
    })
    await directory.loadDirectory(out.f)
    expect(get(directory.directoryState).error).toBe("signed-out")
  })
})

describe("intranet relay hosts", () => {
  test("only trusted dotless hosts are accepted", () => {
    config.beamhopConfig.set(config.parseBeamhopConfig({allowedRelays: ["ws://relay:3334"]}))
    expect(relayUrl.isIntranetHost("relay")).toBe(true)
    expect(relayUrl.isIntranetHost("RELAY")).toBe(true)
    expect(relayUrl.isIntranetHost("printer")).toBe(false)
    expect(relayUrl.isIntranetHost("relay.example.com")).toBe(false)
    federation.trustRelays(["ws://bunker:7447"])
    expect(relayUrl.isIntranetHost("bunker")).toBe(true)
  })

  test("the @welshman/util isRelayUrl patch applies and works", async () => {
    const file = Bun.resolveSync("@welshman/util/dist/util/src/Relay.js", import.meta.dir)
    expect(patch.isWelshmanRelayModule(file)).toBe(true)
    const patched = patch.patchIsRelayUrl(readFileSync(file, "utf8"))
    expect(patched).toContain("__beamhopIsIntranetHost")

    // Evaluate the patched module with its one import stubbed out.
    const dir = mkdtempSync(join(tmpdir(), "beamhop-relay-"))
    const code = patched!.replace(
      /^import .* from "@welshman\/lib";$/m,
      "const last = a => a[a.length - 1]; const normalizeUrl = u => u; const stripProtocol = u => u.replace(/^\\w+:\\/\\//, '');",
    )
    writeFileSync(join(dir, "Relay.mjs"), code)
    const mod = (await import(join(dir, "Relay.mjs"))) as {isRelayUrl: (u: string) => boolean}

    config.beamhopConfig.set(config.parseBeamhopConfig({allowedRelays: ["ws://relay:3334"]}))
    relayUrl.installIntranetRelayHosts()
    expect(mod.isRelayUrl("ws://relay:3334/")).toBe(true)
    expect(mod.isRelayUrl("ws://printer:3334/")).toBe(false)
    expect(mod.isRelayUrl("wss://relay.damus.io/")).toBe(true)
    expect(patch.patchIsRelayUrl("export const x = 1")).toBeNull()
  })
})
