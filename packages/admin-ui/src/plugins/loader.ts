import type { AdminUiPluginApi } from "@beamhop/sdk/ui-contract";
import type { PluginView } from "@beamhop/sdk/admin-contract";
import { API_BASE, baseHeaders } from "@/lib/api";
import { registry, type PluginComponent } from "./registry";

let hostReady: Promise<void> | null = null;
const loaded = new Set<string>();

/** Exposes window.__BEAMHOP_UI__ (React, ReactDOM, jsx runtime, shadcn components, toast). */
function ensureHost() {
  hostReady ??= import("./host-ui").then((m) => m.installHost());
  return hostReady;
}

export function createPluginApi(name: string): AdminUiPluginApi {
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
      const headers = new Headers(init?.headers);
      for (const [k, v] of Object.entries(baseHeaders)) headers.set(k, v);
      return fetch(`${API_BASE}/plugins/x/${encodeURIComponent(name)}/${path.replace(/^\//, "")}`, { ...init, headers, credentials: "include" });
    },
  };
  return api;
}

/** Load the UI bundles of all running plugins. Errors are isolated per plugin. */
export async function loadPluginUis(plugins: PluginView[]) {
  const withUi = plugins.filter((p) => p.uiUrl && p.enabled && p.status === "running" && !loaded.has(p.name));
  if (!withUi.length) {
    registry.set((s) => ({ ...s, loaded: true }));
    return;
  }
  await ensureHost();
  await Promise.all(
    withUi.map(async (p) => {
      loaded.add(p.name);
      try {
        const mod = await import(/* @vite-ignore */ p.uiUrl!);
        const init = mod.default ?? mod.register ?? mod.setup;
        if (typeof init !== "function") throw new Error("UI bundle has no default export function");
        await init(createPluginApi(p.name));
      } catch (e) {
        console.error(`[beamhop] plugin UI "${p.name}" failed`, e);
        registry.set((s) => ({ ...s, errors: { ...s.errors, [p.name]: e instanceof Error ? e.message : String(e) } }));
      }
    }),
  );
  registry.set((s) => ({ ...s, loaded: true }));
}

export function resetPluginUis() {
  loaded.clear();
  registry.reset();
}
