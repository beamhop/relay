import * as React from "react";

export type Theme = "system" | "light" | "dark";
const KEY = "beamhop-theme";

interface ThemeCtx { theme: Theme; resolved: "light" | "dark"; setTheme(t: Theme): void }
const Ctx = React.createContext<ThemeCtx>({ theme: "system", resolved: "light", setTheme: () => {} });

const mql = () => window.matchMedia("(prefers-color-scheme: dark)");

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = React.useState<Theme>(() => (localStorage.getItem(KEY) as Theme) || "system");
  const [systemDark, setSystemDark] = React.useState(() => mql().matches);

  React.useEffect(() => {
    const m = mql();
    const on = () => setSystemDark(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);

  const resolved: "light" | "dark" = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  React.useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolved === "dark");
    root.style.colorScheme = resolved;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "dark" ? "#18181b" : "#ffffff");
  }, [resolved]);

  const setTheme = React.useCallback((t: Theme) => {
    localStorage.setItem(KEY, t);
    setThemeState(t);
  }, []);

  const value = React.useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTheme = () => React.useContext(Ctx);
