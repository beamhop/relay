import * as React from "react";
import { Link } from "@tanstack/react-router";
import { nip19 } from "nostr-tools";
import { Braces, Copy, ExternalLink, Flag, Heart, MoreHorizontal, Repeat2, Trash2, User } from "lucide-react";
import type { NostrEvent, Profile } from "@beamhop/sdk/admin-contract";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDate, timeAgo } from "@/lib/format";
import { displayName, getTag, getTags, shortHex } from "@/lib/nostr";
import { usePluginRegistry } from "@/plugins/registry";
import { copyText } from "./copy-button";
import { JsonView } from "./json-view";
import { KindBadge, ToneBadge } from "./badges";
import { ResponsiveDialog } from "./responsive-dialog";
import { UserAvatar } from "./user-avatar";
import { toast } from "sonner";

export function EventCard({
  event, author, reports, selected, onSelect, onDelete, className, compact, footer,
}: {
  event: NostrEvent;
  author?: Profile;
  reports?: number;
  selected?: boolean;
  onSelect?: (v: boolean) => void;
  onDelete?: () => void;
  className?: string;
  compact?: boolean;
  footer?: React.ReactNode;
}) {
  const [json, setJson] = React.useState(false);
  const { eventActions } = usePluginRegistry();
  return (
    <div className={cn("rounded-xl border bg-card p-3 text-card-foreground transition-colors sm:p-4", selected && "border-primary/60 bg-primary/5", className)}>
      <div className="flex items-start gap-3">
        {onSelect && (
          <Checkbox className="mt-2.5" checked={!!selected} onCheckedChange={(v) => onSelect(v === true)} aria-label="Select event" />
        )}
        <Link to="/users/$pubkey" params={{ pubkey: event.pubkey }} className="shrink-0">
          <UserAvatar pubkey={event.pubkey} profile={author} size={compact ? 32 : 40} />
        </Link>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link to="/users/$pubkey" params={{ pubkey: event.pubkey }} className="truncate text-sm font-medium hover:underline">
              {displayName(event.pubkey, author)}
            </Link>
            <span className="text-xs text-muted-foreground" title={formatDate(event.created_at)}>
              {timeAgo(event.created_at)}
            </span>
            <KindBadge kind={event.kind} className="ml-auto" />
            {!!reports && (
              <ToneBadge t="red">
                <Flag className="size-3" /> {reports}
              </ToneBadge>
            )}
          </div>
          <div className="mt-1.5">
            <EventContent event={event} compact={compact} />
          </div>
          {footer}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="-mt-1 -mr-1 shrink-0" aria-label="Event actions">
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onSelect={() => setJson(true)}>
              <Braces /> Inspect JSON
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => copyText(event.id, "Event id copied")}>
              <Copy /> Copy id
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => copyText(nip19.neventEncode({ id: event.id, author: event.pubkey, kind: event.kind }), "nevent copied")}>
              <Copy /> Copy nevent
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/users/$pubkey" params={{ pubkey: event.pubkey }}>
                <User /> View author
              </Link>
            </DropdownMenuItem>
            {eventActions.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground">Plugins</DropdownMenuLabel>
                {eventActions.map((a) => (
                  <DropdownMenuItem
                    key={`${a.plugin}:${a.id}`}
                    variant={a.destructive ? "destructive" : "default"}
                    onSelect={async () => {
                      try {
                        await a.run(event.id);
                      } catch (e) {
                        toast.error(`${a.label} failed`, { description: (e as Error).message });
                      }
                    }}
                  >
                    {a.label}
                  </DropdownMenuItem>
                ))}
              </>
            )}
            {onDelete && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <Trash2 /> Delete event
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <ResponsiveDialog open={json} onOpenChange={setJson} title="Event JSON" description={shortHex(event.id, 12)} className="sm:max-w-2xl">
        <JsonView value={event} className="mb-4" />
      </ResponsiveDialog>
    </div>
  );
}

