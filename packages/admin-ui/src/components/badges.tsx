import type { AdminRole, BlobStatus, UserStatus } from "@beamhop/sdk/admin-contract";
import { Badge } from "@/components/ui/badge";
import { kindName } from "@/lib/nostr";
import { cn } from "@/lib/utils";

const tone = {
  green: "border-transparent bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
  red: "border-transparent bg-red-500/15 text-red-700 dark:text-red-400",
  amber: "border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-400",
  violet: "border-transparent bg-violet-500/15 text-violet-700 dark:text-violet-400",
  sky: "border-transparent bg-sky-500/15 text-sky-700 dark:text-sky-400",
  gray: "border-transparent bg-muted text-muted-foreground",
};
export type Tone = keyof typeof tone;

export function ToneBadge({ t, children, className }: { t: Tone; children: React.ReactNode; className?: string }) {
  return <Badge variant="outline" className={cn(tone[t], className)}>{children}</Badge>;
}

export function UserStatusBadge({ status }: { status: UserStatus }) {
  return <ToneBadge t={status === "banned" ? "red" : status === "muted" ? "amber" : "green"}>{status}</ToneBadge>;
}
export function RoleBadge({ role }: { role: AdminRole | null }) {
  if (!role) return null;
  return <ToneBadge t={role === "owner" ? "violet" : role === "admin" ? "sky" : "gray"}>{role}</ToneBadge>;
}
export function BlobStatusBadge({ status }: { status: BlobStatus }) {
  return <ToneBadge t={status === "approved" ? "green" : status === "blocked" ? "red" : "amber"}>{status}</ToneBadge>;
}
export function KindBadge({ kind, className }: { kind: number; className?: string }) {
  return (
    <Badge variant="secondary" className={cn("font-normal", className)} title={`kind ${kind}`}>
      {kindName(kind)} <span className="text-muted-foreground tabular-nums">· {kind}</span>
    </Badge>
  );
}
