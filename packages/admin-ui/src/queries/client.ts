import { QueryClient, useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { toast } from "sonner";
import { HttpError, errorMessage } from "@/lib/api";

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
  /** query keys to invalidate on settle */
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
      o.onSuccess?.(data, vars);
    },
    onError: (err, _vars, ctx) => {
      ctx?.rollback?.();
      toast.error(o.error ?? "Action failed", { description: errorMessage(err) });
    },
    onSettled: () => {
      for (const k of o.invalidate ?? []) qc.invalidateQueries({ queryKey: k });
    },
  });
}