const URL_RE = /(https?:\/\/[^\s<>"]+)/g;
const IMG_RE = /\.(png|jpe?g|gif|webp|avif|svg)(\?.*)?$/i;
const VID_RE = /\.(mp4|webm|mov|m4v)(\?.*)?$/i;

export function RichText({ text, compact, media = true }: { text: string; compact?: boolean; media?: boolean }) {
  const [expanded, setExpanded] = React.useState(false);
  const limit = compact ? 280 : 900;
  const long = text.length > limit;
  const shown = long && !expanded ? `${text.slice(0, limit)}…` : text;
  const parts = shown.split(URL_RE);
  const urls = media ? (text.match(URL_RE) ?? []).filter((u) => IMG_RE.test(u) || VID_RE.test(u)).slice(0, 4) : [];
  return (
    <div className="space-y-2">
      <p className="text-sm break-words whitespace-pre-wrap [overflow-wrap:anywhere]">
        {parts.map((p, i) =>
          i % 2 ? (
            <a key={i} href={p} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">
              {p.length > 60 ? `${p.slice(0, 57)}…` : p}
            </a>
          ) : (
            <React.Fragment key={i}>{p.replace(/nostr:(npub|nprofile|note|nevent|naddr)1[02-9ac-hj-np-z]+/g, (m) => `${m.slice(0, 18)}…`)}</React.Fragment>
          ),
        )}
      </p>
      {long && (
        <button className="text-xs font-medium text-primary" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
      {urls.length > 0 && (
        <div className={cn("grid gap-2", urls.length > 1 && "grid-cols-2")}>
          {urls.map((u) =>
            VID_RE.test(u) ? (
              <video key={u} src={u} controls preload="metadata" className="max-h-72 w-full rounded-lg border bg-black" />
            ) : (
              <a key={u} href={u} target="_blank" rel="noreferrer noopener">
                <img src={u} alt="" loading="lazy" referrerPolicy="no-referrer" className="max-h-72 w-full rounded-lg border object-cover" />
              </a>
            ),
          )}
        </div>
      )}
    </div>
  );
}

export function EventContent({ event, compact }: { event: NostrEvent; compact?: boolean }) {
  const { kind, content, tags } = event;
  switch (kind) {
    case 0: {
      let p: Profile = {};
      try {
        p = JSON.parse(content);
      } catch {
        /* invalid */
      }
      return (
        <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-2.5">
          <UserAvatar pubkey={event.pubkey} profile={p} size={40} />
          <div className="min-w-0 text-sm">
            <p className="truncate font-medium">{p.display_name || p.name || "Unnamed"}</p>
            {p.nip05 && <p className="truncate text-xs text-muted-foreground">{p.nip05}</p>}
            {p.about && <p className="line-clamp-2 text-xs text-muted-foreground">{p.about}</p>}
          </div>
        </div>
      );
    }
    case 3:
      return <p className="text-sm text-muted-foreground">Follows {getTags(tags, "p").length} accounts</p>;
    case 5:
      return (
        <p className="text-sm text-muted-foreground">
          Requests deletion of {getTags(tags, "e").length + getTags(tags, "a").length} event(s){content ? ` — “${content}”` : ""}
        </p>
      );
    case 6:
    case 16: {
      let inner: NostrEvent | undefined;
      try {
        inner = content ? JSON.parse(content) : undefined;
      } catch {
        /* ignore */
      }
      return (
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Repeat2 className="size-4" /> Reposted {shortHex(getTag(tags, "e") ?? "", 6)}
          </p>
          {inner?.content && (
            <div className="rounded-lg border bg-muted/30 p-2.5">
              <RichText text={inner.content} compact media={false} />
            </div>
          )}
        </div>
      );
    }
    case 7:
      return (
        <p className="flex items-center gap-2 text-sm">
          <span className="text-lg leading-none">{content === "+" || !content ? <Heart className="size-4 fill-red-500 text-red-500" /> : content === "-" ? "👎" : content}</span>
          <span className="text-muted-foreground">reacted to {shortHex(getTag(tags, "e") ?? "", 6)}</span>
        </p>
      );
    case 1984: {
      const p = tags.find((t) => t[0] === "p");
      const e = tags.find((t) => t[0] === "e");
      const type = e?.[2] || p?.[2] || "other";
      return (
        <div className="space-y-1 text-sm">
          <p>
            <ToneBadge t="red">{type}</ToneBadge> report against {e ? `event ${shortHex(e[1], 6)}` : `user ${shortHex(p?.[1] ?? "", 6)}`}
          </p>
          {content && <p className="text-muted-foreground">{content}</p>}
        </div>
      );
    }
    case 9735:
      return <p className="text-sm text-muted-foreground">⚡ Zap receipt{getTag(tags, "amount") ? ` · ${Number(getTag(tags, "amount")) / 1000} sats` : ""}</p>;
    case 30023:
    case 30024: {
      const title = getTag(tags, "title");
      const summary = getTag(tags, "summary");
      const image = getTag(tags, "image");
      return (
        <div className="overflow-hidden rounded-lg border">
          {image && <img src={image} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-36 w-full object-cover" />}
          <div className="space-y-1 p-3">
            <p className="font-semibold">{title || "Untitled article"}</p>
            <p className="line-clamp-3 text-sm text-muted-foreground">{summary || content.slice(0, 300)}</p>
          </div>
        </div>
      );
    }
    case 1059:
    case 4:
    case 13:
      return <p className="text-sm text-muted-foreground italic">Encrypted content ({content.length} chars)</p>;
    default: {
      const t = getTag(tags, "title") ?? getTag(tags, "name") ?? getTag(tags, "d");
      if (kind === 1 || kind === 11 || kind === 1111 || kind === 9 || kind === 10 || kind === 42 || kind === 1311 || kind === 20 || kind === 21 || kind === 22 || content)
        return (
          <div className="space-y-1">
            {t && kind >= 30000 && <p className="text-sm font-medium">{t}</p>}
            {content ? <RichText text={content} compact={compact} /> : <TagsSummary tags={tags} />}
          </div>
        );
      return (
        <div className="space-y-1">
          {t && <p className="text-sm font-medium">{t}</p>}
          <TagsSummary tags={tags} />
        </div>
      );
    }
  }
}

function TagsSummary({ tags }: { tags: string[][] }) {
  if (!tags.length) return <p className="text-sm text-muted-foreground italic">No content</p>;
  const counts = new Map<string, number>();
  for (const t of tags) counts.set(t[0], (counts.get(t[0]) ?? 0) + 1);
  return (
    <div className="flex flex-wrap gap-1">
      {[...counts].slice(0, 10).map(([k, n]) => (
        <Badge key={k} variant="outline" className="font-mono text-[11px] font-normal">
          {k}×{n}
        </Badge>
      ))}
    </div>
  );
}

export function ExternalNjump({ id }: { id: string }) {
  return (
    <a href={`https://njump.me/${nip19.noteEncode(id)}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      njump <ExternalLink className="size-3" />
    </a>
  );
}
