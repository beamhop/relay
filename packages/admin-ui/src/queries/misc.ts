import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  AuditView, GroupView, InviteView, IpRuleInput, IpRule, PluginView, SettingsPatch, SettingsResponse,
} from "@beamhop/sdk/admin-contract";
import { api, enc } from "@/lib/api";
import { useApiMutation } from "./client";

// invites
export const useInvites = () =>
  useQuery({ queryKey: ["invites"], queryFn: () => api.get<{ items: InviteView[] }>("/invites").then((r) => r.items ?? []) });
export function useInviteActions() {
  const create = useApiMutation({
    fn: (body: { maxUses?: number; expiresAt?: number | null; note?: string; count?: number }) => api.post<{ items: InviteView[] }>("/invites", body),
    invalidate: [["invites"]],
    success: (r) => `${r?.items?.length ?? 1} invite(s) created`,
  });
  const revoke = useApiMutation({ fn: (code: string) => api.del(`/invites/${enc(code)}`), invalidate: [["invites"]], success: "Invite revoked" });
  return { create, revoke };
}

// ip rules
export const useIpRules = () =>
  useQuery({ queryKey: ["ip-rules"], queryFn: () => api.get<{ items: IpRule[] }>("/ip-rules").then((r) => r.items ?? []) });
export function useIpRuleActions() {
  const add = useApiMutation({ fn: (body: IpRuleInput) => api.post("/ip-rules", body), invalidate: [["ip-rules"]], success: "Rule added" });
  const remove = useApiMutation({ fn: (cidr: string) => api.del(`/ip-rules/${enc(cidr)}`), invalidate: [["ip-rules"]], success: "Rule removed" });
  return { add, remove };
}

// groups
export const useGroups = () =>
  useQuery({ queryKey: ["groups"], queryFn: () => api.get<{ items: GroupView[] }>("/groups").then((r) => r.items ?? []) });
export type GroupDetail = GroupView & { memberList?: { pubkey: string; roles: string[] }[] };
export const useGroup = (id: string) => useQuery({ queryKey: ["group", id], queryFn: () => api.get<GroupDetail>(`/groups/${enc(id)}`) });
export const useDeleteGroup = () =>
  useApiMutation({ fn: (id: string) => api.del(`/groups/${enc(id)}`), invalidate: [["groups"]], success: "Group deleted" });

// settings
export const useSettings = () => useQuery({ queryKey: ["settings"], queryFn: () => api.get<SettingsResponse>("/settings") });
export const useSaveSettings = () =>
  useApiMutation({
    fn: (patch: SettingsPatch) => api.patch<SettingsResponse>("/settings", patch),
    invalidate: [["settings"]],
    success: "Settings saved",
    error: "Could not save settings",
  });

// plugins
export const usePlugins = (enabled = true) =>
  useQuery({ queryKey: ["plugins"], queryFn: () => api.get<{ items: PluginView[] }>("/plugins").then((r) => r.items ?? []), enabled });
export const usePluginToggle = () =>
  useApiMutation({
    fn: ({ name, enabled }: { name: string; enabled: boolean }) => api.post(`/plugins/${enc(name)}/${enabled ? "enable" : "disable"}`),
    invalidate: [["plugins"]],
    success: (_d, v) => `${v.name} ${v.enabled ? "enabled" : "disabled"}`,
  });
export const usePluginSettings = (name: string) =>
  useQuery({
    queryKey: ["plugin-settings", name],
    queryFn: () => api.get<{ values: Record<string, unknown>; schema?: Record<string, unknown> }>(`/plugins/${enc(name)}/settings`),
  });
export const useSavePluginSettings = (name: string) =>
  useApiMutation({
    fn: (values: Record<string, unknown>) => api.patch(`/plugins/${enc(name)}/settings`, { values }),
    invalidate: [["plugin-settings", name], ["plugins"]],
    success: "Plugin settings saved",
  });

// audit
export interface AuditQuery { actor?: string; action?: string; target?: string }
export function useAudit(q: AuditQuery) {
  const limit = 50;
  return useInfiniteQuery({
    queryKey: ["audit", q],
    queryFn: ({ pageParam }) => api.get<{ items: AuditView[] }>("/audit", { ...q, before: pageParam || undefined, limit }).then((r) => r.items ?? []),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.length < limit ? undefined : last[last.length - 1].at),
  });
}
