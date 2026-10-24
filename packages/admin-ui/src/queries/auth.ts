import { queryOptions, useQuery } from "@tanstack/react-query";
import type { Me, SystemInfo } from "@beamhop/sdk/admin-contract";
import type { Permission } from "@beamhop/sdk/admin-contract";
import { api } from "@/lib/api";

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: () => api.get<Me>("/auth/me"),
  staleTime: 60_000,
  retry: false,
});

export const useMe = () => useQuery(meQuery);

/** Permission checker for the current admin. */
export function useCan() {
  const { data } = useMe();
  return (p: Permission | undefined) => !p || !!data?.permissions.includes(p);
}

const systemQuery = queryOptions({
  queryKey: ["system"],
  queryFn: () => api.get<SystemInfo>("/system"),
  staleTime: 5 * 60_000,
});
export const useSystem = () => useQuery(systemQuery);
