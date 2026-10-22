import {
  Activity, FileText, Flag, Image, Info, KeyRound, LayoutDashboard, Puzzle, ScrollText, Settings, Shield, ShieldBan, Ticket, Users, UsersRound,
  type LucideIcon,
} from "lucide-react";
import type { Permission } from "@beamhop/sdk/admin-contract";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  perm?: Permission;
  keywords?: string;
}
export interface NavGroup { label: string; items: NavItem[] }

export const NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard, perm: "dashboard.view", keywords: "home stats metrics map" },
      { to: "/live", label: "Live", icon: Activity, perm: "dashboard.view", keywords: "stream connections realtime" },
    ],
  },
  {
    label: "Community",
    items: [
      { to: "/users", label: "Users", icon: Users, perm: "users.view", keywords: "pubkeys members ban" },
      { to: "/admins", label: "Admins", icon: Shield, perm: "admins.manage", keywords: "roles moderators" },
      { to: "/invites", label: "Invites", icon: Ticket, perm: "invites.manage", keywords: "codes links" },
      { to: "/ip-rules", label: "IP rules", icon: ShieldBan, perm: "ip.manage", keywords: "block cidr firewall" },
    ],
  },
  {
    label: "Content",
    items: [
      { to: "/content", label: "Events", icon: FileText, perm: "content.view", keywords: "notes browse import export" },
      { to: "/reports", label: "Reports", icon: Flag, perm: "reports.view", keywords: "moderation queue 1984" },
      { to: "/media", label: "Media", icon: Image, perm: "media.view", keywords: "blossom blobs files" },
      { to: "/groups", label: "Groups", icon: UsersRound, perm: "groups.view", keywords: "nip-29 communities" },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/settings", label: "Settings", icon: Settings, perm: "settings.view", keywords: "config limits moderation" },
      { to: "/plugins", label: "Plugins", icon: Puzzle, perm: "plugins.view", keywords: "extensions" },
      { to: "/audit", label: "Audit log", icon: ScrollText, perm: "audit.view", keywords: "history actions" },
      { to: "/system", label: "System", icon: Info, keywords: "version runtime about" },
      { to: "/account", label: "Account", icon: KeyRound, keywords: "password passkey push profile" },
    ],
  },
];

export const ALL_NAV = NAV.flatMap((g) => g.items);
export const MOBILE_TABS = ["/", "/users", "/content", "/reports"];

export function titleForPath(pathname: string): string {
  if (pathname === "/" || pathname === "") return "Dashboard";
  const hit = [...ALL_NAV].filter((i) => i.to !== "/").sort((a, b) => b.to.length - a.to.length).find((i) => pathname.startsWith(i.to));
  return hit?.label ?? "beamhop";
}

