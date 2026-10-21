// SPDX-License-Identifier: AGPL-3.0-or-later
// Shim for `$app/state` (see scripts/beamhop/vite-plugin.ts): `page.url` without the base path.
// Reading `page.url` through the proxy still reads the reactive original, so runes track it.

import {page as kitPage} from "$app/state"
import {stripBaseUrl} from "../base-path"

export {navigating, updated} from "$app/state"

export const page: typeof kitPage = new Proxy(kitPage, {
  get: (target, key, receiver) =>
    key === "url" ? stripBaseUrl(target.url) : Reflect.get(target, key, receiver),
})
