import * as React from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ConnectionView, DashboardSnapshot, GeoResponse, Profile, SeriesResponse } from "@beamhop/sdk/admin-contract";
import { api } from "@/lib/api";
import { nowSec } from "@/lib/format";
import { useLiveSnapshot, useLiveStatus } from "@/lib/live";

export type RangeKey = "1h" | "24h" | "7d" | "30d";
export const RANGES: Record<RangeKey, { seconds: number; step: number; label: string }> = {
  "1h": { seconds: 3600, step: 60, label: "1 hour" },
  "24h": { seconds: 86400, step: 900, label: "24 hours" },
  "7d": { seconds: 7 * 86400, step: 3600, label: "7 days" },
  "30d": { seconds: 30 * 86400, step: 6 * 3600, label: "30 days" },
};

/**
 * The window ending now, aligned to its step (so buckets line up). Computed when a query runs, not in render: the key
 * is just the range, and each refetch (interval, focus, invalidation) moves the window forward.
 */
function rangeParams(r: RangeKey) {
  const { seconds, step } = RANGES[r];
  const to = Math.ceil(nowSec() / step) * step;
  return { from: to - seconds, to, step };
}

/**
 * Current relay snapshot: the live stream's while it is open, else the polled one. The last snapshot a dropped stream
 * delivered is never shown in place of fresh data, and the API is only polled while the stream isn't delivering.
 */
export function useSnapshot() {
  const open = useLiveStatus() === "open";
  const liveSnap = useLiveSnapshot();
  const q = useQuery({
    queryKey: ["snapshot"],
    queryFn: () => api.get<DashboardSnapshot>("/dashboard/snapshot"),
    refetchInterval: open ? false : 30_000,
  });
  // the cached value is the stream's last snapshot when it just dropped: replace it now, not a poll interval later
  const wasOpen = React.useRef(open);
  const { refetch } = q;
  React.useEffect(() => {
    if (wasOpen.current && !open) refetch();
    wasOpen.current = open;
  }, [open, refetch]);
  return { data: open && liveSnap ? liveSnap : q.data, live: open };
}

export function useSeries(names: string[], range: RangeKey) {
  return useQuery({
    queryKey: ["series", names, range],
    queryFn: async () => {
      const p = rangeParams(range);
      // unknown series names come back as empty points, so any rejection here is a real error and must surface
      const res = await Promise.all(names.map((name) => api.get<SeriesResponse>("/metrics/series", { name, ...p })));
      const byT = new Map<number, Record<string, number>>();
      for (const s of res) for (const pt of s.points ?? []) {
        const row = byT.get(pt.t) ?? { t: pt.t };
        row[s.name] = pt.v;
        byT.set(pt.t, row);
      }
      return [...byT.values()].sort((a, b) => a.t - b.t);
    },
    placeholderData: keepPreviousData,
    refetchInterval: range === "1h" ? 60_000 : 5 * 60_000,
  });
}

function metricList<T>(path: string, range: RangeKey, extra?: Record<string, number>) {
  return {
    queryKey: ["metrics", path, range, extra],
    queryFn: () => api.get<{ items: T[] }>(path, { ...rangeParams(range), ...extra }).then((r) => r.items ?? []),
    placeholderData: keepPreviousData,
    refetchInterval: 120_000,
  };
}

export const useKindStats = (range: RangeKey) => useQuery(metricList<{ kind: number; count: number }>("/metrics/kinds", range));
export const useTopPubkeys = (range: RangeKey, limit = 10) =>
  useQuery(metricList<{ pubkey: string; events: number; rejected: number; profile?: Profile }>("/metrics/top-pubkeys", range, { limit }));
export const useRejections = (range: RangeKey) => useQuery(metricList<{ code: string; reason: string; count: number }>("/metrics/rejections", range));
export const useGeo = (range: RangeKey) => useQuery(metricList<GeoResponse["items"][number]>("/metrics/geo", range));

export const useConnections = (enabled = true) =>
  useQuery({
    queryKey: ["connections"],
    queryFn: () => api.get<{ items: ConnectionView[] }>("/connections").then((r) => r.items ?? []),
    refetchInterval: 5_000,
    enabled,
  });
