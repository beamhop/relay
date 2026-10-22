import * as React from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Braces, Download, FileText, Filter as FilterIcon, Plus, RotateCcw, Search, SlidersHorizontal, Trash2, Upload, X } from "lucide-react";
import type { Filter, ImportResult } from "@beamhop/sdk/admin-contract";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/page-header";
import { ListInput } from "@/components/list-input";
import { EventCard } from "@/components/event-card";
import { EmptyState, ErrorState } from "@/components/empty-state";
import { ListSkeleton } from "@/components/page-skeleton";
import { InfiniteSentinel } from "@/components/infinite-sentinel";
import { SelectionBar } from "@/components/selection-bar";
import { SwipeRow } from "@/components/swipe-row";
import { PullToRefresh } from "@/components/pull-to-refresh";
import { ResponsiveDialog } from "@/components/responsive-dialog";
import { useConfirm } from "@/components/confirm";
import { useDeleteEvents, useEventQuery } from "@/queries/content";
import { useCan } from "@/queries/auth";
import { useIsMobile } from "@/hooks/use-mobile";
import { API_BASE, baseHeaders, errorMessage, rawRequest } from "@/lib/api";
import { formatBytes, formatNumber } from "@/lib/format";
import { isHex64, kindName, parseEventId, parsePubkey, shortNpub } from "@/lib/nostr";

interface ContentSearch { f?: string }
export const Route = createFileRoute("/_app/content")({
  validateSearch: (s: Record<string, unknown>): ContentSearch => ({ f: typeof s.f === "string" && s.f ? s.f : undefined }),
  component: ContentPage,
});

// ---------------------------------------------------------------- filter model
interface Builder {
  kinds: number[];
  authors: string[];
  ids: string[];
  tags: { name: string; values: string[] }[];
  since: string;
  until: string;
  search: string;
}
const EMPTY: Builder = { kinds: [], authors: [], ids: [], tags: [], since: "", until: "", search: "" };

