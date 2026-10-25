import { QueryClient, useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import { HttpError, errorMessage } from "@/lib/api";

/**
 * Options for the paged list queries (users, media, reports, events, audit). Every loaded page is refetched in turn on
 * a refetch, so cap how many are kept and don't refetch them all on every window focus; mutations and the live
 * stream invalidate them when something changed.
 */
export const LIST_QUERY_OPTIONS = { maxPages: 20, refetchOnWindowFocus: false } as const;

/**
 * `getNextPageParam` for offset-paged lists. Counts from the last page's own offset, not the pages still held:
 * with `maxPages` the oldest pages are dropped and their length no longer adds up to the next offset.
 */
export function nextOffset(last: { items: unknown[]; total: number }, _pages: unknown, lastOffset: number) {
  const next = lastOffset + last.items.length;
  return last.items.length > 0 && next < last.total ? next : undefined;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, err) => !(err instanceof HttpError && err.status >= 400 && err.status < 500) && count < 2,
    },
    mutations: { retry: false },
  },
});

export interface ApiMutationOptions<TVars, TData> {
  fn: (vars: TVars) => Promise<TData>;
  /** query keys to invalidate on success */
  invalidate?: QueryKey[];
  success?: string | ((data: TData, vars: TVars) => string | undefined);
  error?: string;
  onSuccess?: (data: TData, vars: TVars) => void;
  /** optimistic update; return rollback */
  optimistic?: (vars: TVars) => (() => void) | void;
}

/** Mutation with toasts, invalidation and optional optimistic update. */
export function useApiMutation<TVars = void, TData = unknown>(o: ApiMutationOptions<TVars, TData>) {
  const qc = useQueryClient();
  return useMutation<TData, Error, TVars, { rollback?: () => void }>({
    mutationFn: o.fn,
    onMutate: async (vars) => {
      if (!o.optimistic) return {};
      await Promise.all((o.invalidate ?? []).map((k) => qc.cancelQueries({ queryKey: k })));
      return { rollback: o.optimistic(vars) ?? undefined };
    },
    onSuccess: (data, vars) => {
      const msg = typeof o.success === "function" ? o.success(data, vars) : o.success;
      if (msg) toast.success(msg);
      // a failed mutation changed nothing (an optimistic update is rolled back): only success refetches
      for (const k of o.invalidate ?? []) qc.invalidateQueries({ queryKey: k });
      o.onSuccess?.(data, vars);
    },
    onError: (err, _vars, ctx) => {
      ctx?.rollback?.();
      toast.error(o.error ?? "Action failed", { description: errorMessage(err) });
    },
  });
}

/**
 * Retry after a page crashed while rendering: refetch the queries something on screen still uses, and drop the
 * unused ones (the crashed page's queries among them, so it remounts into a fresh fetch, not the response it crashed
 * on) instead of refetching the whole cache.
 */
export function refreshAfterCrash(qc: QueryClient) {
  qc.removeQueries({ type: "inactive" });
  return qc.refetchQueries({ type: "active" }).catch(() => {});
}

/**
 * `mutateAsync` for event handlers: useApiMutation already toasts failures, so swallow the rejection (no unhandled
 * promise) and return undefined instead.
 */
export async function tryMutate<TVars, TData>(m: { mutateAsync: (v: TVars) => Promise<TData> }, vars: TVars): Promise<{ data: TData } | undefined> {
  try {
    return { data: await m.mutateAsync(vars) };
  } catch {
    return undefined;
  }
}
