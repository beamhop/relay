import * as React from "react";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronsUpDown, Menu, Puzzle, Search } from "lucide-react";
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu,
  SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "@/components/ui/drawer";
import { Kbd } from "./kbd";
import { NAV, MOBILE_TABS, ALL_NAV, titleForPath, type NavItem } from "@/lib/nav";
import { useCan, useMe } from "@/queries/auth";
import { useOpenReportCount } from "@/queries/content";
import { usePlugins } from "@/queries/misc";
import { live, useLiveStatus } from "@/lib/live";
import { loadPluginUis } from "@/plugins/loader";
import { usePluginRegistry } from "@/plugins/registry";
import { displayName, profileName, shortNpub } from "@/lib/nostr";
import { cn } from "@/lib/utils";
import { UserAvatar } from "@/components/user-avatar";
import { Logo } from "./logo";
import { UserMenu, ThemeRadio, useLogout } from "./user-menu";
import { CommandPaletteProvider, useCommandPalette } from "./command-palette";
import { ErrorBoundary } from "@/components/error-boundary";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export function AppShell() {
  const navigate = useNavigate();
  const can = useCan();
  const plugins = usePlugins(can("plugins.view"));
  // keyed on the resolved location: s.location changes when a navigation starts, while the old page is still
  // rendered, so a crashed page would crash the fresh boundary again and keep showing the error after navigating
  const pathname = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).pathname });
  const queryClient = useQueryClient();

  React.useEffect(() => {
    live.onNavigate = (url) => navigate({ to: url as "/" });
    live.start();
    return () => live.stop();
  }, [navigate]);

  React.useEffect(() => {
    if (plugins.data) loadPluginUis(plugins.data).catch((e) => console.error("[beamhop] plugin UIs failed to load", e));
  }, [plugins.data]);

  return (
    <CommandPaletteProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <TopBar />
          <div className="mx-auto w-full min-w-0 max-w-[1600px] flex-1 px-3 pt-3 pb-[calc(5.5rem+env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pt-6 md:pb-8">
            {/* keyed so a crashed page doesn't keep showing the error after navigating away; Retry refetches the
                cache first (the shell may share the query the page crashed on), so it doesn't re-render the bad response */}
            <ErrorBoundary key={pathname} label="Page" onRetry={() => queryClient.refetchQueries().catch(() => {})}>
              <Outlet />
            </ErrorBoundary>
          </div>
        </SidebarInset>
        <BottomNav />
      </SidebarProvider>
    </CommandPaletteProvider>
  );
}

function useActive() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (to: string) => (to === "/" ? pathname === "/" : pathname === to || pathname.startsWith(`${to}/`));
}

function useBadges() {
  const can = useCan();
  const reports = useOpenReportCount(can("reports.view"));
  return (to: string) => (to === "/reports" && reports.data ? reports.data : undefined);
}

