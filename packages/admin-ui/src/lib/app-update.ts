import { toast } from "sonner";

/**
 * Deploys replace the hashed chunks: a tab still running the old bundle can fail to lazy-load a route. The service
 * worker keeps the previous version's cache for that, but without it (first visit, SW blocked, cache evicted) the
 * import fails and a reload is the only fix.
 */
const CHUNK_ERROR = /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading chunk .* failed/i;
export const isChunkLoadError = (e: unknown) => e instanceof Error && (e.name === "ChunkLoadError" || CHUNK_ERROR.test(e.message));

const RELOAD_KEY = "beamhop:preload-reload";
/** at most one automatic reload in this window: a chunk that is really gone must not reload the tab forever */
const RELOAD_GUARD_MS = 30_000;
let reloading = false;

/** Vite's `vite:preloadError`: reload once to pick up the new deploy; a second failure surfaces as a route error. */
export function installPreloadErrorReload() {
  window.addEventListener("vite:preloadError", (e) => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
    } catch {
      /* storage blocked: still reload once per page load */
    }
    if (Date.now() - last < RELOAD_GUARD_MS || reloading) return;
    reloading = true;
    e.preventDefault();
    try {
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    window.location.reload();
  });
}

/**
 * Registers the service worker. A new version activates on its own (skipWaiting in sw.ts) and takes over this tab,
 * which keeps running the old bundle: offer a reload then. Checks for a new version whenever the tab becomes visible.
 */
export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    const sw = navigator.serviceWorker;
    // the first install also claims the page (controllerchange), but that is not an update
    let controlled = !!sw.controller;
    sw.addEventListener("controllerchange", () => {
      if (!controlled) {
        controlled = true;
        return;
      }
      toast.info("New version available", {
        id: "app-update",
        description: "Reload to use the updated admin panel.",
        duration: Infinity,
        action: { label: "Reload", onClick: () => window.location.reload() },
      });
    });
    sw.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .then((reg) => {
        document.addEventListener("visibilitychange", () => {
          if (document.visibilityState === "visible") reg.update().catch(() => {});
        });
      })
      .catch((e) => console.warn("SW registration failed", e));
  });
}
