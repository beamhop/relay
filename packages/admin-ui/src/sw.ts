/// <reference no-default-lib="true" />
/* beamhop admin service worker: precache app shell, offline fallback, web push. /admin/api is never cached. */

interface PrecacheEntry { url: string; revision: string | null }
interface PushPayload { title?: string; body?: string; url?: string; tag?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sw = globalThis as any;
const MANIFEST = (self as unknown as { __WB_MANIFEST: PrecacheEntry[] }).__WB_MANIFEST;

const VERSION = hash(MANIFEST.map((e) => `${e.url}@${e.revision ?? ""}`).join("|"));
const CACHE = `beamhop-shell-${VERSION}`;
/**
 * Large chunks only some admins ever load (the world map: maplibre and its worker) stay out of the precache
 * (vite.config.ts globIgnores) and are cached here the first time they're fetched; same lifecycle as the shell cache.
 */
const LAZY_CACHE = `beamhop-lazy-${VERSION}`;
const LAZY_ASSET = /\/assets\/(world-map|maplibre-gl)[^/]*\.(m?js|css)$/;
const SCOPE: string = sw.registration.scope; // e.g. https://host/admin/
const OFFLINE_URL = new URL("offline.html", SCOPE).href;
const INDEX_URL = new URL("index.html", SCOPE).href;
const API_PREFIX = new URL("api/", SCOPE).pathname;
/** records which shell cache the active version uses */
const META_CACHE = "beamhop-meta";
const ACTIVE_KEY = new URL("__active-shell-cache", SCOPE).href;

function hash(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

sw.addEventListener("install", (event: any) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const urls = [...new Set(MANIFEST.map((e) => new URL(e.url, SCOPE).href))]; // addAll rejects duplicates
      await cache.addAll(urls);
      await sw.skipWaiting();
    })(),
  );
});

sw.addEventListener("activate", (event: any) => {
  event.waitUntil(
    (async () => {
      // keep the cache of the version that was active until now: a tab still running the old bundle lazy-loads
      // route chunks the new deploy no longer serves, and finds them there (see the fetch handler). It is recorded
      // explicitly, since the newest other cache may be one whose install failed and was never used.
      const meta = await caches.open(META_CACHE);
      const previous = await (await meta.match(ACTIVE_KEY))?.text();
      const keep = new Set([CACHE, LAZY_CACHE, previous, previous?.replace("beamhop-shell-", "beamhop-lazy-")]);
      const stale = (await caches.keys()).filter((k) => /^beamhop-(shell|lazy)-/.test(k) && !keep.has(k));
      await Promise.all(stale.map((k) => caches.delete(k)));
      await meta.put(ACTIVE_KEY, new Response(CACHE));
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("fetch", (event: any) => {
  const req: Request = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // NetworkOnly for the admin API (sensitive data, SSE): let the browser handle it.
  if (url.pathname.startsWith(API_PREFIX)) return;

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(req);
        } catch {
          const cache = await caches.open(CACHE);
          return (await cache.match(OFFLINE_URL)) || (await cache.match(INDEX_URL)) || Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // current version first; then the kept previous version, for hashed chunks of a bundle that's still open
      const hit = (await cache.match(req, { ignoreSearch: false })) || (await caches.match(req, { ignoreSearch: false }));
      if (hit) return hit;
      const res = await fetch(req);
      // hashed file names: a fetched lazy chunk never changes, keep it for later visits and offline use
      if (res.ok && LAZY_ASSET.test(url.pathname)) {
        const copy = res.clone();
        event.waitUntil(caches.open(LAZY_CACHE).then((c) => c.put(req, copy)).catch(() => {}));
      }
      return res;
    })(),
  );
});

sw.addEventListener("push", (event: any) => {
  let data: PushPayload = {};
  try {
    data = event.data?.json() ?? {};
  } catch {
    data = { body: event.data?.text() };
  }
  const title = data.title || "beamhop";
  event.waitUntil(
    sw.registration.showNotification(title, {
      body: data.body ?? "",
      tag: data.tag,
      icon: new URL("icons/icon-192.png", SCOPE).href,
      badge: new URL("icons/icon-192.png", SCOPE).href,
      data: { url: data.url },
    }),
  );
});

sw.addEventListener("notificationclick", (event: any) => {
  event.notification.close();
  const raw: string | undefined = event.notification.data?.url;
  event.waitUntil(focusOrOpen(raw ? pushTarget(raw) : SCOPE));
});

/**
 * The server builds absolute links from its publicUrl; the PWA may be installed from another origin (e.g. a LAN
 * IP), which is where the session lives. Keep only the path and re-root it under this worker's scope.
 */
function pushTarget(raw: string): string {
  const scope = new URL(SCOPE);
  const u = new URL(raw, scope);
  let path = u.pathname + u.search + u.hash;
  if (!u.pathname.startsWith(scope.pathname)) path = scope.pathname + path.replace(/^\//, "");
  return new URL(path, scope.origin).href;
}

async function focusOrOpen(target: string) {
  const all = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const c of all) {
    if (c.url.startsWith(SCOPE)) {
      await c.focus();
      if ("navigate" in c) await c.navigate(target).catch(() => {});
      return;
    }
  }
  await sw.clients.openWindow(target);
}
