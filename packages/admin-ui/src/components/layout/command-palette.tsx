import * as React from "react";
import { useNavigate } from "@tanstack/react-router";
import { FileSearch, LogOut, Monitor, Moon, Puzzle, Sun, UserSearch } from "lucide-react";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut,
} from "@/components/ui/command";
import { NAV } from "@/lib/nav";
import { useCan } from "@/queries/auth";
import { useTheme } from "@/lib/theme";
import { parseEventId, parsePubkey, shortHex } from "@/lib/nostr";
import { usePluginRegistry } from "@/plugins/registry";
import { useLogout } from "./user-menu";

const Ctx = React.createContext<{ open: () => void }>({ open: () => {} });
export const useCommandPalette = () => React.useContext(Ctx);

export function CommandPaletteProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const value = React.useMemo(() => ({ open: () => setOpen(true) }), []);
  return (
    <Ctx.Provider value={value}>
      {children}
      <CommandPalette open={open} onOpenChange={setOpen} />
    </Ctx.Provider>
  );
}

function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const can = useCan();
  const { setTheme } = useTheme();
  const doLogout = useLogout();
  const { pages } = usePluginRegistry();
  const [q, setQ] = React.useState("");
  React.useEffect(() => {
    if (!open) setQ("");
  }, [open]);

  const pubkey = parsePubkey(q);
  const eventId = parseEventId(q);
  const run = (fn: () => void) => {
    onOpenChange(false);
    fn();
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange} title="Command palette" description="Navigate or look up a pubkey / event">
      <CommandInput placeholder="Search pages, paste npub / note / hex…" value={q} onValueChange={setQ} />
      <CommandList className="max-h-[60dvh]">
        <CommandEmpty>No results.</CommandEmpty>
        {(pubkey || eventId) && (
          <CommandGroup heading="Lookup" forceMount>
            {pubkey && can("users.view") && (
              <CommandItem forceMount value={`lookup-user-${q}`} onSelect={() => run(() => navigate({ to: "/users/$pubkey", params: { pubkey } }))}>
                <UserSearch /> Open user {shortHex(pubkey, 8)}
              </CommandItem>
            )}
            {eventId && can("content.view") && (
              <CommandItem forceMount value={`lookup-event-${q}`} onSelect={() => run(() => navigate({ to: "/content", search: { f: JSON.stringify({ ids: [eventId] }) } }))}>
                <FileSearch /> Find event {shortHex(eventId, 8)}
              </CommandItem>
            )}
            {pubkey && can("content.view") && (
              <CommandItem forceMount value={`lookup-events-by-${q}`} onSelect={() => run(() => navigate({ to: "/content", search: { f: JSON.stringify({ authors: [pubkey] }) } }))}>
                <FileSearch /> Events by {shortHex(pubkey, 8)}
              </CommandItem>
            )}
          </CommandGroup>
        )}
        {NAV.map((g) => {
          const items = g.items.filter((i) => can(i.perm));
          if (!items.length) return null;
          return (
            <CommandGroup key={g.label} heading={g.label}>
              {items.map((i) => (
                <CommandItem key={i.to} value={`${i.label} ${i.keywords ?? ""}`} onSelect={() => run(() => navigate({ to: i.to as "/" }))}>
                  <i.icon /> {i.label}
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
        {pages.length > 0 && (
          <CommandGroup heading="Plugins">
            {pages.map((p) => (
              <CommandItem
                key={`${p.plugin}/${p.path}`}
                value={`${p.title} ${p.plugin}`}
                onSelect={() => run(() => navigate({ to: "/p/$plugin/$", params: { plugin: p.plugin, _splat: p.path.replace(/^\//, "") } }))}
              >
                <Puzzle /> {p.title} <CommandShortcut>{p.plugin}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
        <CommandSeparator />
        {!pubkey && !eventId && q.trim().length > 1 && can("users.view") && (
          // forceMount + query-free values: always shown, but ranked below matching pages
          <CommandGroup heading="Search" forceMount>
            <CommandItem forceMount value="zz-search-users" onSelect={() => run(() => navigate({ to: "/users", search: { search: q.trim() } }))}>
              <UserSearch /> Search users for “{q.trim()}”
            </CommandItem>
            {can("content.view") && (
              <CommandItem forceMount value="zz-search-events" onSelect={() => run(() => navigate({ to: "/content", search: { f: JSON.stringify({ search: q.trim() }) } }))}>
                <FileSearch /> Full-text search events for “{q.trim()}”
              </CommandItem>
            )}
          </CommandGroup>
        )}
        <CommandGroup heading="Preferences">
          <CommandItem value="theme light" onSelect={() => run(() => setTheme("light"))}><Sun /> Light theme</CommandItem>
          <CommandItem value="theme dark" onSelect={() => run(() => setTheme("dark"))}><Moon /> Dark theme</CommandItem>
          <CommandItem value="theme system" onSelect={() => run(() => setTheme("system"))}><Monitor /> System theme</CommandItem>
          <CommandItem value="sign out logout" onSelect={() => run(doLogout)}><LogOut /> Sign out</CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
