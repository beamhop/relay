import * as React from "react";
import { EyeOff, FileVideo, Image as ImageIcon } from "lucide-react";
import { mediaVerdict } from "@/lib/media-policy";
import { useMediaPolicy } from "@/lib/prefs";
import { cn } from "@/lib/utils";

/**
 * An image or video URL taken from event content. Loads right away only when the media policy allows it (this
 * relay's own origin, or the admin opted in to remote media); otherwise shows a placeholder naming the host and
 * loads on click. `sensitive` (reported content) never auto-loads, and stays blurred until hovered.
 */
export function RemoteMedia({ url, type, sensitive, className }: { url: string; type: "image" | "video"; sensitive?: boolean; className?: string }) {
  const policy = useMediaPolicy();
  const [clicked, setClicked] = React.useState(false);
  const v = mediaVerdict(url, policy);
  if (v.kind === "none") return null;
  const host = v.kind === "ask" ? v.host : new URL(v.src).host;
  if (!clicked && (v.kind === "ask" || sensitive)) {
    const Icon = sensitive ? EyeOff : type === "video" ? FileVideo : ImageIcon;
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setClicked(true);
        }}
        className={cn("flex min-h-24 w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed bg-muted/40 p-3 text-xs text-muted-foreground transition-colors hover:bg-muted", className)}
        title={v.src}
      >
        <Icon className="size-5" />
        <span className="font-medium text-foreground">{sensitive ? `Show reported ${type}` : `Load ${type}`}</span>
        <span className="max-w-full truncate">from {host}</span>
      </button>
    );
  }
  const blur = sensitive && "blur-md transition hover:blur-none";
  return type === "video" ? (
    // <video> has no referrerpolicy attribute; the document's Referrer-Policy (same-origin) keeps the referrer off
    <video src={v.src} controls preload="metadata" className={cn("max-h-72 w-full rounded-lg border bg-black", blur, className)} />
  ) : (
    <a href={v.src} target="_blank" rel="noreferrer noopener" className="block overflow-hidden rounded-lg">
      <img src={v.src} alt="" loading="lazy" referrerPolicy="no-referrer" className={cn("max-h-72 w-full rounded-lg border object-cover", blur, className)} />
    </a>
  );
}
