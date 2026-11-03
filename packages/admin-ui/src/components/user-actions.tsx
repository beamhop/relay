import { toast } from "sonner";
import { DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/components/confirm";
import { tryMutate } from "@/queries/client";
import { useUserActions } from "@/queries/users";
import { usePluginRegistry } from "@/plugins/registry";
import { useCan } from "@/queries/auth";
import { displayName } from "@/lib/nostr";
import type { Profile } from "@beamhop/sdk/admin-contract";

/** Ban/unban/delete flows with confirmation dialogs shared by the users list and detail pages. */
export function useBanFlow() {
  const confirm = useConfirm();
  const actions = useUserActions();
  const ban = async (pubkey: string, profile?: Profile) => {
    const r = await confirm({
      title: `Ban ${displayName(pubkey, profile)}?`,
      description: "Banned users can no longer publish to the relay or upload media.",
      destructive: true,
      confirmText: "Ban user",
      input: { label: "Reason (optional)", placeholder: "spam, abuse…" },
      options: [
        { key: "disconnect", label: "Disconnect active sessions", default: true },
        { key: "deleteEvents", label: "Delete all their events" },
        { key: "deleteMedia", label: "Delete their uploaded media" },
      ],
    });
    if (!r) return false;
    const ok = await tryMutate(actions.ban, {
      pubkey,
      reason: r.input || undefined,
      disconnect: r.options.disconnect,
      deleteEvents: r.options.deleteEvents,
      deleteMedia: r.options.deleteMedia,
    });
    return !!ok;
  };
  const remove = async (pubkey: string, profile?: Profile) => {
    const r = await confirm({
      title: `Delete ${displayName(pubkey, profile)}?`,
      description: "Removes the user along with all their events and uploaded media. This can't be undone. They are not banned and can connect again.",
      destructive: true,
      confirmText: "Delete user",
    });
    if (!r) return false;
    return !!(await tryMutate(actions.remove, pubkey));
  };
  return { ...actions, banWithConfirm: ban, deleteWithConfirm: remove, confirm };
}

/** Plugin-provided user actions, rendered inside a DropdownMenuContent. */
export function PluginUserActionItems({ pubkey }: { pubkey: string }) {
  const { userActions } = usePluginRegistry();
  const can = useCan();
  // plugin actions call the plugin's admin routes, which need plugins.use
  if (!userActions.length || !can("plugins.use")) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs text-muted-foreground">Plugins</DropdownMenuLabel>
      {userActions.map((a) => (
        <DropdownMenuItem
          key={`${a.plugin}:${a.id}`}
          variant={a.destructive ? "destructive" : "default"}
          onSelect={async () => {
            try {
              await a.run(pubkey);
            } catch (e) {
              toast.error(`${a.label} failed`, { description: (e as Error).message });
            }
          }}
        >
          {a.label}
        </DropdownMenuItem>
      ))}
    </>
  );
}
