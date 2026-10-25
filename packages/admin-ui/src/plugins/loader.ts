import type { AdminUiPluginApi } from "@beamhop/sdk/ui-contract";
import type { PluginView } from "@beamhop/sdk/admin-contract";
import { API_BASE, baseHeaders, notifyUnauthorized } from "@/lib/api";
import { registry, type PluginComponent } from "./registry";
import { pluginFetchUrl } from "./paths";

let hostReady: Promise<void> | null = null;
/** plugins whose UI bundle ran successfully */
const loaded = new Set<string>();
/** plugins whose UI bundle is being imported right now (a refetch of the plugin list must not import it twice) */
const loading = new Set<string>();

/** Exposes window.__BEAMHOP_UI__ (React, ReactDOM, jsx runtime, shadcn components, toast). */
function ensureHost() {
  // a failed chunk load (deploy, flaky network) must not stay cached: the next call tries again
  hostReady ??= import("./host-ui").then(
    (m) => m.installHost(),
    (e) => {
      hostReady = null;
      throw e;
    },
  );
  return hostReady;
}

function createPluginApi(name: string): AdminUiPluginApi {
  const api: AdminUiPluginApi = {
    pluginName: name,
    registerPage(page) {
      registry.set((s) => ({
        ...s,
        pages: [...s.pages.filter((p) => !(p.plugin === name && p.path === page.path)), { ...page, plugin: name, component: page.component as PluginComponent, api }],
      }));
    },
    registerWidget(widget) {
      registry.set((s) => ({
        ...s,
        widgets: [...s.widgets.filter((w) => !(w.plugin === name && w.id === widget.id)), { ...widget, plugin: name, component: widget.component as PluginComponent, api }],
      }));
    },
    registerUserAction(action) {
      registry.set((s) => ({ ...s, userActions: [...s.userActions.filter((a) => !(a.plugin === name && a.id === action.id)), { ...action, plugin: name }] }));
    },
    registerEventAction(action) {
      registry.set((s) => ({ ...s, eventActions: [...s.eventActions.filter((a) => !(a.plugin === name && a.id === action.id)), { ...action, plugin: name }] }));
    },
    fetch(path, init) {
      let url: string;
      try {
        // stays inside /plugins/x/<name>/: no absolute URLs, no `..` into the rest of the admin API
        url = pluginFetchUrl(API_BASE, name, path);
      } catch (e) {
        return Promise.reject(e);
      }
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(baseHeaders)) headers.set(k, v);
      return fetch(url, { ...init, headers, credentials: "include" }).then((res) => {
        // an expired session sends the admin to the sign-in page, as the panel's own requests do
        if (res.status === 401) notifyUnauthorized();
        return res;
      });
    },
  };
  return api;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Load the UI bundles of all running plugins. Errors are isolated per plugin; this never rejects. */
export async function loadPluginUis(plugins: PluginView[]) {
  const running = new Set(plugins.filter((p) => p.uiUrl && p.enabled && p.status === "running").map((p) => p.name));
  // unload UIs of plugins that were disabled/stopped since they were loaded
  const gone = [...loaded].filter((n) => !running.has(n));
  if (gone.length) {
    for (const n of gone) loaded.delete(n);
    const keep = <T extends { plugin: string }>(xs: T[]) => xs.filter((x) => !gone.includes(x.plugin));
    registry.set((s) => ({
      ...s,
      pages: keep(s.pages),
      widgets: keep(s.widgets),
      userActions: keep(s.userActions),
      eventActions: keep(s.eventActions),
      errors: Object.fromEntries(Object.entries(s.errors).filter(([k]) => !gone.includes(k))),
    }));
  }
  const withUi = plugins.filter((p) => running.has(p.name) && !loaded.has(p.name) && !loading.has(p.name));
  if (!withUi.length) {
    registry.set((s) => ({ ...s, loaded: true }));
    return;
  }
  for (const p of withUi) loading.add(p.name);
  try {
    await ensureHost();
  } catch (e) {
    console.error("[beamhop] plugin UI host failed to load", e);
    const msg = `UI host failed to load: ${errorText(e)}`;
    for (const p of withUi) loading.delete(p.name);
    registry.set((s) => ({ ...s, loaded: true, errors: { ...s.errors, ...Object.fromEntries(withUi.map((p) => [p.name, msg])) } }));
    return;
  }
  await Promise.all(
    withUi.map(async (p) => {
      try {
        const mod = await import(/* @vite-ignore */ p.uiUrl!);
        const init = mod.default ?? mod.register ?? mod.setup;
        if (typeof init !== "function") throw new Error("UI bundle has no default export function");
        await init(createPluginApi(p.name));
        // only a bundle that ran counts as loaded: a failed one is tried again the next time the plugin list loads
        loaded.add(p.name);
        registry.set((s) => (p.name in s.errors ? { ...s, errors: Object.fromEntries(Object.entries(s.errors).filter(([k]) => k !== p.name)) } : s));
      } catch (e) {
        console.error(`[beamhop] plugin UI "${p.name}" failed`, e);
        registry.set((s) => ({ ...s, errors: { ...s.errors, [p.name]: errorText(e) } }));
      } finally {
        loading.delete(p.name);
      }
    }),
  );
  registry.set((s) => ({ ...s, loaded: true }));
}

export function resetPluginUis() {
  loaded.clear();
  loading.clear();
  registry.reset();
}
