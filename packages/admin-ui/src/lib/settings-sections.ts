import { Archive, AtSign, Gauge, HardDrive, Info, KeyRound, ShieldAlert, UsersRound, type LucideIcon } from "lucide-react";
import type { RuntimeSettings } from "@beamhop/sdk/admin-contract";

export type SectionKey = keyof RuntimeSettings;
export const SETTINGS_SECTIONS: { key: SectionKey; label: string; icon: LucideIcon; description: string }[] = [
  { key: "info", label: "Relay info", icon: Info, description: "Public NIP-11 information document" },
  { key: "access", label: "Access", icon: KeyRound, description: "Who can read from and write to the relay" },
  { key: "limits", label: "Limits", icon: Gauge, description: "Message sizes, subscription limits and rate limits" },
  { key: "moderation", label: "Moderation", icon: ShieldAlert, description: "Kind filters, word filters and automatic actions" },
  { key: "retention", label: "Retention", icon: Archive, description: "Automatically prune old events" },
  { key: "nip05", label: "NIP-05", icon: AtSign, description: "name@domain identifiers served by this relay" },
  { key: "groups", label: "Groups", icon: UsersRound, description: "NIP-29 relay-based groups" },
  { key: "blossom", label: "Blossom", icon: HardDrive, description: "Media uploads and storage" },
];
