// SPDX-License-Identifier: AGPL-3.0-or-later
// Shim for `$app/navigation` (see scripts/beamhop/vite-plugin.ts): upstream passes root-relative
// paths ("/spaces/..."); prefix them with the base path before handing them to SvelteKit.

import * as nav from "$app/navigation"
import {withBase} from "../base-path"

export * from "$app/navigation"

const based = <T>(url: T): T => (typeof url === "string" ? (withBase(url) as T) : url)

export const goto: typeof nav.goto = (url, opts) => nav.goto(based(url), opts)

export const pushState: typeof nav.pushState = (url, state) => nav.pushState(based(url), state)

export const replaceState: typeof nav.replaceState = (url, state) =>
  nav.replaceState(based(url), state)

export const preloadData: typeof nav.preloadData = href => nav.preloadData(based(href))

export const preloadCode: typeof nav.preloadCode = pathname => nav.preloadCode(based(pathname))
