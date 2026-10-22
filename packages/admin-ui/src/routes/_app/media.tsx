import * as React from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Check, ChevronLeft, ChevronRight, Download, File, FileAudio, FileVideo, Image as ImageIcon, ShieldOff, Trash2, X } from "lucide-react";
import type { BlobStatus, MediaItem } from "@beamhop/sdk/admin-contract";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { PageHeader } from "@/components/page-header";
import { BlobStatusBadge } from "@/components/badges";
import { UserChip } from "@/components/user-chip";
import { CopyButton } from "@/components/copy-button";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { InfiniteSentinel } from "@/components/infinite-sentinel";
import { SelectionBar } from "@/components/selection-bar";
import { SwipeRow } from "@/components/swipe-row";
import { PullToRefresh } from "@/components/pull-to-refresh";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/confirm";
import { useMedia, useMediaActions, useMediaStats } from "@/queries/content";
import { useCan } from "@/queries/auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { formatBytes, formatDate, formatNumber, timeAgo } from "@/lib/format";
import { parsePubkey } from "@/lib/nostr";
import { cn } from "@/lib/utils";

interface MediaSearch { status?: BlobStatus; type?: string; pubkey?: string }
const STATUSES: BlobStatus[] = ["approved", "pending", "blocked"];
const TYPES: [string, string][] = [["image/", "Images"], ["video/", "Videos"], ["audio/", "Audio"], ["application/", "Other"]];

export const Route = createFileRoute("/_app/media")({
  validateSearch: (s: Record<string, unknown>): MediaSearch => ({
    status: STATUSES.includes(s.status as BlobStatus) ? (s.status as BlobStatus) : undefined,
    type: typeof s.type === "string" && s.type ? s.type : undefined,
    pubkey: typeof s.pubkey === "string" && s.pubkey ? s.pubkey : undefined,
  }),
  component: MediaPage,
});

const kindOf = (t: string) => (t.startsWith("image/") ? "image" : t.startsWith("video/") ? "video" : t.startsWith("audio/") ? "audio" : "file");
const TypeIcon = ({ type, className }: { type: string; className?: string }) => {
  const k = kindOf(type);
  const I = k === "image" ? ImageIcon : k === "video" ? FileVideo : k === "audio" ? FileAudio : File;
  return <I className={className} />;
};

function MediaPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const setSearch = (p: Partial<MediaSearch>) => navigate({ search: (prev: MediaSearch) => ({ ...prev, ...p }), replace: true });
  const q = useMedia(search);
  const items = React.useMemo(() => q.data?.pages.flatMap((p) => p.items) ?? [], [q.data]);
  const total = q.data?.pages[0]?.total;
  const stats = useMediaStats();
  const { setStatus, remove, bulk } = useMediaActions();
  const can = useCan();
  const mod = can("media.moderate");
  const mobile = useIsMobile();
  const confirm = useConfirm();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [open, setOpen] = React.useState<number | null>(null);
  const [pkDraft, setPkDraft] = React.useState(search.pubkey ?? "");
  React.useEffect(() => setSelected(new Set()), [search.status, search.type, search.pubkey]);

  const doDelete = async (b: MediaItem) => {
    const r = await confirm({
      title: "Delete this blob?",
      description: `${formatBytes(b.size)} ${b.type}. The file is removed from storage.`,
      destructive: true,
      confirmText: "Delete",
      options: [{ key: "block", label: "Also block this hash from being re-uploaded", default: true }],
    });
    if (!r) return false;
    await remove.mutateAsync({ sha256: b.sha256, block: r.options.block });
    if (open !== null) setOpen(null);
  };
  const doBulk = async (action: "approve" | "block" | "delete") => {
    if (action !== "approve" && !(await confirm({ title: `${action === "delete" ? "Delete" : "Block"} ${selected.size} blob(s)?`, destructive: true, confirmText: action === "delete" ? "Delete" : "Block" }))) return;
    await bulk.mutateAsync({ sha256s: [...selected], action });
    setSelected(new Set());
  };
  const toggle = (sha: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(sha);
      else n.delete(sha);
      return n;
    });

  return (
    <div className="space-y-4">
      <PageHeader title="Media" description="Blossom blobs stored on this server" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <StatTile label="Blobs" value={stats.data ? formatNumber(stats.data.count) : undefined} />
        <StatTile label="Storage" value={stats.data ? formatBytes(stats.data.bytes) : undefined} />
        <StatTile label="Pending review" value={stats.data ? formatNumber(stats.data.pending) : undefined} highlight={!!stats.data?.pending} onClick={() => setSearch({ status: "pending" })} />
        <StatTile
          label="By type"
          value={
            stats.data ? (
              <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted" title={stats.data.byType.map((t) => `${t.type}: ${formatBytes(t.bytes)}`).join("\n")}>
                {stats.data.byType.slice(0, 5).map((t, i) => (
                  <div key={t.type} style={{ width: `${(t.bytes / Math.max(1, stats.data!.bytes)) * 100}%`, background: `var(--chart-${(i % 5) + 1})` }} />
                ))}
              </div>
            ) : undefined
          }
        />
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select value={search.status ?? "__all"} onValueChange={(v) => setSearch({ status: v === "__all" ? undefined : (v as BlobStatus) })}>
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">Any status</SelectItem>
            {STATUSES.map((s) => (
              <SelectItem key={s} value={s} className="capitalize">
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={search.type ?? "__all"} onValueChange={(v) => setSearch({ type: v === "__all" ? undefined : v })}>
          <SelectTrigger className="sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">Any type</SelectItem>
            {TYPES.map(([v, l]) => (
              <SelectItem key={v} value={v}>
                {l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <form
          className="flex flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch({ pubkey: pkDraft.trim() ? (parsePubkey(pkDraft) ?? pkDraft.trim()) : undefined });
          }}
        >
          <Input value={pkDraft} onChange={(e) => setPkDraft(e.target.value)} placeholder="Owner npub or hex" />
          {search.pubkey && (
            <Button type="button" variant="ghost" size="icon" onClick={() => { setPkDraft(""); setSearch({ pubkey: undefined }); }} aria-label="Clear owner filter">
              <X />
            </Button>
          )}
        </form>
        {mod && items.length > 0 && !mobile && (
          <label className="flex items-center gap-2 text-sm whitespace-nowrap text-muted-foreground">
            <Checkbox checked={items.every((b) => selected.has(b.sha256))} onCheckedChange={(v) => setSelected(v === true ? new Set(items.map((b) => b.sha256)) : new Set())} />
            Select all {total !== undefined && `(${formatNumber(items.length)}/${formatNumber(total)})`}
          </label>
        )}
      </div>

      <PullToRefresh onRefresh={() => Promise.all([q.refetch(), stats.refetch()])}>
        {q.isLoading ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {Array.from({ length: 12 }, (_, i) => (
              <Skeleton key={i} className="aspect-square rounded-xl" />
            ))}
          </div>
        ) : q.isError ? (
          <ErrorState error={q.error} retry={() => q.refetch()} />
        ) : !items.length ? (
          <EmptyState icon={ImageIcon} title="No media" description="Nothing matches the current filters." />
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6">
            {items.map((b, i) => {
              const tile = (
                <Tile b={b} selected={selected.has(b.sha256)} selectable={mod} selecting={selected.size > 0} onSelect={(on) => toggle(b.sha256, on)} onOpen={() => setOpen(i)} />
              );
              return mobile && mod ? (
                <SwipeRow
                  key={b.sha256}
                  className="rounded-xl"
                  right={b.status !== "approved" ? { label: "Approve", icon: Check, className: "bg-emerald-600 text-white", onTrigger: () => setStatus.mutateAsync({ sha256: b.sha256, status: "approved" }) } : undefined}
                  left={{ label: "Delete", icon: Trash2, className: "bg-red-600 text-white", onTrigger: () => doDelete(b) }}
                >
                  {tile}
                </SwipeRow>
              ) : (
                <React.Fragment key={b.sha256}>{tile}</React.Fragment>
              );
            })}
          </div>
        )}
        <InfiniteSentinel hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onVisible={() => q.fetchNextPage()} />
      </PullToRefresh>

      <SelectionBar count={selected.size} onClear={() => setSelected(new Set())}>
        <Button size="sm" variant="ghost" className="rounded-full" onClick={() => doBulk("approve")}>
          <Check /> Approve
        </Button>
        <Button size="sm" variant="ghost" className="rounded-full" onClick={() => doBulk("block")}>
          <ShieldOff /> Block
        </Button>
        <Button size="sm" variant="ghost" className="rounded-full text-destructive" onClick={() => doBulk("delete")}>
          <Trash2 /> Delete
        </Button>
      </SelectionBar>

      <Lightbox
        items={items}
        index={open}
        onIndex={setOpen}
        canModerate={mod}
        onStatus={(b, status) => setStatus.mutate({ sha256: b.sha256, status })}
        onDelete={doDelete}
      />
    </div>
  );
}

function StatTile({ label, value, highlight, onClick }: { label: string; value?: React.ReactNode; highlight?: boolean; onClick?: () => void }) {
  return (
    <Card className={cn("gap-1 px-4 py-3", onClick && "cursor-pointer hover:bg-muted/40", highlight && "border-amber-500/50")} onClick={onClick}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="flex h-7 items-center text-lg font-semibold tabular-nums">{value ?? <Skeleton className="h-5 w-16" />}</div>
    </Card>
  );
}

function Tile({ b, selected, selectable, selecting, onSelect, onOpen }: { b: MediaItem; selected: boolean; selectable: boolean; selecting: boolean; onSelect: (v: boolean) => void; onOpen: () => void }) {
  const k = kindOf(b.type);
  const thumb = b.thumbnailUrl ?? (k === "image" ? b.url : undefined);
  return (
    <div className={cn("group relative aspect-square overflow-hidden rounded-xl border bg-muted", selected && "ring-2 ring-primary")}>
      <button className="absolute inset-0 size-full" onClick={() => (selecting ? onSelect(!selected) : onOpen())} aria-label={`Open ${b.sha256.slice(0, 8)}`}>
        {thumb ? (
          <img src={thumb} alt="" loading="lazy" className={cn("size-full object-cover transition-transform group-hover:scale-105", b.status === "blocked" && "opacity-40 grayscale")} />
        ) : (
          <div className="flex size-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <TypeIcon type={b.type} className="size-8" />
            <span className="text-xs">{b.type}</span>
          </div>
        )}
      </button>
      {selectable && (
        <div className={cn("absolute top-2 left-2 transition-opacity", selected || selecting ? "opacity-100" : "opacity-0 group-hover:opacity-100 pointer-coarse:opacity-0")}>
          <Checkbox checked={selected} onCheckedChange={(v) => onSelect(v === true)} className="bg-background/80 shadow" aria-label="Select" />
        </div>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-1 bg-gradient-to-t from-black/70 to-transparent p-2 pt-6 text-[11px] text-white">
        <span className="flex items-center gap-1">
          {k !== "image" && thumb && <TypeIcon type={b.type} className="size-3" />}
          {formatBytes(b.size)}
        </span>
        {b.status !== "approved" && <BlobStatusBadge status={b.status} />}
      </div>
    </div>
  );
}

function Lightbox({
  items, index, onIndex, canModerate, onStatus, onDelete,
}: {
  items: MediaItem[];
  index: number | null;
  onIndex: (i: number | null) => void;
  canModerate: boolean;
  onStatus: (b: MediaItem, s: BlobStatus) => void;
  onDelete: (b: MediaItem) => void;
}) {
  const b = index !== null ? items[index] : undefined;
  const go = React.useCallback((d: number) => index !== null && onIndex(Math.max(0, Math.min(items.length - 1, index + d))), [index, items.length, onIndex]);
  React.useEffect(() => {
    if (index === null) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [index, go]);
  const touch = React.useRef<number | null>(null);
  return (
    <Dialog open={!!b} onOpenChange={(o) => !o && onIndex(null)}>
      <DialogContent className="max-h-[95dvh] gap-3 overflow-y-auto p-3 sm:max-w-4xl sm:p-4">
        {b && (
          <>
            <DialogTitle className="sr-only">Blob {b.sha256}</DialogTitle>
            <DialogDescription className="sr-only">{b.type}</DialogDescription>
            <div
              className="relative flex min-h-48 items-center justify-center overflow-hidden rounded-lg bg-black/90"
              onTouchStart={(e) => (touch.current = e.touches[0].clientX)}
              onTouchEnd={(e) => {
                if (touch.current === null) return;
                const dx = e.changedTouches[0].clientX - touch.current;
                if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
                touch.current = null;
              }}
            >
              {kindOf(b.type) === "image" ? (
                <img src={b.url} alt="" className="max-h-[65dvh] max-w-full object-contain" />
              ) : kindOf(b.type) === "video" ? (
                <video src={b.url} controls playsInline className="max-h-[65dvh] max-w-full" />
              ) : kindOf(b.type) === "audio" ? (
                <audio src={b.url} controls className="m-8 w-full max-w-md" />
              ) : (
                <div className="flex flex-col items-center gap-2 p-10 text-white/70">
                  <File className="size-12" />
                  {b.type}
                </div>
              )}
              {index! > 0 && (
                <Button variant="secondary" size="icon" className="absolute left-2 rounded-full opacity-80" onClick={() => go(-1)} aria-label="Previous">
                  <ChevronLeft />
                </Button>
              )}
              {index! < items.length - 1 && (
                <Button variant="secondary" size="icon" className="absolute right-2 rounded-full opacity-80" onClick={() => go(1)} aria-label="Next">
                  <ChevronRight />
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <BlobStatusBadge status={b.status} />
              <span className="text-muted-foreground">
                {b.type} · {formatBytes(b.size)} · <span title={formatDate(b.createdAt)}>{timeAgo(b.createdAt)}</span>
              </span>
              <div className="flex min-w-0 items-center gap-1">
                <code className="truncate text-xs text-muted-foreground">{b.sha256.slice(0, 16)}…</code>
                <CopyButton value={b.sha256} label="Hash copied" size="icon-xs" />
              </div>
            </div>
            {b.owners.length > 0 && (
              <div className="flex flex-wrap gap-3">
                {b.owners.slice(0, 6).map((o) => (
                  <UserChip key={o} pubkey={o} size={24} />
                ))}
                {b.owners.length > 6 && <span className="text-xs text-muted-foreground">+{b.owners.length - 6} more</span>}
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" asChild>
                <a href={b.url} target="_blank" rel="noreferrer" download>
                  <Download /> Open
                </a>
              </Button>
              {canModerate && (
                <>
                  {b.status !== "approved" && (
                    <Button size="sm" variant="outline" onClick={() => onStatus(b, "approved")}>
                      <Check /> Approve
                    </Button>
                  )}
                  {b.status !== "blocked" && (
                    <Button size="sm" variant="outline" onClick={() => onStatus(b, "blocked")}>
                      <ShieldOff /> Block
                    </Button>
                  )}
                  <Button size="sm" variant="destructive" className="ml-auto" onClick={() => onDelete(b)}>
                    <Trash2 /> Delete
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
