import { Link } from "@tanstack/react-router";
import type { Profile } from "@beamhop/sdk/admin-contract";
import { displayName, shortNpub } from "@/lib/nostr";
import { cn } from "@/lib/utils";
import { UserAvatar } from "./user-avatar";

export function UserChip({
  pubkey, profile, link = true, size = 32, sub, className,
}: { pubkey: string; profile?: Profile; link?: boolean; size?: number; sub?: React.ReactNode; className?: string }) {
  const inner = (
    <>
      <UserAvatar pubkey={pubkey} profile={profile} size={size} />
      <span className="min-w-0 leading-tight">
        <span className="block truncate text-sm font-medium">{displayName(pubkey, profile)}</span>
        <span className="block truncate text-xs text-muted-foreground">{sub ?? (profile?.nip05 || shortNpub(pubkey, 6))}</span>
      </span>
    </>
  );
  const cls = cn("flex min-w-0 items-center gap-2.5", className);
  if (!link) return <span className={cls}>{inner}</span>;
  return (
    <Link to="/users/$pubkey" params={{ pubkey }} className={cn(cls, "rounded-md hover:opacity-80")} onClick={(e) => e.stopPropagation()}>
      {inner}
    </Link>
  );
}
