/// <reference no-default-lib="true" />
/* beamhop admin service worker: precache app shell, offline fallback, web push. /admin/api is never cached. */

interface PrecacheEntry { url: string; revision: string | null }
interface PushPayload { title?: string; body?: string; url?: string; tag?: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sw = globalThis as any;
const MANIFEST = (self as unknown as { __WB_MANIFEST: PrecacheEntry[] }).__WB_MANIFEST;

const VERSION = hash(MANIFEST.map((e) => `${e.url}@${e.revision ?? ""}`).join("|"));
const CACHE = `beamhop-shell-${VERSION}`;
const SCOPE: string = sw.registration.scope; // e.g. https://host/admin/
const OFFLINE_URL = new URL("offline.html", SCOPE).href;
const INDEX_URL = new URL("index.html", SCOPE).href;
const API_PREFIX = new URL("api/", SCOPE).pathname;

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
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("beamhop-shell-") && k !== CACHE).map((k) => caches.delete(k)));
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("message", (event: any) => {
  if (event.data === "SKIP_WAITING") sw.skipWaiting();
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
      const hit = await cache.match(req, { ignoreSearch: false });
      return hit || fetch(req);
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
  const target = raw ? new URL(raw.startsWith("/") && !raw.startsWith(new URL(SCOPE).pathname) ? raw.slice(1) : raw, SCOPE).href : SCOPE;
  event.waitUntil(
    (async () => {
      const all = await sw.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) {
        if (c.url.startsWith(SCOPE)) {
          await c.focus();
          if ("navigate" in c) await c.navigate(target).catch(() => {});
          return;
        }
      }
      await sw.clients.openWindow(target);
    })(),
  );
});
