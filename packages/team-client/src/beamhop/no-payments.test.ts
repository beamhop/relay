// SPDX-License-Identifier: AGPL-3.0-or-later
// Guard for the product rule "no Lightning, no cryptocurrency, no zaps, no wallets, no payments of
// any kind" (CLAUDE.md rule 9, PLAN.md section 2). Upstream Flotilla ships all of those; Beamhop
// removed them (UPSTREAM.md, "No payments"). An upstream merge that brings any of it back fails here.
//
// - Source: every line under src/, static/ and scripts/beamhop/ is scanned for payment words. A line
//   is allowed only when it carries the marker comment `beamhop: no-payments` (used where an upstream
//   line had to keep a protocol name, e.g. the IndexedDB table list or the content parser's token
//   types, which are rendered as plain text).
// - Routes and modules: the deleted wallet/hosting/goal routes and payment modules must stay gone,
//   and the Lightning SDKs must not come back as dependencies.
// - Built output (packages/team-client/build, when present - run `bun run build` in the package
//   first): no payment UI strings or routes. Vendored protocol code (@welshman/* zap/lnurl helpers,
//   the emoji table) is not UI and is not matched by these strings.

import {existsSync, readFileSync, readdirSync, statSync} from "node:fs"
import {join, relative} from "node:path"
import {describe, expect, test} from "bun:test"

const ROOT = join(import.meta.dir, "..", "..")
const SELF = relative(ROOT, import.meta.path)
const MARKER = "beamhop: no-payments"

const PAYMENT_WORDS =
  /zap|wallet|lightning|lnurl|bolt1[12]|cashu|\bnwc\b|webln|\binvoices?\b|\bgoals?\b|hosting|\bpayments?\b|billing|donat|\bsats?\b|msats|bitcoin|\bbtc\b|satoshi|pricing|stripe/i

const SCANNED_EXTENSIONS = /\.(ts|js|mjs|svelte|css|html|json|webmanifest)$/

const walk = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap(name => {
        const path = join(dir, name)

        return statSync(path).isDirectory() ? walk(path) : [path]
      })
    : []

const offendingLines = (files: string[]) =>
  files.flatMap(file => {
    const rel = relative(ROOT, file)

    if (rel === SELF || !SCANNED_EXTENSIONS.test(file)) {
      return []
    }

    return readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line, i) =>
        PAYMENT_WORDS.test(line) && !line.includes(MARKER)
          ? [`${rel}:${i + 1}: ${line.trim()}`]
          : [],
      )
  })

describe("no payments: source", () => {
  test("no zap / wallet / lightning / payment code outside marked lines", () => {
    const files = [
      ...walk(join(ROOT, "src")),
      ...walk(join(ROOT, "static")),
      ...walk(join(ROOT, "scripts", "beamhop")),
    ]

    expect(files.length).toBeGreaterThan(100)
    expect(offendingLines(files)).toEqual([])
  })

  test("payment routes and modules stay deleted", () => {
    const gone = [
      "src/routes/settings/wallet",
      "src/routes/settings/hosting",
      "src/routes/spaces/create",
      "src/routes/spaces/[relay]/goals",
      "src/routes/spaces/[relay]/admin",
      "src/app/features/lightning.ts",
      "src/app/features/goals.ts",
      "src/app/features/hosting.ts",
      "src/app/features/payments.ts",
      "src/app/components/hosting",
      "src/app/components/ContentToken.svelte",
      "src/app/components/SpacePaymentGate.svelte",
      "src/app/components/SpacePrice.svelte",
      "src/app/components/HomeHosting.svelte",
      "static/fonts/Satoshi Symbol.ttf",
    ]

    expect(gone.filter(path => existsSync(join(ROOT, path)))).toEqual([])

    const components = readdirSync(join(ROOT, "src", "app", "components"))

    expect(components.filter(name => /^(Zap|Wallet|Goal|InfoZapper)|Zap|Goal/.test(name))).toEqual(
      [],
    )

    const routes = walk(join(ROOT, "src", "routes")).map(path => relative(ROOT, path))

    expect(routes.filter(path => PAYMENT_WORDS.test(path))).toEqual([])
  })

  test("no Lightning / NWC SDK dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
    const deps = Object.keys({...pkg.dependencies, ...pkg.devDependencies})

    expect(deps.filter(name => /getalby|webln|lightning|bolt11|cashu|nwc|zap/i.test(name))).toEqual(
      [],
    )
  })

  test("NIP-46 login does not ask for zap-request signing", () => {
    const nip46 = readFileSync(join(ROOT, "src", "app", "core", "nip46.ts"), "utf8")

    expect(nip46).not.toMatch(/ZAP_REQUEST|9734/)
  })
})

// Strings that only the removed UI produced. Matched case-sensitively against the built bundle, so
// vendored protocol helpers (welshman's Zappers/ZapGoals classes, the content parser's
// `lightning:` scheme, the emoji table's "zap" keyword) do not trip them.
const UI_STRINGS = [
  "/settings/wallet",
  "/settings/hosting",
  "/spaces/create",
  "/goals",
  "Send a zap",
  "Send a Zap",
  "Send Zap",
  "Zap the Developer",
  "zapped this",
  "Zapped this message",
  "Funding Goal",
  "Create Goal",
  "Wallet Settings",
  "Connect a Wallet",
  "Connect a lightning wallet",
  "Connect with WebLN",
  "nostr+walletconnect://",
  "Lightning Address",
  "Zap Amounts",
  "zap amounts",
  "Payment Required",
  "Hosting settings",
  "Set Up Payments",
  "Payment History",
  "Pay invoice",
  "Waiting for payment",
  "Manage membership",
  "Hosting Plan",
  "lnvps",
  "Satoshi Symbol",
  'label:"Zaps"',
]

const BUILD = process.env.BEAMHOP_TEAM_BUILD_DIR || join(ROOT, "build")
const hasBuild = existsSync(join(BUILD, "_app"))

describe("no payments: built output", () => {
  test.skipIf(!hasBuild)("no payment UI strings or routes in the bundle", () => {
    const files = walk(BUILD).filter(file => SCANNED_EXTENSIONS.test(file))
    const found = files.flatMap(file => {
      const text = readFileSync(file, "utf8")

      return UI_STRINGS.filter(s => text.includes(s)).map(s => `${relative(BUILD, file)}: ${s}`)
    })

    expect(files.length).toBeGreaterThan(10)
    expect(found).toEqual([])
  })

  test.skipIf(!hasBuild)("no payment route nodes or fonts in the bundle", () => {
    const paths = walk(BUILD).map(path => relative(BUILD, path))

    expect(paths.filter(path => /wallet|hosting|goals|satoshi/i.test(path))).toEqual([])
  })
})
