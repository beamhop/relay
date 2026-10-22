/**
 * Host shim: the admin panel exposes React & shadcn components on window.__BEAMHOP_UI__
 * (see @beamhop/sdk ui-contract). Reading them from the global keeps the bundle free of
 * `import "react"` statements, so no bundler externals / import maps are needed.
 * JSX is compiled to h(...) via tsconfig `jsxFactory`.
 */
type AnyComponent = (props: any) => any;
interface ReactLike {
  createElement: (...args: any[]) => any;
  Fragment: any;
  useState<T>(init: T | (() => T)): [T, (v: T | ((p: T) => T)) => void];
  useEffect(fn: () => void | (() => void), deps?: unknown[]): void;
  useCallback<T extends (...a: any[]) => any>(fn: T, deps: unknown[]): T;
}
interface Host {
  React: ReactLike;
  ui: Record<string, AnyComponent | undefined>;
  toast?: ((msg: string) => void) & { success?: (m: string) => void; error?: (m: string) => void };
}

const host = (globalThis as unknown as { __BEAMHOP_UI__: Host }).__BEAMHOP_UI__;
export const React = host.React;
export const h = React.createElement;
export const Fragment = React.Fragment;
export const { useState, useEffect, useCallback } = React;
/** shadcn component if the host provides it, otherwise a plain element fallback */
export const ui = (name: string, fallback: string): any => host.ui?.[name] ?? fallback;
export const toast = (msg: string, kind: "success" | "error" = "success") => {
  const t = host.toast;
  if (t && typeof t[kind] === "function") t[kind]!(msg);
  else if (typeof t === "function") t(msg);
};