const toLocal = (sec?: number) => {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const fromLocal = (s: string) => (s ? Math.floor(new Date(s).getTime() / 1000) : undefined);

function builderToFilter(b: Builder): Filter {
  const f: Filter = {};
  if (b.ids.length) f.ids = b.ids;
  if (b.authors.length) f.authors = b.authors;
  if (b.kinds.length) f.kinds = b.kinds;
  for (const t of b.tags) if (t.name && t.values.length) f[`#${t.name}`] = t.values;
  const since = fromLocal(b.since);
  const until = fromLocal(b.until);
  if (since) f.since = since;
  if (until) f.until = until;
  if (b.search.trim()) f.search = b.search.trim();
  return f;
}
function filterToBuilder(f: Filter): Builder {
  return {
    kinds: f.kinds ?? [],
    authors: f.authors ?? [],
    ids: f.ids ?? [],
    tags: Object.entries(f)
      .filter(([k, v]) => k.startsWith("#") && Array.isArray(v))
      .map(([k, v]) => ({ name: k.slice(1), values: v as string[] })),
    since: toLocal(f.since),
    until: toLocal(f.until),
    search: f.search ?? "",
  };
}
function parseFilters(raw?: string): Filter[] {
  if (!raw) return [{}];
  try {
    const v = JSON.parse(raw);
    const arr = Array.isArray(v) ? v : [v];
    return arr.filter((x) => x && typeof x === "object") as Filter[];
  } catch {
    return [{}];
  }
}
const isEmptyFilter = (f: Filter) => Object.keys(f).filter((k) => k !== "limit").length === 0;

// ---------------------------------------------------------------- page
function ContentPage() {
  const { f: raw } = Route.useSearch();
  const navigate = useNavigate({ from: "/content" });
  const filters = React.useMemo(() => parseFilters(raw).map(({ limit: _l, ...rest }) => rest as Filter), [raw]);
  const apply = (fs: Filter[]) => navigate({ search: { f: fs.length === 1 && isEmptyFilter(fs[0]) ? undefined : JSON.stringify(fs.length === 1 ? fs[0] : fs) }, replace: false });
  const q = useEventQuery(filters, 50);
  const items = React.useMemo(() => {
    const seen = new Set<string>();
    return (q.data?.pages.flat() ?? []).filter((v) => !seen.has(v.event.id) && seen.add(v.event.id));
  }, [q.data]);
  const can = useCan();
  const mobile = useIsMobile();
  const confirm = useConfirm();
  const del = useDeleteEvents();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  React.useEffect(() => setSelected(new Set()), [raw]);

  const deleteIds = async (ids: string[]) => {
    const r = await confirm({
      title: `Delete ${ids.length} event${ids.length > 1 ? "s" : ""}?`,
      description: "Deleted events are removed from the relay database. This cannot be undone.",
      destructive: true,
      confirmText: "Delete",
      input: { label: "Reason (optional)" },
    });
    if (!r) return false;
    await del.mutateAsync({ ids, reason: r.input || undefined });
    setSelected((s) => {
      const n = new Set(s);
      ids.forEach((i) => n.delete(i));
      return n;
    });
  };
  const deleteByFilter = async () => {
    if (filters.every(isEmptyFilter)) return toast.error("Refusing to delete with an empty filter");
    const r = await confirm({
      title: "Delete ALL events matching this filter?",
      description: <code className="block max-h-40 overflow-auto rounded bg-muted p-2 text-xs">{JSON.stringify(filters, null, 2)}</code>,
      destructive: true,
      confirmText: "Delete matching",
      input: { label: "Type DELETE to confirm", placeholder: "DELETE" },
    });
    if (!r) return;
    if (r.input !== "DELETE") return toast.error("Confirmation text did not match");
    await del.mutateAsync({ filters });
  };
  const exportEvents = async () => {
    const id = toast.loading("Preparing export…");
    try {
      const res = await rawRequest("GET", "/events/export", { query: { filters: JSON.stringify(filters) }, headers: { Accept: "application/x-ndjson" } });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `beamhop-events-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.jsonl`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast.success(`Exported ${formatBytes(blob.size)}`, { id });
    } catch (e) {
      toast.error("Export failed", { id, description: errorMessage(e) });
    }
  };

  const activeCount = filters.reduce((n, f) => n + Object.keys(f).length, 0);
  const builder = <FilterEditor filters={filters} onApply={(fs) => { apply(fs); setFiltersOpen(false); }} />;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Events"
        description="Browse, search and moderate stored events"
        actions={
          <>
            {can("content.import") && (
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <Upload /> <span className="hidden sm:inline">Import</span>
              </Button>
            )}
            {can("content.export") && (
              <Button variant="outline" onClick={exportEvents}>
                <Download /> <span className="hidden sm:inline">Export</span>
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        {!mobile && (
          <Card className="h-fit lg:sticky lg:top-20">
            <CardContent>{builder}</CardContent>
          </Card>
        )}
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {mobile && (
              <Button variant="outline" onClick={() => setFiltersOpen(true)}>
                <SlidersHorizontal /> Filters {activeCount > 0 && <span className="rounded-full bg-primary px-1.5 text-xs text-primary-foreground">{activeCount}</span>}
              </Button>
            )}
            <ActiveFilterChips filters={filters} onClear={() => apply([{}])} />
            <div className="ml-auto flex items-center gap-2">
              {items.length > 0 && can("content.delete") && !mobile && (
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox
                    checked={items.every((v) => selected.has(v.event.id))}
                    onCheckedChange={(v) => setSelected(v === true ? new Set(items.map((i) => i.event.id)) : new Set())}
                  />
                  Select all
                </label>
              )}
              {can("content.delete") && !filters.every(isEmptyFilter) && (
                <Button variant="ghost" size="sm" className="text-destructive" onClick={deleteByFilter}>
                  <Trash2 /> Delete matching
                </Button>
              )}
            </div>
          </div>
          <PullToRefresh onRefresh={() => q.refetch()}>
            {q.isLoading ? (
              <ListSkeleton />
            ) : q.isError ? (
              <ErrorState error={q.error} retry={() => q.refetch()} />
            ) : !items.length ? (
              <EmptyState icon={FileText} title="No events match" description="Adjust the filter to see more results." />
            ) : (
              <div className="space-y-2">
                {items.map((v) => {
                  const card = (
                    <EventCard
                      event={v.event}
                      author={v.author}
                      reports={v.reports}
                      selected={selected.has(v.event.id)}
                      onSelect={can("content.delete") ? (on) => setSelected((s) => { const n = new Set(s); if (on) n.add(v.event.id); else n.delete(v.event.id); return n; }) : undefined}
                      onDelete={can("content.delete") ? () => deleteIds([v.event.id]) : undefined}
                    />
                  );
                  return mobile && can("content.delete") ? (
                    <SwipeRow key={v.event.id} left={{ label: "Delete", icon: Trash2, className: "bg-red-600 text-white", onTrigger: () => deleteIds([v.event.id]) }}>
                      {card}
                    </SwipeRow>
                  ) : (
                    <React.Fragment key={v.event.id}>{card}</React.Fragment>
                  );
                })}
              </div>
            )}
            <InfiniteSentinel hasMore={!!q.hasNextPage} loading={q.isFetchingNextPage} onVisible={() => q.fetchNextPage()} />
          </PullToRefresh>
        </div>
      </div>

      <ResponsiveDialog open={mobile && filtersOpen} onOpenChange={setFiltersOpen} title="Filter events">
        <div className="pb-6">{builder}</div>
      </ResponsiveDialog>
      <SelectionBar count={selected.size} onClear={() => setSelected(new Set())}>
        <Button size="sm" variant="ghost" className="rounded-full text-destructive" onClick={() => deleteIds([...selected])}>
          <Trash2 /> Delete
        </Button>
      </SelectionBar>
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}

function ActiveFilterChips({ filters, onClear }: { filters: Filter[]; onClear: () => void }) {
  if (filters.every(isEmptyFilter)) return <span className="text-sm text-muted-foreground">All events, newest first</span>;
  const chips: string[] = [];
  for (const f of filters) {
    if (f.ids) chips.push(`${f.ids.length} id(s)`);
    if (f.authors) chips.push(f.authors.length === 1 ? `by ${shortNpub(f.authors[0], 4)}` : `${f.authors.length} authors`);
    if (f.kinds) chips.push(f.kinds.map(kindName).join(", "));
    for (const [k, v] of Object.entries(f)) if (k.startsWith("#") && Array.isArray(v)) chips.push(`${k}: ${v.length > 1 ? `${v.length} values` : v[0]}`);
    if (f.since) chips.push(`since ${new Date(f.since * 1000).toLocaleDateString()}`);
    if (f.until) chips.push(`until ${new Date(f.until * 1000).toLocaleDateString()}`);
    if (f.search) chips.push(`“${f.search}”`);
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((c, i) => (
        <span key={i} className="max-w-48 truncate rounded-full bg-secondary px-2.5 py-1 text-xs">
          {c}
        </span>
      ))}
      <Button variant="ghost" size="sm" onClick={onClear}>
        <X /> Clear
      </Button>
    </div>
  );
}

function FilterEditor({ filters, onApply }: { filters: Filter[]; onApply: (f: Filter[]) => void }) {
  const [mode, setMode] = React.useState<"builder" | "json">(filters.length > 1 ? "json" : "builder");
  const [b, setB] = React.useState<Builder>(() => filterToBuilder(filters[0] ?? {}));
  const [json, setJson] = React.useState(() => JSON.stringify(filters.length === 1 ? filters[0] : filters, null, 2));
  const [jsonErr, setJsonErr] = React.useState<string>();
  React.useEffect(() => {
    setB(filterToBuilder(filters[0] ?? {}));
    setJson(JSON.stringify(filters.length === 1 ? filters[0] : filters, null, 2));
  }, [filters]);
  const set = <K extends keyof Builder>(k: K, v: Builder[K]) => setB((s) => ({ ...s, [k]: v }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === "builder") return onApply([builderToFilter(b)]);
    try {
      const v = JSON.parse(json || "{}");
      const arr = (Array.isArray(v) ? v : [v]) as Filter[];
      if (!arr.every((x) => x && typeof x === "object" && !Array.isArray(x))) throw new Error("Expected a filter object or an array of filters");
      setJsonErr(undefined);
      onApply(arr);
    } catch (err) {
      setJsonErr(errorMessage(err));
    }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <Tabs
        value={mode}
        onValueChange={(v) => {
          if (v === "json") setJson(JSON.stringify(builderToFilter(b), null, 2));
          else {
            try {
              const p = JSON.parse(json);
              setB(filterToBuilder(Array.isArray(p) ? (p[0] ?? {}) : p));
            } catch {
              /* keep builder */
            }
          }
          setMode(v as typeof mode);
        }}
      >
        <TabsList className="w-full">
          <TabsTrigger value="builder">
            <FilterIcon /> Builder
          </TabsTrigger>
          <TabsTrigger value="json">
            <Braces /> Raw JSON
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {mode === "builder" ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="f-search">Full-text search</Label>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="f-search" className="pl-9" value={b.search} onChange={(e) => set("search", e.target.value)} placeholder="NIP-50 search" />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Kinds</Label>
            <ListInput numeric value={b.kinds} onChange={(v) => set("kinds", v)} placeholder="1, 7, 30023…" format={(k) => `${kindName(k)} (${k})`} />
            <div className="flex flex-wrap gap-1">
              {[0, 1, 6, 7, 1984, 9735, 30023].filter((k) => !b.kinds.includes(k)).map((k) => (
                <button type="button" key={k} className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted" onClick={() => set("kinds", [...b.kinds, k])}>
                  + {kindName(k)}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label>Authors</Label>
            <ListInput
              value={b.authors}
              onChange={(v) => set("authors", v.map((a) => parsePubkey(a) ?? a))}
              placeholder="npub or hex"
              validate={(s) => (parsePubkey(s) ? undefined : "Invalid pubkey")}
              format={(a) => shortNpub(a, 4)}
            />
          </div>
          <div className="space-y-2">
            <Label>Event IDs</Label>
            <ListInput
              value={b.ids}
              onChange={(v) => set("ids", v.map((a) => parseEventId(a) ?? a))}
              placeholder="note1… or hex"
              validate={(s) => (parseEventId(s) || isHex64(s) ? undefined : "Invalid event id")}
              format={(a) => `${a.slice(0, 8)}…`}
            />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Tags</Label>
              <Button type="button" variant="ghost" size="sm" onClick={() => set("tags", [...b.tags, { name: "t", values: [] }])}>
                <Plus /> Add tag
              </Button>
            </div>
            {b.tags.map((t, i) => (
              <div key={i} className="flex items-start gap-2">
                <Input
                  className="w-14 text-center font-mono"
                  value={t.name}
                  maxLength={1}
                  aria-label="Tag name"
                  onChange={(e) => set("tags", b.tags.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                <ListInput className="flex-1" value={t.values} onChange={(v) => set("tags", b.tags.map((x, j) => (j === i ? { ...x, values: v } : x)))} placeholder="values" />
                <Button type="button" variant="ghost" size="icon" onClick={() => set("tags", b.tags.filter((_, j) => j !== i))} aria-label="Remove tag">
                  <X />
                </Button>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-2">
              <Label htmlFor="f-since">Since</Label>
              <Input id="f-since" type="datetime-local" value={b.since} onChange={(e) => set("since", e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="f-until">Until</Label>
              <Input id="f-until" type="datetime-local" value={b.until} onChange={(e) => set("until", e.target.value)} />
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <Textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={12}
            spellCheck={false}
            className="font-mono text-xs"
            aria-invalid={!!jsonErr}
            placeholder={'{"kinds":[1],"#t":["nostr"]}'}
          />
          {jsonErr ? <p className="text-xs text-destructive">{jsonErr}</p> : <p className="text-xs text-muted-foreground">A NIP-01 filter object or an array of filters.</p>}
        </div>
      )}
      <div className="flex gap-2">
        <Button type="button" variant="outline" onClick={() => { setB(EMPTY); setJson("{}"); onApply([{}]); }}>
          <RotateCcw /> Reset
        </Button>
        <Button type="submit" className="flex-1">
          Apply filter
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- import
function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const qc = useQueryClient();
  const [file, setFile] = React.useState<File | null>(null);
  const [bypass, setBypass] = React.useState(false);
  const [progress, setProgress] = React.useState<number | null>(null);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const [err, setErr] = React.useState<string>();
  const xhrRef = React.useRef<XMLHttpRequest | null>(null);

  const reset = () => {
    setFile(null);
    setProgress(null);
    setResult(null);
    setErr(undefined);
  };
  const close = (o: boolean) => {
    if (!o && xhrRef.current) xhrRef.current.abort();
    onOpenChange(o);
    if (!o) setTimeout(reset, 300);
  };
  const start = () => {
    if (!file) return;
    setErr(undefined);
    setProgress(0);
    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", `${API_BASE}/events/import${bypass ? "?bypassPolicies=true" : ""}`);
    xhr.withCredentials = true;
    for (const [k, v] of Object.entries(baseHeaders)) xhr.setRequestHeader(k, v);
    xhr.setRequestHeader("Content-Type", "application/x-ndjson");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(Math.round((e.loaded / e.total) * 100));
    xhr.upload.onload = () => setProgress(100);
    xhr.onload = () => {
      xhrRef.current = null;
      let body: unknown;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300 && body) {
        setResult(body as ImportResult);
        qc.invalidateQueries({ queryKey: ["events"] });
      } else {
        setErr((body as { error?: string })?.error ?? `Import failed (HTTP ${xhr.status})`);
        setProgress(null);
      }
    };
    xhr.onerror = () => {
      xhrRef.current = null;
      setErr("Network error during upload");
      setProgress(null);
    };
    xhr.send(file);
  };
  const uploading = progress !== null && !result;

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={close}
      title="Import events"
      description="Upload a JSONL file with one signed Nostr event per line."
      footer={
        result ? (
          <Button onClick={() => close(false)}>Done</Button>
        ) : (
          <Button onClick={start} disabled={!file || uploading}>
            <Upload /> {uploading ? (progress! < 100 ? `Uploading ${progress}%` : "Processing…") : "Start import"}
          </Button>
        )
      }
    >
      <div className="space-y-4 pb-2">
        {!result && (
          <>
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-6 text-center transition-colors hover:bg-muted/50">
              <Upload className="size-6 text-muted-foreground" />
              {file ? (
                <span className="text-sm font-medium">
                  {file.name} <span className="text-muted-foreground">({formatBytes(file.size)})</span>
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">Choose a .jsonl / .ndjson file</span>
              )}
              <input type="file" accept=".jsonl,.ndjson,.json,application/x-ndjson,application/json,text/plain" className="sr-only" disabled={uploading} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <span>
                <span className="block text-sm font-medium">Bypass write policies</span>
                <span className="block text-xs text-muted-foreground">Skip access/moderation checks (signatures are still verified)</span>
              </span>
              <Switch checked={bypass} onCheckedChange={setBypass} disabled={uploading} />
            </label>
            {progress !== null && <Progress value={progress} />}
            {err && <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">{err}</p>}
          </>
        )}
        {result && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <ResultStat label="Imported" value={result.imported} className="text-emerald-600 dark:text-emerald-400" />
              <ResultStat label="Duplicates" value={result.duplicates} />
              <ResultStat label="Rejected" value={result.rejected} className={result.rejected ? "text-destructive" : undefined} />
            </div>
            {result.errors.length > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium">Errors ({result.errors.length})</p>
                <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{result.errors.slice(0, 200).join("\n")}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    </ResponsiveDialog>
  );
}

function ResultStat({ label, value, className }: { label: string; value: number; className?: string }) {
  return (
    <div className="rounded-lg bg-muted/50 p-3">
      <div className={`text-2xl font-semibold tabular-nums ${className ?? ""}`}>{formatNumber(value)}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
