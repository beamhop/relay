// SPDX-License-Identifier: AGPL-3.0-or-later
// Shim for `$app/stores` (see scripts/beamhop/vite-plugin.ts): `page.url.pathname` without the
// base path, so upstream comparisons like `$page.url.pathname === "/join"` keep working.

import type {Page} from "@sveltejs/kit"
import type {Readable} from "svelte/store"
import * as stores from "$app/stores"
import {stripBaseUrl} from "../base-path"

export {getStores, navigating, updated} from "$app/stores"

const cache = new WeakMap<object, Page>()

const withoutBase = (value: Page): Page => {
  if (!value || typeof value !== "object" || !value.url) return value

  let proxy = cache.get(value)

  if (!proxy) {
    proxy = new Proxy(value, {
      get: (t, k, r) => (k === "url" ? stripBaseUrl(t.url) : Reflect.get(t, k, r)),
    })
    cache.set(value, proxy)
  }

  return proxy
}

export const page: Readable<Page> = {
  subscribe: (run, invalidate) =>
    stores.page.subscribe(value => run(withoutBase(value)), invalidate),
}
