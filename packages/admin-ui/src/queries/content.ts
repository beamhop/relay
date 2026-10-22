import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  BlobStatus, BulkResult, EventDeleteRequest, EventQueryRequest, EventQueryResponse, EventView, Filter, MediaItem, MediaStats,
  Paged, ReportStatus, ReportView, ResolveReportRequest,
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
    getNextPageParam: (last) => {
      if (last.length < limit) return undefined;
      const oldest = Math.min(...last.map((v) => v.event.created_at));
      return oldest - 1 > 0 ? oldest - 1 : undefined;
    },
    placeholderData: keepPreviousData,
  });
}

export const useEvent = (id: string | undefined) =>
  useQuery({ queryKey: ["event", id], queryFn: () => api.get<EventView>(`/events/${enc(id!)}`), enabled: !!id });

export function useDeleteEvents() {
  return useApiMutation({
    fn: (body: EventDeleteRequest) =>
      body.ids?.length === 1 && !body.filters
        ? api.del<{ deleted?: number }>(`/events/${enc(body.ids[0])}`, body.reason ? { reason: body.reason } : undefined)
        : api.post<{ deleted?: number }>("/events/delete", body),
    invalidate: [["events"], ["user-events"], ["reports"]],
    success: (r, v) => `Deleted ${r?.deleted ?? v.ids?.length ?? ""} event(s)`.replace("  ", " "),
  });
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
    fn: (body: ResolveReportRequest & { ids: string[] }) => api.post<BulkResult>("/reports/bulk-resolve", body),
    invalidate: [["reports"], ["events"], ["users"]],
    success: (r, v) => `${r?.ok ?? v.ids.length} report(s) resolved`,
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
    fn: (body: { sha256s: string[]; action: "approve" | "block" | "delete" }) => api.post<BulkResult>("/media/bulk", body),
    invalidate: keys,
    success: (r, v) => `${r?.ok ?? v.sha256s.length} blob(s) updated`,
  });
  return { setStatus, remove, bulk };
}