function AppSidebar() {
  const can = useCan();
  const isActive = useActive();
  const badge = useBadges();
  const { pages } = usePluginRegistry();
  const { data: me } = useMe();
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <Logo className="size-8 shrink-0" />
                <span className="grid leading-tight">
                  <span className="font-semibold">beamhop</span>
                  <span className="text-xs text-muted-foreground">relay admin</span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        {NAV.map((g) => {
          const items = g.items.filter((i) => can(i.perm));
          if (!items.length) return null;
          return (
            <SidebarGroup key={g.label}>
              <SidebarGroupLabel>{g.label}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {items.map((i) => (
                    <SidebarMenuItem key={i.to}>
                      <SidebarMenuButton asChild isActive={isActive(i.to)} tooltip={i.label}>
                        <Link to={i.to as "/"}>
                          <i.icon />
                          <span>{i.label}</span>
                        </Link>
                      </SidebarMenuButton>
                      {badge(i.to) && <SidebarMenuBadge className="bg-destructive/15 text-destructive">{badge(i.to)}</SidebarMenuBadge>}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
        {pages.length > 0 && can("plugins.use") && (
          <SidebarGroup>
            <SidebarGroupLabel>Plugins</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {pages.map((p) => {
                  const to = `/p/${p.plugin}/${p.path.replace(/^\//, "")}`;
                  return (
                    <SidebarMenuItem key={to}>
                      <SidebarMenuButton asChild isActive={isActive(to)} tooltip={p.title}>
                        <Link to="/p/$plugin/$" params={{ plugin: p.plugin, _splat: p.path.replace(/^\//, "") }}>
                          <Puzzle />
                          <span>{p.title}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        {me && (
          <SidebarMenu>
            <SidebarMenuItem>
              <UserMenu side="right" align="end">
                <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
                  <UserAvatar pubkey={me.pubkey} profile={me.profile} size={32} />
                  <span className="grid min-w-0 flex-1 text-left leading-tight">
                    <span className="truncate text-sm font-medium">{displayName(me.pubkey, me.profile)}</span>
                    <span className="truncate text-xs text-muted-foreground">{me.role}{profileName(me.profile) && ` · ${shortNpub(me.pubkey, 4)}`}</span>
                  </span>
                  <ChevronsUpDown className="ml-auto size-4" />
                </SidebarMenuButton>
              </UserMenu>
            </SidebarMenuItem>
          </SidebarMenu>
        )}
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function LiveDot() {
  const status = useLiveStatus();
  const color = status === "open" ? "bg-emerald-500" : status === "connecting" ? "bg-amber-500" : "bg-red-500";
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground" title={`Live stream: ${status}`}>
      <span className="relative flex size-2">
        {status === "open" && <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-60" />}
        <span className={cn("relative inline-flex size-2 rounded-full", color)} />
      </span>
      <span className="hidden lg:inline">{status === "open" ? "Live" : status === "connecting" ? "Connecting" : "Offline"}</span>
    </span>
  );
}

function TopBar() {
  const { open } = useCommandPalette();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: me } = useMe();
  const { pages } = usePluginRegistry();
  const pluginTitle = pathname.startsWith("/p/") ? pages.find((p) => pathname === `/p/${p.plugin}/${p.path.replace(/^\//, "")}`)?.title : undefined;
  const title = pluginTitle ?? titleForPath(pathname);
  return (
    <header className="sticky top-0 z-30 border-b bg-background/80 pt-safe backdrop-blur-lg supports-[backdrop-filter]:bg-background/70 md:rounded-t-xl">
      <div className="flex h-14 items-center gap-2 px-3 sm:px-4">
        <SidebarTrigger className="hidden md:inline-flex" />
        <Separator orientation="vertical" className="mr-1 hidden h-5 md:block" />
        <Link to="/" className="md:hidden">
          <Logo className="size-7" />
        </Link>
        <h2 className="truncate text-base font-semibold">{title}</h2>
        <div className="ml-auto flex items-center gap-1.5">
          <LiveDot />
          <Button variant="outline" size="sm" className="hidden w-56 justify-start text-muted-foreground md:inline-flex" onClick={open}>
            <Search /> Search…
            <Kbd className="ml-auto">⌘K</Kbd>
          </Button>
          <Button variant="ghost" size="icon" className="md:hidden" onClick={open} aria-label="Search">
            <Search />
          </Button>
          {me && (
            <UserMenu>
              <Button variant="ghost" size="icon" className="rounded-full md:hidden" aria-label="Account">
                <UserAvatar pubkey={me.pubkey} profile={me.profile} size={30} />
              </Button>
            </UserMenu>
          )}
        </div>
      </div>
    </header>
  );
}

function BottomNav() {
  const can = useCan();
  const isActive = useActive();
  const badge = useBadges();
  const [more, setMore] = React.useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  React.useEffect(() => setMore(false), [pathname]);
  const tabs = MOBILE_TABS.map((to) => ALL_NAV.find((i) => i.to === to)!).filter((i) => can(i.perm));
  const rest = ALL_NAV.filter((i) => !MOBILE_TABS.includes(i.to) && can(i.perm));
  const moreActive = rest.some((i) => isActive(i.to)) || pathname.startsWith("/p/");
  return (
    <>
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/90 pb-safe backdrop-blur-lg md:hidden" aria-label="Primary">
        <div className="mx-auto grid max-w-lg" style={{ gridTemplateColumns: `repeat(${tabs.length + 1}, minmax(0, 1fr))` }}>
          {tabs.map((i) => (
            <TabLink key={i.to} item={i} active={isActive(i.to)} badge={badge(i.to)} />
          ))}
          <button
            className={cn("relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium", moreActive ? "text-primary" : "text-muted-foreground")}
            onClick={() => setMore(true)}
          >
            <Menu className="size-5" />
            More
          </button>
        </div>
      </nav>
      <MoreDrawer open={more} onOpenChange={setMore} items={rest} isActive={isActive} />
    </>
  );
}

function TabLink({ item, active, badge }: { item: NavItem; active: boolean; badge?: number }) {
  return (
    <Link
      to={item.to as "/"}
      className={cn("relative flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors", active ? "text-primary" : "text-muted-foreground")}
    >
      <span className={cn("relative flex h-7 w-12 items-center justify-center rounded-full transition-colors", active && "bg-primary/12")}>
        <item.icon className="size-5" />
        {!!badge && (
          <span aria-hidden className="absolute -top-1 right-0.5 min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] leading-4 text-white">{badge > 99 ? "99+" : badge}</span>
        )}
      </span>
      {item.label}
      {/* read after the label ("Reports 10"), like the sidebar badge, not before it */}
      {!!badge && <span className="sr-only"> {badge > 99 ? "99+" : badge}</span>}
    </Link>
  );
}

function MoreDrawer({ open, onOpenChange, items, isActive }: { open: boolean; onOpenChange: (o: boolean) => void; items: NavItem[]; isActive: (to: string) => boolean }) {
  const { pages } = usePluginRegistry();
  const can = useCan();
  const doLogout = useLogout();
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[85dvh]">
        <DrawerHeader className="text-left">
          <DrawerTitle>More</DrawerTitle>
        </DrawerHeader>
        <div className="overflow-y-auto px-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <div className="grid grid-cols-3 gap-2 pb-3">
            {items.map((i) => (
              <Link
                key={i.to}
                to={i.to as "/"}
                className={cn("flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl border p-2 text-xs font-medium", isActive(i.to) ? "border-primary/50 bg-primary/5 text-primary" : "bg-card")}
              >
                <i.icon className="size-5" />
                {i.label}
              </Link>
            ))}
            {can("plugins.use") &&
              pages.map((p) => (
                <Link
                  key={`${p.plugin}/${p.path}`}
                  to="/p/$plugin/$"
                  params={{ plugin: p.plugin, _splat: p.path.replace(/^\//, "") }}
                  className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-xl border bg-card p-2 text-center text-xs font-medium"
                >
                  <Puzzle className="size-5" />
                  {p.title}
                </Link>
              ))}
          </div>
          <div className="flex items-center justify-between gap-2 border-t py-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">Theme</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <ThemeRadio />
              </DropdownMenuContent>
            </DropdownMenu>
            <Button variant="ghost" className="text-destructive" onClick={doLogout}>
              Sign out
            </Button>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
