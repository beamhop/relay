import * as React from "react";
import type { AdminUiPluginApi } from "@beamhop/sdk/ui-contract";

type PageArg = Parameters<AdminUiPluginApi["registerPage"]>[0];
type WidgetArg = Parameters<AdminUiPluginApi["registerWidget"]>[0];
type UserActionArg = Parameters<AdminUiPluginApi["registerUserAction"]>[0];
type EventActionArg = Parameters<AdminUiPluginApi["registerEventAction"]>[0];

export type PluginComponent = React.ComponentType<{ api: AdminUiPluginApi }>;
export interface PluginPage extends Omit<PageArg, "component"> { plugin: string; component: PluginComponent; api: AdminUiPluginApi }
export interface PluginWidget extends Omit<WidgetArg, "component"> { plugin: string; component: PluginComponent; api: AdminUiPluginApi }
export interface PluginUserAction extends UserActionArg { plugin: string }
export interface PluginEventAction extends EventActionArg { plugin: string }

export interface RegistryState {
  pages: PluginPage[];
  widgets: PluginWidget[];
  userActions: PluginUserAction[];
  eventActions: PluginEventAction[];
  errors: Record<string, string>;
  loaded: boolean;
}

let state: RegistryState = { pages: [], widgets: [], userActions: [], eventActions: [], errors: {}, loaded: false };
const listeners = new Set<() => void>();

export const registry = {
  get: () => state,
  set(fn: (s: RegistryState) => RegistryState) {
    state = fn(state);
    listeners.forEach((l) => l());
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  reset() {
    registry.set(() => ({ pages: [], widgets: [], userActions: [], eventActions: [], errors: {}, loaded: false }));
  },
};

export function usePluginRegistry() {
  return React.useSyncExternalStore(registry.subscribe, registry.get, registry.get);
}

export const normalizePath = (p: string) => p.replace(/^\/+|\/+$/g, "");
