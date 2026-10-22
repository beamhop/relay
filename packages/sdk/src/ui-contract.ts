/**
 * Admin UI plugin extension contract.
 * The admin-ui exposes `window.__BEAMHOP_UI__: AdminUiHost` before loading plugin bundles.
 * Plugin bundles must treat react / react-dom / react/jsx-runtime as externals mapped to host.React etc.
 * (they're also provided as an import map: "react", "react-dom", "react/jsx-runtime", "@beamhop/ui").
 */
export interface AdminUiPluginApi {
  pluginName: string;
  registerPage(page: { path: string; title: string; icon?: string; component: unknown /* React.ComponentType */ }): void;
  registerWidget(widget: { id: string; title: string; size?: "sm" | "md" | "lg"; component: unknown }): void;
  registerUserAction(action: { id: string; label: string; destructive?: boolean; run(pubkey: string): Promise<void> | void }): void;
  registerEventAction(action: { id: string; label: string; destructive?: boolean; run(eventId: string): Promise<void> | void }): void;
  /** fetch against /admin/api/plugins/<name>/... with session credentials */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}
export interface AdminUiHost {
  React: unknown;
  ReactDOM: unknown;
  jsxRuntime: unknown;
  /** shadcn components re-exported: Button, Card, Input, Badge, Table, Dialog, Switch, ... */
  ui: Record<string, unknown>;
  toast: unknown;
}
