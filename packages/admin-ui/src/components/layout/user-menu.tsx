import { Link, useNavigate } from "@tanstack/react-router";
import { KeyRound, LogOut, Monitor, Moon, Sun } from "lucide-react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useMe } from "@/queries/auth";
import { useTheme, type Theme } from "@/lib/theme";
import { logout } from "@/lib/auth";
import { live } from "@/lib/live";
import { unsubscribePush } from "@/lib/push";
import { resetPluginUis } from "@/plugins/loader";
import { displayName, profileName, shortNpub } from "@/lib/nostr";
import { RoleBadge } from "@/components/badges";

export function ThemeRadio() {
  const { theme, setTheme } = useTheme();
  return (
    <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
      <DropdownMenuRadioItem value="light"><Sun /> Light</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="dark"><Moon /> Dark</DropdownMenuRadioItem>
      <DropdownMenuRadioItem value="system"><Monitor /> System</DropdownMenuRadioItem>
    </DropdownMenuRadioGroup>
  );
}

export function useLogout() {
  const navigate = useNavigate();
  return async () => {
    live.stop();
    resetPluginUis();
    // drop this device's push subscription while the session is still valid, so a shared device stops receiving alerts
    await unsubscribePush().catch(() => {});
    await logout().catch(() => {});
    navigate({ to: "/login" });
  };
}

export function UserMenu({ children, side = "bottom", align = "end" }: { children: React.ReactNode; side?: "top" | "bottom" | "right"; align?: "start" | "end" }) {
  const { data: me } = useMe();
  const doLogout = useLogout();
  if (!me) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={align} className="w-60">
        <DropdownMenuLabel className="flex items-center justify-between gap-2 font-normal">
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{displayName(me.pubkey, me.profile)}</span>
            {profileName(me.profile) && <span className="block truncate text-xs text-muted-foreground">{shortNpub(me.pubkey, 6)}</span>}
          </span>
          <RoleBadge role={me.role} />
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/account"><KeyRound /> Account & security</Link>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger><Sun className="dark:hidden" /><Moon className="hidden dark:block" /> Theme</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <ThemeRadio />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={doLogout}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
