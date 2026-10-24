import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  AdminRole, BanRequest, BulkResult, BulkUserRequest, DeleteUserResult, NostrEvent, Paged, UserDetail, UserListQuery, UserPatch, UserView,
} from "@beamhop/sdk/admin-contract";
import { api, enc } from "@/lib/api";
import { useApiMutation } from "./client";

const PAGE = 50;

export function useUsers(q: Omit<UserListQuery, "limit" | "offset">) {
  return useInfiniteQuery({
    queryKey: ["users", q],
    queryFn: ({ pageParam, signal }) =>
      api.get<Paged<UserView>>("/users", { ...q, allowed: q.allowed, limit: PAGE, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total && last.items.length > 0 ? loaded : undefined;
    },
    placeholderData: keepPreviousData,
  });
}

export const useUser = (pubkey: string) =>
  useQuery({ queryKey: ["user", pubkey], queryFn: () => api.get<UserDetail>(`/users/${enc(pubkey)}`) });

export const useUserEvents = (pubkey: string, limit = 30) =>
  useQuery({
    queryKey: ["user-events", pubkey, limit],
    queryFn: () => api.get<{ items: NostrEvent[] }>(`/users/${enc(pubkey)}/events`, { limit }).then((r) => r.items ?? []),
  });

export const useAdmins = () =>
  useQuery({ queryKey: ["admins"], queryFn: () => api.get<{ items: UserView[] }>("/admins").then((r) => r.items ?? []) });

const userKeys = (pubkey?: string) => [["users"], ["admins"], ...(pubkey ? [["user", pubkey]] : [])];

export function useUserActions(pubkey?: string) {
  const ban = useApiMutation({
    fn: ({ pubkey: pk, ...body }: BanRequest & { pubkey: string }) => api.post(`/users/${enc(pk)}/ban`, body),
    invalidate: userKeys(pubkey),
    success: "User banned",
  });
  const remove = useApiMutation({
    fn: (pk: string) => api.del<DeleteUserResult>(`/users/${enc(pk)}`),
    invalidate: userKeys(),
    success: "User deleted",
  });
  const simple = (action: "unban" | "mute" | "unmute", label: string) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useApiMutation({ fn: (pk: string) => api.post(`/users/${enc(pk)}/${action}`), invalidate: userKeys(pubkey), success: label });
  const unban = simple("unban", "User unbanned");
  const mute = simple("mute", "User muted");
  const unmute = simple("unmute", "User unmuted");
  const patch = useApiMutation({
    fn: ({ pubkey: pk, ...body }: UserPatch & { pubkey: string }) => api.patch<UserView>(`/users/${enc(pk)}`, body),
    invalidate: userKeys(pubkey),
    success: "User updated",
  });
  const setRole = useApiMutation({
    fn: ({ pubkey: pk, role }: { pubkey: string; role: AdminRole | null }) => api.put(`/users/${enc(pk)}/role`, { role }),
    invalidate: userKeys(pubkey),
    success: (_d, v) => (v.role ? `Role set to ${v.role}` : "Admin role removed"),
  });
  const bulk = useApiMutation({
    fn: (body: BulkUserRequest) => api.post<BulkResult>("/users/bulk", body),
    invalidate: userKeys(pubkey),
    success: (r) => `${r?.ok ?? 0} updated${r?.failed?.length ? `, ${r.failed.length} failed` : ""}`,
  });
  const add = useApiMutation({
    fn: (body: { pubkey: string; allowed?: boolean; notes?: string; tags?: string[] }) => api.post<UserView>("/users", body),
    invalidate: userKeys(),
    success: "User added",
  });
  return { ban, unban, mute, unmute, remove, patch, setRole, bulk, add };
}
