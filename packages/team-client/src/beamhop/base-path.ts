// SPDX-License-Identifier: AGPL-3.0-or-later
// Base-path helpers. Upstream Flotilla assumes it is served at "/"; Beamhop serves it at "/app"
// (SvelteKit `paths.base`, set from BEAMHOP_BASE at build time). Upstream code keeps working
// with root-relative paths: the shims in ./shims strip the base from `page.url` and add it back
// in goto/pushState/replaceState, and installLinkBasePath() fixes root-relative <a href>s.

import {base} from "$app/paths"

export {base}

const isAppPath = (path: string) =>
  path === base || path.startsWith(`${base}/`) || path.startsWith(`${base}?`) || path.startsWith(`${base}#`)

/** "/home" -> "/app/home". Leaves absolute URLs, protocol-relative, and already-based paths alone. */
export const withBase = (path: string) => {
  if (!base || !path.startsWith("/") || path.startsWith("//") || isAppPath(path)) {
    return path
  }

  return base + path
}

/** "/app/home" -> "/home" */
export const stripBase = (pathname: string) => {
  if (!base) return pathname
  if (pathname === base) return "/"
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length)

  return pathname
}

/** A copy of `url` whose pathname has the base path removed (as upstream code expects). */
export const stripBaseUrl = (url: URL) => {
  if (!base || !url) return url

  const pathname = stripBase(url.pathname)

  if (pathname === url.pathname) return url

  const copy = new URL(url.href)

  copy.pathname = pathname

  return copy
}

const fixAnchor = (event: Event) => {
  const target = event.target as Element | null
  const anchor = target?.closest?.("a[href]")

  if (!anchor) return

  const href = anchor.getAttribute("href")

  if (href && href !== withBase(href)) {
    anchor.setAttribute("href", withBase(href))
  }
}

/**
 * Rewrite root-relative <a href="/x"> to "/app/x" right before SvelteKit's router (or the
 * browser) sees them. Capture-phase listeners on window run before SvelteKit's handlers.
 */
export const installLinkBasePath = () => {
  if (!base) return () => undefined

  const events = ["click", "auxclick", "pointerdown", "mouseover", "focusin", "contextmenu"]

  for (const name of events) {
    window.addEventListener(name, fixAnchor, {capture: true, passive: true})
  }

  return () => {
    for (const name of events) {
      window.removeEventListener(name, fixAnchor, {capture: true})
    }
  }
}
