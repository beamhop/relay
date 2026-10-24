import * as React from "react";
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  BlobStatus, EventDeleteRequest, EventQueryRequest, EventQueryResponse, Filter, MediaBulkResult, MediaItem, MediaStats,
  Paged, ReportBulkResult, ReportStatus, ReportView, ResolveReportRequest,
} from "@beamhop/sdk/admin-contract";
import { api, enc } from "@/lib/api";
import { useApiMutation } from "./client";

// ------------------------------------------------------------- events
export function useEventQuery(filters: Filter[], limit = 50, enabled = true) {
  return useInfiniteQuery({
    queryKey: ["events", filters, limit],
    enabled,
    queryFn: ({ pageParam }) => {
      const fs = pageParam ? filters.map((f) => ({ ...f, until: Math.min(f.until ?? Infinity, pageParam) })) : filters;
      const body: EventQueryRequest = { filters: fs.map((f) => ({ ...f, limit: f.limit ?? limit })), limit };
      return api.post<EventQueryResponse>("/events/query", body).then((r) => r.items ?? []);
    },
    initialPageParam: 0 as number,
    // next page starts AT the oldest second (not oldest-1) so events sharing that second aren't skipped;
    // overlap is deduped in `select`. Only step past the second when a page brought nothing new.
    getNextPageParam: (last, pages) => {
      if (last.length < limit) return undefined;
      const oldest = Math.min(...last.map((v) => v.event.created_at));
      const seen = new Set(pages.slice(0, -1).flatMap((p) => p.map((v) => v.event.id)));
      const fresh = last.some((v) => !seen.has(v.event.id));
      const next = fresh ? oldest : oldest - 1;
      return next > 0 ? next : undefined;
    },
    select: (data) => {
      const seen = new Set<string>();
      return { ...data, pages: data.pages.map((p) => p.filter((v) => !seen.has(v.event.id) && (seen.add(v.event.id), true))) };
    },
    placeholderData: keepPreviousData,
  });
}

type DeleteResult = { deleted?: number; truncated?: boolean };

export function useDeleteEvents() {
  // a large filter delete below owner runs in bounded batches; `truncated` means more matches remain
  const again = React.useRef<(v: EventDeleteRequest) => void>(() => {});
  const m = useApiMutation<EventDeleteRequest, DeleteResult>({
    fn: (body) =>
      body.ids?.length === 1 && !body.filters
        ? api.del<DeleteResult>(`/events/${enc(body.ids[0])}`, body.reason ? { reason: body.reason } : undefined)
        : api.post<DeleteResult>("/events/delete", body),
    invalidate: [["events"], ["user-events"], ["reports"]],
    success: (r, v) => (r?.truncated ? undefined : `Deleted ${r?.deleted ?? v.ids?.length ?? ""} event(s)`.replace("  ", " ")),
    onSuccess: (r, v) => {
      if (!r?.truncated) return;
      toast.warning(`Deleted ${r.deleted ?? 0} event(s) — more events still match`, {
        description: "Large deletes run in batches. Run it again to continue.",
        duration: 20_000,
        action: { label: "Delete more", onClick: () => again.current({ ...v, ids: undefined }) },
      });
    },
  });
  again.current = m.mutate;
  return m;
}

// ------------------------------------------------------------- reports
export function useReports(status: ReportStatus, type?: string) {
  return useInfiniteQuery({
    queryKey: ["reports", status, type],
    queryFn: ({ pageParam }) => api.get<Paged<ReportView>>("/reports", { status, type, limit: 30, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total && last.items.length ? loaded : undefined;
    },
  });
}

/** single report, e.g. opened from a push notification (`/reports?id=…`); keyed under "reports" so resolves invalidate it */
export const useReport = (id: string | undefined) =>
  useQuery({ queryKey: ["reports", "one", id], queryFn: () => api.get<ReportView>(`/reports/${enc(id!)}`), enabled: !!id });

export const useOpenReportCount = (enabled: boolean) =>
  useQuery({
    queryKey: ["reports", "open-count"],
    queryFn: () => api.get<Paged<ReportView>>("/reports", { status: "open", limit: 1 }).then((r) => r.total),
    enabled,
    refetchInterval: 60_000,
  });

export function useResolveReports() {
  const one = useApiMutation({
    fn: ({ id, ...body }: ResolveReportRequest & { id: string }) => api.post(`/reports/${enc(id)}/resolve`, body),
    invalidate: [["reports"], ["events"], ["users"]],
    success: (_d, v) => (v.action === "dismiss" ? "Report dismissed" : "Report resolved"),
  });
  const bulk = useApiMutation({
    fn: (body: ResolveReportRequest & { ids: string[] }) => api.post<ReportBulkResult>("/reports/bulk-resolve", body),
    invalidate: [["reports"], ["events"], ["users"]],
    success: (r, v) => `${r?.ok ?? v.ids.length} report(s) resolved${r?.failed?.length ? `, ${r.failed.length} failed` : ""}`,
  });
  return { one, bulk };
}

// ------------------------------------------------------------- media
export interface MediaQuery { pubkey?: string; status?: BlobStatus; type?: string }
export function useMedia(q: MediaQuery) {
  return useInfiniteQuery({
    queryKey: ["media", q],
    queryFn: ({ pageParam }) => api.get<Paged<MediaItem>>("/media", { ...q, limit: 48, offset: pageParam }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total && last.items.length ? loaded : undefined;
    },
    placeholderData: keepPreviousData,
  });
}
export const useMediaStats = () => useQuery({ queryKey: ["media-stats"], queryFn: () => api.get<MediaStats>("/media/stats") });

export function useMediaActions() {
  const keys = [["media"], ["media-stats"]];
  const setStatus = useApiMutation({
    fn: ({ sha256, status }: { sha256: string; status: BlobStatus }) => api.post(`/media/${sha256}/status`, { status }),
    invalidate: keys,
    success: (_d, v) => `Blob ${v.status}`,
  });
  const remove = useApiMutation({
    fn: ({ sha256, block }: { sha256: string; block?: boolean }) => api.del(`/media/${sha256}`, undefined, { block: block ? "true" : undefined }),
    invalidate: keys,
    success: (_d, v) => (v.block ? "Blob deleted and blocked" : "Blob deleted"),
  });
  const bulk = useApiMutation({
    fn: (body: { sha256s: string[]; action: "approve" | "block" | "delete" }) => api.post<MediaBulkResult>("/media/bulk", body),
    invalidate: keys,
    success: (r, v) => `${r?.ok ?? v.sha256s.length} blob(s) updated${r?.failed?.length ? `, ${r.failed.length} failed` : ""}`,
  });
  return { setStatus, remove, bulk };
}

export interface BlockedBlob { sha256: string; reason: string; createdAt: number }
export const useMediaBlocklist = (enabled: boolean) =>
  useQuery({ queryKey: ["media-blocklist"], queryFn: () => api.get<{ items: BlockedBlob[] }>("/media/blocklist").then((r) => r.items ?? []), enabled });

export const useUnblockHash = () =>
  useApiMutation({
    fn: (sha256: string) => api.del(`/media/blocklist/${enc(sha256)}`),
    invalidate: [["media-blocklist"]],
    success: "Hash unblocked — it can be uploaded again",
  });
